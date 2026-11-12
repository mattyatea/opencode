export * as ToolOutput from "./tool-output.js"

import path from "path"
import type { Tool } from "./tool.js"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Identifier } from "@opencode/schema/identifier"
import { FileRetention } from "./file-retention.js"
import { State } from "./state.js"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024 // 50 KiB
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"

export const fileName = (timestamp?: number) => "tool_" + Identifier.create(false, timestamp)

type Result = Tool.NormalizedResult

type Limits = {
  maxLines: number
  maxBytes: number
}

export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly truncate: (result: Result, mode?: "head" | "head-tail") => Effect.Effect<Result>
  /** Writes bytes the model cannot receive inline to a retained file and returns its path. */
  readonly save: (bytes: Uint8Array, extension: string) => Effect.Effect<string>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, DIRECTORY)
    const state = State.create<Limits, Editor>({
      name: "tool-output",
      initial: () => ({ maxLines: MAX_LINES, maxBytes: MAX_BYTES }),
      editor: (editor) => ({
        configure: (limits) => {
          if (limits.maxLines !== undefined) editor.maxLines = limits.maxLines
          if (limits.maxBytes !== undefined) editor.maxBytes = limits.maxBytes
        },
      }),
    })

    const truncate = Effect.fnUntraced(function* (result: Result, mode?: "head" | "head-tail") {
      const content = result.content
      const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
      const limits = state.get()
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      const totalBytes = Buffer.byteLength(text, "utf-8")
      if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes)
        return result.metadata?.truncated !== undefined
          ? result
          : { ...result, metadata: { ...result.metadata, truncated: false } }

      const kept: string[] = []
      let bytes = 0
      for (const line of lines.slice(0, limits.maxLines)) {
        const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
        if (bytes + size > limits.maxBytes) break
        kept.push(line)
        bytes += size
      }
      const previous = result.metadata?.outputPath
      const retained = typeof previous === "string" && (yield* fs.exists(previous).pipe(Effect.orDie))
      const file = retained ? previous : path.join(directory, fileName())
      if (!retained) {
        yield* fs.ensureDir(directory).pipe(Effect.orDie)
        yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      }
      if (mode === "head-tail" || (typeof result.metadata?.exit === "number" && result.metadata.exit !== 0)) {
        const head = edge(lines, Math.ceil(limits.maxLines / 2), Math.ceil(limits.maxBytes / 2), false)
        const tail = edge(
          lines,
          Math.floor(limits.maxLines / 2),
          Math.floor(limits.maxBytes / 2),
          true,
          text.endsWith("\n"),
        )
        const marker = `[middle omitted; showing first ${Buffer.byteLength(head)} and last ${Buffer.byteLength(tail)} of ${totalBytes} bytes; full output saved to ${file}]`
        const bounded: Tool.Content[] = []
        let position = 0
        let marked = false
        for (const item of content) {
          if (item.type === "file") {
            bounded.push(item)
            continue
          }
          const end = position + item.text.length
          const first = item.text.slice(0, Math.max(0, head.length - position))
          const last = item.text.slice(Math.max(0, text.length - tail.length - position))
          if (first) bounded.push({ ...item, text: first })
          if (!marked && end > head.length) {
            bounded.push({ type: "text", text: marker })
            marked = true
          }
          if (last) bounded.push({ ...item, text: last })
          position = end + 1
        }
        return { ...result, content: bounded, metadata: { ...result.metadata, truncated: true, outputPath: file } }
      }
      const shown = kept.length > 0 ? `lines 1-${kept.length}` : "0 lines"
      const marker = `[showing ${shown} of ${lines.length}; full output saved to ${file}]`
      const bounded: Tool.Content[] = []
      let remaining = kept.join("\n").length
      let seenText = false
      let marked = false
      for (const item of content) {
        if (item.type === "file") {
          bounded.push(item)
          continue
        }
        if (seenText && remaining > 0) remaining--
        seenText = true
        if (remaining >= item.text.length) {
          bounded.push(item)
          remaining -= item.text.length
          continue
        }
        if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })
        if (!marked) bounded.push({ type: "text", text: marker })
        remaining = 0
        marked = true
      }
      if (!marked) bounded.push({ type: "text", text: marker })
      return {
        ...result,
        content: bounded,
        metadata: { ...result.metadata, truncated: true, outputPath: file },
      }
    })

    const save = Effect.fnUntraced(function* (bytes: Uint8Array, extension: string) {
      const file = path.join(directory, fileName() + extension)
      yield* fs.writeWithDirs(file, bytes).pipe(Effect.orDie)
      return file
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      save,
      cleanup: () => cleanup(fs, directory),
    })
  }),
)

// Slice on UTF-8 boundaries, including a huge single-line error, without splitting a code point.
function edge(lines: ReadonlyArray<string>, maxLines: number, maxBytes: number, tail: boolean, trailing = false) {
  if (maxLines <= 0 || maxBytes <= 0) return ""
  const bytes = Buffer.from(
    (tail ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join("\n") + (tail && trailing ? "\n" : ""),
  )
  if (bytes.length <= maxBytes) return bytes.toString()
  let offset = tail ? bytes.length - maxBytes : maxBytes
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += tail ? 1 : -1
  return (tail ? bytes.subarray(offset) : bytes.subarray(0, offset)).toString()
}

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})
