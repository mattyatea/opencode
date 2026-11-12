import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ToolOutput } from "@opencode/core/tool-output"
import type { Tool } from "@opencode/core/tool"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { withTempDir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const withStore = <A, E, R>(
  body: (output: ToolOutput.Interface, fs: FSUtil.Interface, root: string) => Effect.Effect<A, E, R>,
  limits?: { maxLines?: number; maxBytes?: number },
) =>
  withTempDir((tmp) => {
    const layer = AppNodeBuilder.build(LayerNode.group([ToolOutput.node, FSUtil.node]), [
      Global.node.replace(Global.layerWith({ data: tmp.path })),
    ])
    return Effect.gen(function* () {
      const output = yield* ToolOutput.Service
      const fs = yield* FSUtil.Service
      if (limits) yield* output.transform((editor) => editor.configure(limits))
      return yield* body(output, fs, tmp.path)
    }).pipe(Effect.provide(layer))
  })

describe("ToolOutput", () => {
  it.live("writes oversized text and returns its head and tail around a marker", () =>
    withStore(
      (service, fs) =>
        Effect.gen(function* () {
          const output = { items: [1, 2, 3] }
          const text = "one\ntwo\nthree\nfour\nfive"
          const result = yield* service.truncate({ output, content: [{ type: "text", text }] })
          expect(result.output).toBe(output)
          expect(result.metadata).toMatchObject({ truncated: true })
          const outputPath = result.metadata?.outputPath
          expect(typeof outputPath).toBe("string")
          if (typeof outputPath !== "string") return
          expect(yield* fs.readFileString(outputPath)).toBe(text)
          expect(result.content).toEqual([
            { type: "text", text: "one\ntwo" },
            { type: "text", text: `[showing lines 1-2 and 5-5 of 5; full output saved to ${outputPath}]` },
            { type: "text", text: "five" },
          ])
        }),
      { maxLines: 3, maxBytes: 1_000 },
    ),
  )

  it.live("keeps the end of a log whose head alone would fill the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`)
          const result = yield* output.truncate({
            content: [{ type: "text", text: [...lines, "", "Error: build failed", "exit 1"].join("\n") }],
          })
          const shown = result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
          expect(shown).toStartWith("line 1\n")
          expect(shown).toEndWith("Error: build failed\nexit 1")
          expect(shown).toContain("[showing lines 1-")
          expect(Buffer.byteLength(shown.replace(/\n?\[showing [^\]]+\]\n?/, ""))).toBeLessThanOrEqual(200)
        }),
      { maxLines: 2_000, maxBytes: 200 },
    ),
  )

  it.live("reports lines shown under the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "one\ntwo" }] })
          expect(result.content).toEqual([
            {
              type: "text",
              text: expect.stringMatching(/^\[showing lines 2-2 of 2; full output saved to .+\]$/),
            },
            { type: "text", text: "two" },
          ])
        }),
      { maxLines: 100, maxBytes: 5 },
    ),
  )

  it.live("preserves mixed content ordering", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const file = { type: "file" as const, uri: "file:///image.png", mime: "image/png" }
          const result = yield* output.truncate({
            content: [{ type: "text", text: "before" }, file, { type: "text", text: "omitted\nafter" }],
          })
          expect(result.content).toEqual([
            { type: "text", text: "before" },
            file,
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-1 and 3-3 of 3; full output saved to /) },
            { type: "text", text: "after" },
          ])
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("preserves producer truncation metadata when the result fits", () =>
    withStore((output) =>
      Effect.gen(function* () {
        const content: Tool.NormalizedResult["content"] = [{ type: "text", text: "one\ntwo" }]
        const truncated = { content, metadata: { truncated: true, source: "tool" } }
        const retained = { content, metadata: { truncated: false, source: "tool" } }
        expect(yield* output.truncate(truncated)).toBe(truncated)
        expect(yield* output.truncate(retained)).toBe(retained)
      }),
    ),
  )

  for (const truncated of [false, true]) {
    it.live(`enforces the preview budget even when the producer reports truncated=${truncated}`, () =>
      withStore(
        (output, fs) =>
          Effect.gen(function* () {
            const text = "first\nsecond\nthird"
            const result = yield* output.truncate({
              content: [{ type: "text", text }],
              metadata: { truncated, matches: 3 },
            })
            expect(result.metadata).toMatchObject({ truncated: true, matches: 3 })
            expect(result.content[0]).toEqual({ type: "text", text: "first" })
            const file = result.metadata?.outputPath
            expect(typeof file).toBe("string")
            if (typeof file !== "string") return
            expect(yield* fs.readFileString(file)).toBe(text)
          }),
        { maxLines: 1, maxBytes: 100 },
      ),
    )
  }

  it.live("keeps the producer's existing full output when bounding its preview again", () =>
    withStore(
      (output, fs, root) =>
        Effect.gen(function* () {
          const file = path.join(root, "producer.txt")
          yield* fs.writeFileString(file, "original complete output")
          const result = yield* output.truncate({
            content: [{ type: "text", text: "first\nsecond\nthird" }],
            metadata: { truncated: true, outputPath: file },
          })
          expect(result.metadata).toMatchObject({ truncated: true, outputPath: file })
          expect(result.content[0]).toEqual({ type: "text", text: "first" })
          expect(yield* fs.readFileString(file)).toBe("original complete output")
          expect(result.content.at(-1)).toEqual({
            type: "text",
            text: `[showing lines 1-1 of 3; full output saved to ${file}]`,
          })
        }),
      { maxLines: 1, maxBytes: 100 },
    ),
  )

  it.live("marks results that fit without changing their content", () =>
    withStore((output) =>
      Effect.gen(function* () {
        const content = [{ type: "text" as const, text: "small" }]
        expect(yield* output.truncate({ content })).toEqual({ content, metadata: { truncated: false } })
      }),
    ),
  )

  it.live("does not count a trailing newline as another line", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          expect(yield* output.truncate({ content: [{ type: "text", text: "one\ntwo\n" }] })).toEqual({
            content: [{ type: "text", text: "one\ntwo\n" }],
            metadata: { truncated: false },
          })
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("reports a trailing newline omitted by the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "one\n" }] })
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-1 of 1; full output saved to /) },
          ])
        }),
      { maxLines: 2, maxBytes: 3 },
    ),
  )

  it.live("uses file modification time when IDs wrap", () =>
    withStore((output, fs, root) =>
      Effect.gen(function* () {
        const directory = path.join(root, ToolOutput.DIRECTORY)
        const old = path.join(directory, ToolOutput.fileName(2 ** 36 - 1))
        const recent = path.join(directory, ToolOutput.fileName(2 ** 36 + 1))
        yield* fs.ensureDir(directory)
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.utimes(old, new Date(), new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000))
        yield* output.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    ),
  )
})
