import { expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, toolIdentity } from "./lib/tool"
import { makePluginTestLayer } from "./plugin/fixture"

// Runs cannot execute a model here: tests mark sessions active directly and publish the events a run would.
const active = new Set<Session.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(active)),
    isActive: (sessionID) => Effect.sync(() => active.has(sessionID)),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)

const approvals: Permission.AssertInput[] = []
const it = testEffect(
  makePluginTestLayer(
    permissionLayer({ assert: (input) => Effect.sync(() => void approvals.push(input)) }),
    undefined,
    [SessionExecution.node.replace(execution), Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

const setup = () =>
  Effect.gen(function* () {
    active.clear()
    approvals.length = 0
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const bus = yield* Bus.Service
    yield* OpenCodeTools.Plugin.effect(yield* PluginHost.make(plugins, "test"))
    const registry = yield* Tool.Service
    const caller = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const child = yield* sessions.taskCreate({ sessionID: caller.id, title: "Child" })
    const call = (input: Record<string, unknown>, sessionID = caller.id) =>
      executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: `call-task_read-${sessionID}-${JSON.stringify(input)}`,
          name: "execute",
          input: { code: `return await tools.opencode.task_read(${JSON.stringify(input)})` },
        },
      }).pipe(
        Effect.map((result) => ({
          error: result.metadata?.error === true,
          text: result.content?.[0]?.type === "text" ? result.content[0].text : "",
        })),
      )
    const read = (input: Record<string, unknown>, sessionID = caller.id) =>
      call(input, sessionID).pipe(
        Effect.map((result) => {
          if (result.error) throw new Error(`task_read: ${result.text}`)
          return JSON.parse(result.text)
        }),
      )
    // A completed step has Step.Ended; omitting it leaves the assistant message still streaming.
    const respond = (sessionID: Session.ID, text: string, completed = true) =>
      Effect.gen(function* () {
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text })
        if (completed)
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.make(0),
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          })
        return assistantMessageID
      })
    const deliver = (sessionID: Session.ID, inboxID: SessionMessage.ID) =>
      bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID })
    const ask = (sessionID: Session.ID, text: string) =>
      Effect.gen(function* () {
        const admitted = yield* sessions.prompt({ sessionID, text })
        yield* deliver(sessionID, admitted.id)
        return admitted.id
      })
    return { sessions, bus, caller, child, call, read, respond, deliver, ask }
  })

it.live("task_read reads any task_tree member and rejects sessions outside the family", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    const grandchild = yield* fixture.sessions.taskCreate({ sessionID: fixture.child.id, title: "Grandchild" })
    const sibling = yield* fixture.sessions.taskCreate({ sessionID: fixture.caller.id, title: "Sibling" })
    const subagent = yield* fixture.sessions.create({ parentID: fixture.caller.id, title: "Search" })
    const unrelated = yield* fixture.sessions.create({ location: fixture.caller.location, title: "Other" })

    expect(yield* fixture.read({ targetID: fixture.child.id })).toMatchObject({
      sessionID: fixture.child.id,
      title: "Child",
      taskParentID: fixture.caller.id,
      reply: null,
      cursor: null,
    })
    expect((yield* fixture.read({ targetID: grandchild.id })).sessionID).toBe(grandchild.id)
    // The scope is the whole family, as task_tree reports it, in every direction.
    expect((yield* fixture.read({ targetID: fixture.caller.id }, grandchild.id)).sessionID).toBe(fixture.caller.id)
    expect((yield* fixture.read({ targetID: sibling.id }, fixture.child.id)).sessionID).toBe(sibling.id)
    expect(approvals.map((input) => [input.action, input.resources])).toEqual([
      ["opencode_task_read", [fixture.child.id]],
      ["opencode_task_read", [grandchild.id]],
      ["opencode_task_read", [fixture.caller.id]],
      ["opencode_task_read", [sibling.id]],
    ])

    approvals.length = 0
    for (const targetID of [unrelated.id, subagent.id]) {
      const outside = yield* fixture.call({ targetID })
      expect(outside.error).toBe(true)
      expect(outside.text).toContain("not in this persistent task family")
    }
    const own = yield* fixture.call({ targetID: fixture.caller.id })
    expect(own.error).toBe(true)
    expect(own.text).toContain("current session")
    // An unrelated session cannot read into the family either.
    expect((yield* fixture.call({ targetID: fixture.child.id }, unrelated.id)).error).toBe(true)
    // Rejected reads never ask for approval.
    expect(approvals).toEqual([])
  }),
)

it.live("final mode returns the latest completed reply with status and pages to older replies", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    const task = fixture.child.id
    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: task })
    yield* fixture.ask(task, "Implement it")
    const first = yield* fixture.respond(task, "Looking at the code")
    const final = yield* fixture.respond(task, "Implemented. Tests pass.")
    yield* fixture.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: task })
    // A newer step that is still streaming is not a completed reply.
    yield* fixture.respond(task, "Half-written", false)

    const latest = yield* fixture.read({ targetID: task })
    expect(latest).toMatchObject({
      sessionID: task,
      status: "idle",
      outcome: "succeeded",
      reply: { messageID: final, text: "Implemented. Tests pass.", truncated: false },
      truncated: false,
      cursor: final,
    })
    expect(Number.isNaN(Date.parse(latest.updated))).toBe(false)
    expect(Number.isNaN(Date.parse(latest.reply.completed))).toBe(false)
    expect(latest.messages).toBeUndefined()

    const older = yield* fixture.read({ targetID: task, cursor: latest.cursor })
    expect(older.reply).toMatchObject({ messageID: first, text: "Looking at the code" })
    expect(yield* fixture.read({ targetID: task, cursor: older.cursor })).toMatchObject({ reply: null, cursor: null })

    yield* fixture.respond(task, "x".repeat(13_000))
    const long = yield* fixture.read({ targetID: task, mode: "final" })
    expect(long.truncated).toBe(true)
    expect(long.reply.truncated).toBe(true)
    expect(long.reply.text).toHaveLength(12_000)
  }),
)

it.live("task_read reports a running task", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    expect((yield* fixture.read({ targetID: fixture.child.id })).status).toBe("idle")
    active.add(fixture.child.id)
    expect((yield* fixture.read({ targetID: fixture.child.id })).status).toBe("running")
    expect((yield* fixture.read({ targetID: fixture.child.id, mode: "messages" })).status).toBe("running")
  }),
)

it.live("messages mode returns bounded text excerpts with pending inbox items and an older-page cursor", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    const task = fixture.child.id
    yield* fixture.ask(task, "Question one")
    yield* fixture.respond(task, "Answer one")
    const sent = yield* fixture.sessions.taskMessage({ sessionID: fixture.caller.id, targetID: task, text: "Use A" })
    yield* fixture.deliver(task, sent.id)
    yield* fixture.respond(task, "y".repeat(1_500))
    yield* fixture.sessions.taskMessage({ sessionID: fixture.caller.id, targetID: task, text: "Not read yet" })

    const page = yield* fixture.read({ targetID: task, mode: "messages", limit: 2 })
    expect(page.messages).toEqual([
      expect.objectContaining({ id: sent.id, role: "task", from: fixture.caller.id, text: "Use A", truncated: false }),
      expect.objectContaining({ role: "assistant", text: "y".repeat(1_000), truncated: true }),
    ])
    expect(page.pending).toEqual([expect.objectContaining({ role: "task", text: "Not read yet" })])
    expect(page.truncated).toBe(true)
    expect(page.reply).toBeUndefined()
    expect(page.cursor).toBe(sent.id)

    const older = yield* fixture.read({ targetID: task, mode: "messages", cursor: page.cursor })
    expect(older.messages.map((message: { role: string; text: string }) => [message.role, message.text])).toEqual([
      ["user", "Question one"],
      ["assistant", "Answer one"],
    ])
    expect(older.pending).toEqual([])
    expect(older.truncated).toBe(false)
    expect(older.cursor).toBeNull()
  }),
)

it.live("messages mode stops at the output budget and continues from the cursor", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    const task = fixture.child.id
    for (let index = 0; index < 8; index++) yield* fixture.respond(task, `${index}`.repeat(1_000))

    const page = yield* fixture.read({ targetID: task, mode: "messages", limit: 50 })
    expect(page.messages.map((message: { text: string }) => message.text[0])).toEqual(["2", "3", "4", "5", "6", "7"])
    expect(page.truncated).toBe(true)
    expect(page.cursor).toBe(page.messages[0].id)

    const rest = yield* fixture.read({ targetID: task, mode: "messages", limit: 50, cursor: page.cursor })
    expect(rest.messages.map((message: { text: string }) => message.text[0])).toEqual(["0", "1"])
    expect(rest).toMatchObject({ truncated: false, cursor: null })
  }),
)
