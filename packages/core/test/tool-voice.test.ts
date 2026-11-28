import { expect } from "bun:test"
import { Config } from "@opencode/core/config"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { voiceAgentID } from "@opencode/core/plugin/agent"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { Tool } from "@opencode/core/tool"
import { VoiceTools } from "@opencode/core/tool/plugin/voice"
import { VoiceRegistry } from "@opencode/core/voice/registry"
import { Document, Info } from "@opencode/schema/config"
import { ConfigVoice } from "@opencode/schema/config/voice"
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

const it = testEffect(makePluginTestLayer(undefined, undefined, [SessionExecution.node.replace(execution)]))

const withWorkModel = testEffect(
  makePluginTestLayer(undefined, undefined, [
    SessionExecution.node.replace(execution),
    Config.node.replace(
      Config.testLayer([
        new Document({
          type: "document",
          info: new Info({ voice: new ConfigVoice.Info({ work_model: "test/override#fast" }) }),
        }),
      ]),
    ),
  ]),
)

/** Starts the voice tools in a call that began on a fresh main session. */
const call = Effect.fnUntraced(function* () {
  const plugins = yield* Plugin.Service
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  yield* VoiceTools.Plugin.effect(yield* PluginHost.make(plugins, "test"))
  const registry = yield* Tool.Service
  const main = yield* sessions.create({ title: "Main", location: Location.Ref.make({ directory: location.directory }) })
  const voice = yield* sessions.create({ title: "Voice call", agent: voiceAgentID, parentID: main.id })
  const unlink = VoiceRegistry.link(voice.id, {
    main: main.id,
    viewing: () => ({ id: main.id, title: main.title }),
    open: () => undefined,
    watch: () => undefined,
  })
  yield* Effect.addFinalizer(() => Effect.sync(unlink))
  const providers = yield* Provider.Service
  yield* providers.transform((editor) => {
    editor.models.update(Provider.ID.make("test"), Model.ID.make("override"), (model) => {
      model.variants = [{ id: Model.VariantID.make("fast") }]
    })
  })

  const run = (name: string, input: Record<string, unknown>) =>
    executeTool(registry, {
      sessionID: voice.id,
      ...toolIdentity,
      call: { type: "tool-call", id: `call-${name}`, name, input },
    })

  return { sessions, main, run }
})

const output = (result: { status: string; content?: readonly { type: string; text?: string }[] }) =>
  JSON.parse(result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : "")

it.effect("voice tools send to the main session and run independent child tasks without switching the screen", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    yield* VoiceTools.Plugin.effect(yield* PluginHost.make(plugins, "test"))
    const registry = yield* Tool.Service
    const here = Location.Ref.make({ directory: location.directory })
    const login = yield* sessions.create({ title: "Fix login bug", location: here })
    const voice = yield* sessions.create({ title: "Voice call", agent: voiceAgentID, parentID: login.id })
    const child = yield* sessions.taskCreate({ sessionID: login.id, title: "Already open" })
    const docs = yield* sessions.create({ title: "Write docs", location: here })
    const opened: string[] = []
    const watched: string[] = []
    const unlink = VoiceRegistry.link(voice.id, {
      main: login.id,
      viewing: () => ({ id: child.id, title: child.title }),
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

    // The visible child doesn't become the default work destination.
    const sent = yield* run("voice_send_message", { text: "Add a regression test for the redirect" })
    expect(sent).toEqual({ sent: true, session_id: login.id, title: "Fix login bug" })
    expect(watched).toEqual(["Fix login bug: Add a regression test for the redirect"])
    // The prompt waits in the inbox until a drain delivers it, which this test never runs.
    expect(yield* run("voice_read_session", {})).toEqual(
      expect.objectContaining({ id: login.id, status: "running", on_screen: false, messages: [] }),
    )

    const check = yield* run("voice_create_task", { title: "Check redirect", text: "Understand the redirect" })
    const test = yield* run("voice_create_task", { title: "Check coverage", text: "Read the tests" })
    expect(check.started).toBe(true)
    expect(test.started).toBe(true)
    expect((yield* sessions.get(check.task_id)).experimental?.taskParentID).toBe(login.id)
    expect((yield* sessions.get(test.task_id)).experimental?.taskParentID).toBe(login.id)
    expect(yield* sessions.inbox(check.task_id)).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ text: "Understand the redirect" }) }),
    ])
    expect(yield* run("voice_list_tasks", {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: check.task_id, status: "running", parent_id: login.id }),
        expect.objectContaining({ id: test.task_id, status: "running", parent_id: login.id }),
      ]),
    )
    expect(opened).toEqual([])

    const created = yield* run("voice_create_session", { title: "Another project task" })
    const main = yield* sessions.get(created.session_id)
    expect(main.parentID).toBeUndefined()
    expect(main.experimental?.taskParentID).toBeUndefined()
    expect(main.location).toEqual(login.location)

    const providers = yield* Provider.Service
    yield* providers.transform((editor) => {
      editor.models.update(Provider.ID.make("test"), Model.ID.make("override"), (model) => {
        model.variants = [{ id: Model.VariantID.make("fast") }]
      })
    })
    expect((yield* run("voice_list_models", { query: "test override", session_id: check.task_id })).models).toEqual([
      expect.objectContaining({ id: "test/override", variants: ["fast"] }),
    ])
    expect(
      yield* run("voice_switch_model", { model: "test/override", variant: "fast", session_id: check.task_id }),
    ).toMatchObject({ session_id: check.task_id, variant: "fast" })
    expect((yield* sessions.get(check.task_id)).model).toEqual(Model.Ref.parse("test/override#fast"))
    expect((yield* sessions.get(login.id)).model).toEqual(login.model)

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

it.effect("voice model tools rank spoken queries and accept any casing of an offered model and variant", () =>
  Effect.gen(function* () {
    const voice = yield* call()

    // Extra spoken words ("model", the variant) no longer drop every match.
    const listed = output(yield* voice.run("voice_list_models", { query: "the override model on fast" }))
    expect(listed.models[0]).toEqual(expect.objectContaining({ id: "test/override", variants: ["fast"] }))
    expect(listed.models[0].current).toBe(false)

    expect(output(yield* voice.run("voice_switch_model", { model: "TEST/Override", variant: "FAST" }))).toMatchObject({
      session_id: voice.main.id,
      variant: "fast",
    })
    expect((yield* voice.sessions.get(voice.main.id)).model).toEqual(Model.Ref.parse("test/override#fast"))

    expect(yield* voice.run("voice_switch_model", { model: "test/override", variant: "slow" })).toMatchObject({
      status: "error",
      error: { message: "override has no slow variant; it offers fast. The model did not change." },
    })
    expect(yield* voice.run("voice_switch_model", { model: "test/missing" })).toMatchObject({
      status: "error",
      error: { message: expect.stringContaining("the model did not change.") },
    })
  }),
)

it.effect("sessions and tasks the voice creates inherit the main session's model without voice.work_model", () =>
  Effect.gen(function* () {
    const voice = yield* call()
    const created = output(yield* voice.run("voice_create_session", { title: "Other" }))
    const task = output(yield* voice.run("voice_create_task", { title: "Check", text: "Check it" }))

    expect((yield* voice.sessions.get(created.session_id)).model).toEqual(voice.main.model)
    expect((yield* voice.sessions.get(task.task_id)).model).toEqual(voice.main.model)
  }),
)

withWorkModel.effect("sessions and tasks the voice creates use voice.work_model", () =>
  Effect.gen(function* () {
    const voice = yield* call()
    const created = output(yield* voice.run("voice_create_session", { title: "Other" }))
    const task = output(yield* voice.run("voice_create_task", { title: "Check", text: "Check it" }))
    const expected = Model.Ref.parse("test/override#fast")

    expect((yield* voice.sessions.get(created.session_id)).model).toEqual(expected)
    expect((yield* voice.sessions.get(task.task_id)).model).toEqual(expected)
    expect((yield* voice.sessions.get(voice.main.id)).model).toEqual(voice.main.model)
  }),
)
