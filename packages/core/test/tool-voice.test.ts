import { expect } from "bun:test"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { Tool } from "@opencode/core/tool"
import { VoiceTools } from "@opencode/core/tool/plugin/voice"
import { VoiceRegistry } from "@opencode/core/voice/registry"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"
import { makePluginTestLayer } from "./plugin/fixture"

// The model drain cannot run in a unit test; a prompt only records that its session was woken.
const active = new Set<Session.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(active)),
    isActive: (sessionID) => Effect.sync(() => active.has(sessionID)),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => void active.add(sessionID)),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)

const it = testEffect(makePluginTestLayer(undefined, undefined, undefined, [SessionExecution.node.replace(execution)]))

it.effect("voice tools act on the session on screen and report back to the call", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    yield* VoiceTools.Plugin.effect(yield* PluginHost.make(plugins, "test"))
    const registry = yield* Tool.Service
    const here = Location.Ref.make({ directory: location.directory })
    const voice = yield* sessions.create({ title: "Voice call", location: here })
    const login = yield* sessions.create({ title: "Fix login bug", location: here })
    const docs = yield* sessions.create({ title: "Write docs", location: here })
    const opened: string[] = []
    const watched: string[] = []
    const unlink = VoiceRegistry.link(voice.id, {
      viewing: () => ({ id: login.id, title: login.title }),
      open: (sessionID) => opened.push(sessionID),
      watch: (input) => watched.push(`${input.title}: ${input.request}`),
    })
    yield* Effect.addFinalizer(() => Effect.sync(unlink))

    const run = (name: string, input: Record<string, unknown>, sessionID = voice.id) =>
      executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: `call-${name}`, name, input },
      }).pipe(
        Effect.map((result) => {
          if (result.status === "error") throw new Error(`${name}: ${result.error?.message}`)
          return JSON.parse(result.content?.[0]?.type === "text" ? result.content[0].text : "")
        }),
      )

    const listed = yield* run("voice_search_sessions", { query: "docs" })
    expect(listed).toEqual([expect.objectContaining({ id: docs.id, title: "Write docs", on_screen: false })])

    // An omitted session_id means the one on screen.
    const sent = yield* run("voice_send_message", { text: "Add a regression test for the redirect" })
    expect(sent).toEqual({ sent: true, session_id: login.id, title: "Fix login bug" })
    expect(watched).toEqual(["Fix login bug: Add a regression test for the redirect"])
    // The prompt waits in the inbox until a drain delivers it, which this test never runs.
    expect(yield* run("voice_read_session", {})).toEqual(
      expect.objectContaining({ id: login.id, status: "running", on_screen: false, messages: [] }),
    )

    expect(yield* run("voice_open_session", { session_id: docs.id })).toEqual({
      requested: true,
      session_id: docs.id,
      title: "Write docs",
    })
    expect(opened).toEqual([docs.id])

    // Outside a live call's voice session the tools refuse to act.
    const outside = yield* executeTool(registry, {
      sessionID: login.id,
      ...toolIdentity,
      call: { type: "tool-call", id: "call-outside", name: "voice_list_sessions", input: {} },
    })
    expect(outside).toEqual({
      status: "error",
      error: { type: "tool.execution", message: "Voice tools work only in a live voice call's session." },
    })
  }),
)
