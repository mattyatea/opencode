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

  it.live("keeps the preview when the full output cannot be saved", () =>
    withStore(
      (service, fs, root) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(path.join(root, ToolOutput.DIRECTORY), "not a directory")
          const result = yield* service.truncate({ content: [{ type: "text", text: "one\ntwo\nthree" }] })
          expect(result.metadata).toEqual({ truncated: true })
          expect(result.content).toEqual([
            { type: "text", text: "one" },
            {
              type: "text",
              text: expect.stringMatching(
                /^\[showing lines 1-1 and 3-3 of 3; full output could not be saved: E[A-Z]+: [^\n]+\]$/,
              ),
            },
            { type: "text", text: "three" },
          ])
        }),
      { maxLines: 2, maxBytes: 1_000 },
    ),
  )

  it.live("cuts at the byte limit, inside a line when it falls there", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "one\ntwo" }] })
          expect(result.content).toEqual([
            { type: "text", text: "one\nt" },
            {
              type: "text",
              text: expect.stringMatching(/^\[showing lines 1-2 of 2 \(last line cut\); full output saved to .+\]$/),
            },
          ])
        }),
      { maxLines: 100, maxBytes: 5 },
    ),
  )

  it.live("shows the start of a single line longer than the byte limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const text = JSON.stringify({ items: Array.from({ length: 50 }, (_, index) => index) })
          const result = yield* output.truncate({ content: [{ type: "text", text }] })
          expect(result.content).toEqual([
            { type: "text", text: text.slice(0, 20) },
            {
              type: "text",
              text: expect.stringMatching(
                new RegExp("^\\[showing lines 1-1 of 1 \\(last line cut\\); full output saved to .+\\]$"),
              ),
            },
          ])
        }),
      { maxLines: 100, maxBytes: 20 },
    ),
  )

  it.live("never splits a character or an emoji at the cut", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const family = "👨‍👩‍👧‍👦"
          const cases = [
            { text: "ab✓✓✓", shown: "ab✓" },
            { text: `ab${family}cd`, shown: "ab" },
            { text: "ab👍🏽cd", shown: "ab" },
            { text: "ab🇯🇵cd", shown: "ab" },
            { text: "ab𝒳𝒳", shown: "ab𝒳" },
          ]
          for (const item of cases) {
            const result = yield* output.truncate({ content: [{ type: "text", text: item.text }] })
            const first = result.content[0]
            expect(first).toEqual({ type: "text", text: item.shown })
            expect(first?.type === "text" && first.text.isWellFormed()).toBe(true)
          }
        }),
      { maxLines: 100, maxBytes: 7 },
    ),
  )

  it.live("keeps flags and long clusters whole however long the text before them", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const flags = yield* output.truncate({ content: [{ type: "text", text: "a" + "🇯🇵".repeat(40) }] })
          expect(flags.content[0]).toEqual({ type: "text", text: "a" + "🇯🇵".repeat(20) })
          const cluster = "👍" + "🏽\u0301".repeat(60)
          const long = yield* output.truncate({ content: [{ type: "text", text: `ab${cluster}z` }] })
          expect(long.content[0]).toEqual({ type: "text", text: "ab" })
        }),
      { maxLines: 100, maxBytes: 165 },
    ),
  )

  it.live("cuts inside a later text part and leaves out the parts after it", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const inside = yield* output.truncate({
            content: [
              { type: "text", text: "" },
              { type: "text", text: "abc" },
              { type: "text", text: "defgh" },
              { type: "text", text: "" },
            ],
          })
          expect(inside.content).toEqual([
            { type: "text", text: "" },
            { type: "text", text: "abc" },
            { type: "text", text: "de" },
            {
              type: "text",
              text: expect.stringMatching(/^\[showing lines 1-2 of 2 \(last line cut\);/),
            },
          ])
          const between = yield* output.truncate({
            content: [
              { type: "text", text: "abcde" },
              { type: "text", text: "fgh" },
            ],
          })
          expect(between.content).toEqual([
            { type: "text", text: "ab" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-1 and 2-2 of 2 \(line 1 cut\);/) },
            { type: "text", text: "fgh" },
          ])
        }),
      { maxLines: 100, maxBytes: 6 },
    ),
  )

  it.live("ends a line cut before its line break", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const crlf = yield* output.truncate({ content: [{ type: "text", text: "one\r\ntwo\r\nthree" }] })
          expect(crlf.content).toEqual([
            { type: "text", text: "one" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-1 of 3;/) },
          ])
          const blank = yield* output.truncate({ content: [{ type: "text", text: "\nfoo\nbar" }] })
          expect(blank.content).toEqual([{ type: "text", text: expect.stringMatching(/^\[showing lines 1-1 of 3;/) }])
        }),
      { maxLines: 1, maxBytes: 1_000 },
    ),
  )

  it.live("counts a blank last line of the preview", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "a\n\n\nb" }] })
          expect(result.content).toEqual([
            { type: "text", text: "a\n" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-2 and 4-4 of 4;/) },
            { type: "text", text: "b" },
          ])
        }),
      { maxLines: 3, maxBytes: 1_000 },
    ),
  )

  it.live("shows nothing under a zero line limit", () =>
    withStore(
      (output) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({ content: [{ type: "text", text: "secret" }] })
          expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/^\[showing 0 lines of 1;/) }])
        }),
      { maxLines: 0, maxBytes: 1_000 },
    ),
  )

  it.live("joins text parts with a line break only where one is missing", () =>
    withStore(
      (output, fs) =>
        Effect.gen(function* () {
          const result = yield* output.truncate({
            content: [
              { type: "text", text: "one\n" },
              { type: "text", text: "two" },
              { type: "text", text: "three" },
              { type: "text", text: "four" },
            ],
          })
          const outputPath = result.metadata?.outputPath
          expect(typeof outputPath).toBe("string")
          if (typeof outputPath !== "string") return
          expect(yield* fs.readFileString(outputPath)).toBe("one\ntwo\nthree\nfour")
          expect(result.content).toEqual([
            { type: "text", text: "one\n" },
            { type: "text", text: "two" },
            { type: "text", text: expect.stringMatching(/^\[showing lines 1-2 and 4-4 of 4;/) },
            { type: "text", text: "four" },
          ])
        }),
      { maxLines: 3, maxBytes: 1_000 },
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
            {
              type: "text",
              text: expect.stringMatching(/^\[showing lines 1-1 of 1; full output saved to /),
            },
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
