import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { CodeModeTools } from "@opencode/core/tool/plugin/codemode"
import { GlobTool } from "@opencode/core/tool/plugin/glob"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { Document, Info } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { Event } from "@opencode/schema/event"
import { Effect, Layer, PubSub, Ref, Schema, Stream } from "effect"
import { advance } from "./lib/clock"
import { it } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity, codeModeListings } from "./lib/tool"

const layer = AppNodeBuilder.build(Tool.node, [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
])
const sessionID = Session.ID.make("ses_codemode_tools")
const names = ["read", "grep", "glob", "shell", "webfetch", "websearch"]
const native = ["patch", "edit", "write", "question", "skill", "subagent", "experimental_image_generate"]
const setup = (enabled?: boolean) =>
  Effect.gen(function* () {
    const tools = yield* Tool.Service
    yield* tools.transform((editor) => {
      for (const name of [...names, ...native]) {
        editor.add({
          name,
          options: { codemode: false },
          description: name,
          input: Schema.Struct({}),
          output: name === "grep" ? GrepTool.Output : name === "glob" ? GlobTool.Output : Schema.String,
          execute: () =>
            Effect.succeed({
              output: name === "grep" || name === "glob" ? [] : name,
              metadata: { truncated: true },
            }),
        })
      }
    })
    yield* registerToolPlugin(CodeModeTools.Plugin, { event: { subscribe: () => Stream.never } }).pipe(
      Effect.provide(
        Layer.mock(Config.Service)({
          entries: () =>
            Effect.succeed([
              new Document({
                type: "document",
                info: new Info({ experimental: new ConfigExperimental.Info({ codemode_tools: enabled }) }),
              }),
            ]),
        }),
      ),
    )
    return tools
  })

const call = (code: string) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-codemode-tools", name: "execute", input: { code } },
})

describe("CodeModeTools", () => {
  it.effect("switches routing on config updates without rewriting captured snapshots", () =>
    Effect.gen(function* () {
      const tools = yield* Tool.Service
      const document = (enabled: boolean) =>
        new Document({
          type: "document",
          info: new Info({ experimental: new ConfigExperimental.Info({ codemode_tools: enabled }) }),
        })
      const entries = yield* Ref.make([document(false)])
      const event = { id: Event.ID.create(), created: 0, type: "config.updated" as const, data: {} }
      const updates = yield* PubSub.unbounded<typeof event>()
      yield* tools.transform((editor) =>
        editor.add({
          name: "read",
          options: { codemode: false },
          description: "Read",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => Effect.succeed({ output: "content" }),
        }),
      )
      yield* registerToolPlugin(CodeModeTools.Plugin, { event: { subscribe: () => Stream.fromPubSub(updates) } }).pipe(
        Effect.provide(Layer.mock(Config.Service)({ entries: () => Ref.get(entries) })),
      )
      const states: boolean[] = []
      yield* tools.transform((editor) => {
        states.push(editor.get("read")?.options?.codemode === true)
      })
      const before = yield* tools.snapshot()
      yield* Ref.set(entries, [document(true)])
      yield* PubSub.publish(updates, event)
      yield* advance(() => states.at(-1) === true)
      const enabled = yield* tools.snapshot()
      expect(enabled.definitions.map((tool) => tool.name)).not.toContain("read")
      expect(before.definitions.map((tool) => tool.name)).toContain("read")
      yield* Ref.set(entries, [document(false)])
      yield* PubSub.publish(updates, event)
      yield* advance(() => states.at(-1) === false)
      expect((yield* tools.snapshot()).definitions.map((tool) => tool.name)).toContain("read")
      expect(enabled.definitions.map((tool) => tool.name)).not.toContain("read")
      expect(yield* enabled.execute(call("return await tools.read({})"))).toMatchObject({
        output: { output: "content" },
      })
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  for (const enabled of [undefined, false]) {
    it.effect(`keeps native tools when experimental.codemode_tools is ${enabled}`, () =>
      Effect.gen(function* () {
        const tools = yield* setup(enabled)
        const snapshot = yield* tools.snapshot()
        expect(snapshot.definitions.map((tool) => tool.name)).toEqual(expect.arrayContaining([...names, ...native]))
        expect(snapshot.codeModeCatalog?.tools).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  }

  it.effect("pins acquisition tools in Code Mode and keeps interactive/editing tools native", () =>
    Effect.gen(function* () {
      const tools = yield* setup(true)
      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name).sort()).toEqual([...native, "execute"].sort())
      expect(
        codeModeListings(snapshot.codeModeCatalog ?? { tools: [] })
          .map((entry) => entry.path)
          .sort(),
      ).toEqual(names.toSorted())
      expect(snapshot.codeModeCatalog?.tools.every((tool) => tool.type === "tool" && tool.pinned)).toBe(true)
      const result = yield* executeTool(tools, call("return await tools.read({})"))
      expect(result).toMatchObject({ status: "completed", output: { output: "read" } })
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("keeps search truncation in machine output across registry reloads", () =>
    Effect.gen(function* () {
      const tools = yield* setup(true)
      yield* tools.reload()
      yield* tools.reload()
      const result = yield* executeTool(tools, call("return await Promise.all([tools.grep({}), tools.glob({})])"))
      expect(result).toMatchObject({
        status: "completed",
        output: {
          output: JSON.stringify(
            [
              { items: [], truncated: true },
              { items: [], truncated: true },
            ],
            null,
            2,
          ),
        },
      })
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("falls back to native tools when execute is denied and filters denied leaves", () =>
    Effect.gen(function* () {
      const tools = yield* setup(true)
      const disabled = yield* tools.snapshot([{ action: "execute", resource: "*", effect: "deny" }])
      expect(disabled.codeModeCatalog).toBeUndefined()
      expect(disabled.definitions.map((tool) => tool.name)).toEqual(expect.arrayContaining([...names, ...native]))
      const filtered = yield* tools.snapshot([{ action: "read", resource: "*", effect: "deny" }])
      expect(
        codeModeListings(filtered.codeModeCatalog ?? { tools: [] })
          .map((entry) => entry.path)
          .sort(),
      ).toEqual(names.filter((name) => name !== "read").toSorted())
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )

  it.effect("does not override later plugin routing choices", () =>
    Effect.gen(function* () {
      const tools = yield* setup(true)
      yield* tools.transform((editor) => {
        editor.update("read", (tool) => {
          tool.options = { codemode: false }
        })
      })
      yield* tools.reload()
      const snapshot = yield* tools.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toContain("read")
      expect(
        codeModeListings(snapshot.codeModeCatalog ?? { tools: [] })
          .map((entry) => entry.path)
          .sort(),
      ).toEqual(names.filter((name) => name !== "read").toSorted())
    }).pipe(Effect.scoped, Effect.provide(layer)),
  )
})
