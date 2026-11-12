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
  readonly truncate: (result: Result) => Effect.Effect<Result>
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

// The system error message ("ENOSPC: no space left on device, write") without the stack or wrapper text.
const describe = (error: FSUtil.Error) => {
  const cause = error._tag === "PlatformError" ? error.reason.cause : error.cause
  return cause instanceof Error ? cause.message.split("\n")[0] : error.message
}

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

    const truncate = Effect.fnUntraced(function* (result: Result) {
      const content = result.content
      // A line break joins text parts unless the text before already ends in one.
      const text = content.reduce(
        (joined, item) =>
          item.type !== "text"
            ? joined
            : joined === "" || joined.endsWith("\n")
              ? joined + item.text
              : `${joined}\n${item.text}`,
        "",
      )
      const limits = state.get()
      const totalLines = countLines(text)
      if (totalLines <= limits.maxLines && Buffer.byteLength(text, "utf-8") <= limits.maxBytes)
        return result.metadata?.truncated !== undefined
          ? result
          : { ...result, metadata: { ...result.metadata, truncated: false } }

      // Keep both ends: failures in test and build logs usually come last, and the shell tool's own tail view ends
      // with its truncation notice and exit status. The tail takes whole last lines within half the budget; the head
      // gets the rest and is cut once, at the line or byte limit, so a line too long for the space left shows its start.
      const tail = lastLines(text, Math.floor(limits.maxLines / 2), limits.maxBytes / 2)
      const end = Math.min(
        afterLines(text, limits.maxLines - tail.lines),
        // The line break joining the two ends counts too.
        byteBoundary(text, limits.maxBytes - tail.bytes - (tail.lines > 0 ? 1 : 0)),
        tail.start,
      )
      // The preview never ends on a line break.
      const head = text.slice(0, text.endsWith("\r\n", end) ? end - 2 : text.endsWith("\n", end) ? end - 1 : end)
      // Counted before the final line break is stripped, so a blank last line still counts.
      const headLines = countLines(text.slice(0, end))
      const omitted = tail.lines > 0 ? tail.start - end : text.length - head.length
      const lastLineCut =
        headLines > 0 && omitted > 0 && !text.startsWith("\n", head.length) && !text.startsWith("\r\n", head.length)
      const previous = result.metadata?.outputPath
      const retained = typeof previous === "string" && (yield* fs.exists(previous).pipe(Effect.orDie))
      const file = retained ? previous : path.join(directory, fileName())
      const failure = retained
        ? undefined
        : yield* fs.ensureDir(directory).pipe(
            Effect.andThen(fs.writeFileString(file, text)),
            Effect.as(undefined),
            Effect.catch((error) =>
              Effect.logWarning("failed to save full tool output", { file, cause: error }).pipe(
                Effect.as(describe(error)),
              ),
            ),
          )
      const ranges = [
        ...(headLines > 0 ? [`1-${headLines}`] : []),
        ...(tail.lines > 0 ? [`${totalLines - tail.lines + 1}-${totalLines}`] : []),
      ]
      const cut = !lastLineCut ? "" : tail.lines > 0 ? ` (line ${headLines} cut)` : " (last line cut)"
      const marker = `[showing ${ranges.length > 0 ? `lines ${ranges.join(" and ")}` : "0 lines"} of ${totalLines}${cut}; ${
        failure === undefined ? `full output saved to ${file}` : `full output could not be saved: ${failure}`
      }]`
      const tailStart = tail.lines > 0 ? tail.start : Infinity
      const bounded: Tool.Content[] = []
      // Offset of each text item in `text`, which joins them with a line break unless the text before ends in one.
      let start = 0
      let separator = false
      let marked = false
      for (const item of content) {
        if (item.type === "file") {
          bounded.push(item)
          continue
        }
        const offset = start + (separator ? 1 : 0)
        start = offset + item.text.length
        if (item.text !== "") separator = !item.text.endsWith("\n")
        if ((!marked && start <= head.length) || offset >= tailStart) {
          bounded.push(item)
          continue
        }
        if (!marked) {
          const before = item.text.slice(0, Math.max(0, head.length - offset))
          if (before) bounded.push({ ...item, text: before })
          bounded.push({ type: "text", text: marker })
          marked = true
        }
        const after = start > tailStart ? item.text.slice(tailStart - offset) : ""
        if (after) bounded.push({ ...item, text: after })
      }
      if (!marked) bounded.push({ type: "text", text: marker })
      return {
        ...result,
        content: bounded,
        metadata: { ...result.metadata, truncated: true, ...(failure === undefined && { outputPath: file }) },
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

/**
 * The whole last lines of `text` that fit the budget, never its first line: where they start, how many, and their size
 * without the final line break.
 */
function lastLines(text: string, maxLines: number, maxBytes: number) {
  const end = text.endsWith("\r\n") ? text.length - 2 : text.endsWith("\n") ? text.length - 1 : text.length
  let start = text.length
  let lines = 0
  let bytes = 0
  for (let cursor = end; lines < maxLines && cursor > 0; ) {
    const lineStart = text.lastIndexOf("\n", cursor - 1) + 1
    if (lineStart === 0) break
    const size = Buffer.byteLength(text.slice(lineStart, cursor), "utf-8") + (lines > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    start = lineStart
    lines++
    bytes += size
    cursor = lineStart - 1
  }
  return { start, lines, bytes }
}

/** How many lines `text` has, not counting an empty one after a final line break. Counts without splitting. */
function countLines(text: string) {
  if (text === "") return 0
  let count = 1
  for (let index = text.indexOf("\n"); index !== -1 && index < text.length - 1; index = text.indexOf("\n", index + 1))
    count++
  return count
}

/** Where the line after the first `count` lines starts, or the end of `text`. */
function afterLines(text: string, count: number) {
  let index = 0
  for (let line = 0; line < count; line++) {
    const next = text.indexOf("\n", index)
    if (next === -1) return text.length
    index = next + 1
  }
  return index
}

const encoder = new TextEncoder()
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The longest start of `text` that fits in `budget` UTF-8 bytes without splitting a character, emoji included. */
function byteBoundary(text: string, budget: number) {
  // encodeInto only encodes what fits in the buffer, and stops at a whole code point.
  const index = encoder.encodeInto(text, new Uint8Array(Math.max(0, budget))).read
  if (index === text.length || index === 0) return index
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  // Two ASCII characters always have a boundary between them, except the two halves of \r\n.
  if (before < 0x80 && after < 0x80) return before === 13 && after === 10 ? index - 1 : index
  // Otherwise back off to the start of the grapheme the cut is in. A line break always ends one, so segmenting from the
  // start of the line keeps flag pairs and long emoji sequences exact; one code point past the cut gives the context.
  const start = text.lastIndexOf("\n", index - 1) + 1
  return start + (graphemes.segment(text.slice(start, index + 2)).containing(index - start)?.index ?? index - start)
}
