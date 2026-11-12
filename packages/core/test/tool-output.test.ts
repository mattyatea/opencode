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
  it.live("keeps the beginning and the final error while retaining full output and media order", () =>
    withStore(
      (output, fs) =>
        Effect.gen(function* () {
          const image = { type: "file" as const, uri: "file:///image.png", mime: "image/png" }
          const text = "HEAD\n" + "middle\n".repeat(10) + "TAIL_ERROR=7\n"
          const result = yield* output.truncate({
            content: [{ type: "text", text: "HEAD\n" }, image, { type: "text", text: text.slice(5) }],
            metadata: { exit: 7 },
          })
          const preview = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          expect(preview).toContain("HEAD")
          expect(preview).toContain("TAIL_ERROR=7")
          expect(preview).toContain("middle omitted")
          expect(result.content[1]).toEqual(image)
          expect(result.metadata?.exit).toBe(7)
          expect(yield* fs.readFileString(result.metadata?.outputPath)).toBe("HEAD\n\n" + text.slice(5))
        }),
      { maxLines: 4, maxBytes: 40 },
    ),
  )

  for (const ending of ["", "\n"])
    it.live(
      `bounds a single-line Unicode failure with ending ${JSON.stringify(ending)} without splitting code points`,
      () =>
        withStore(
          (output, fs) =>
            Effect.gen(function* () {
              const text = "始🙂" + "あ🙂".repeat(100) + "末🙂" + ending
              const result = yield* output.truncate({ content: [{ type: "text", text }] }, "head-tail")
              const preview = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
              expect(preview[0]).toStartWith("始🙂")
              expect(preview.at(-1)).toEndWith("末🙂" + ending)
              expect(preview.join("")).not.toContain("�")
              expect(Buffer.byteLength(preview[0]! + preview.at(-1)!)).toBeLessThanOrEqual(31)
              expect(yield* fs.readFileString(result.metadata?.outputPath)).toBe(text)
            }),
          { maxLines: 4, maxBytes: 31 },
        ),
    )

  it.live("writes oversized text and returns a bounded preview", () =>
    withStore(
      (service, fs) =>
        Effect.gen(function* () {
          const output = { items: [1, 2, 3] }
          const result = yield* service.truncate({ output, content: [{ type: "text", text: "one\ntwo\nthree" }] })
          expect(result.output).toBe(output)
          expect(result.metadata).toMatchObject({ truncated: true })
          const outputPath = result.metadata?.outputPath
          expect(typeof outputPath).toBe("string")
          if (typeof outputPath !== "string") return
          expect(yield* fs.readFileString(outputPath)).toBe("one\ntwo\nthree")
          expect(result.content).toEqual([
            { type: "text", text: "one\ntwo" },
            { type: "text", text: `[showing lines 1-2 of 3; full output saved to ${outputPath}]` },
          ])
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("reports lines shown under the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "one\ntwo" }] })
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            {
              type: "text",
              text: expect.stringMatching(/^\[showing lines 1-1 of 2; full output saved to .+\]$/),
            },
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
            content: [{ type: "text", text: "before" }, file, { type: "text", text: "after\nomitted" }],
          })
          expect(result.content).toEqual([
            { type: "text", text: "before" },
            file,
            { type: "text", text: "after" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-2 of 3; full output saved to /) },
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
