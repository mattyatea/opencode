import { expect } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Location } from "@opencode/core/location"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionInboxTable } from "@opencode/core/session/sql"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { makePluginTestLayer } from "./plugin/fixture"

// Runs cannot execute a model here, so tests publish the lifecycle events a real run would.
const wakes: Session.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set<Session.ID>()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)

const it = testEffect(
  makePluginTestLayer(permissionLayer({ assert: () => Effect.void }), undefined, [
    SessionExecution.node.replace(execution),
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)

const setup = () =>
  Effect.gen(function* () {
    wakes.length = 0
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const bus = yield* Bus.Service
    const database = yield* Database.Service
    const parent = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const task = yield* sessions.taskCreate({ sessionID: parent.id, title: "Child" })
    const received = () =>
      sessions.taskMessages(parent.id).pipe(Effect.map((all) => all.filter((message) => message.from === task.id)))
    // Each run starts with Execution.Started; the report reads only this run's final assistant message.
    const respond = (text: string) =>
      Effect.gen(function* () {
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID: task.id,
          assistantMessageID,
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
          started: 0,
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID: task.id, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID: task.id, assistantMessageID, ordinal: 0, text })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID: task.id,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.make(0),
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        })
        return assistantMessageID
      })
    const settle = (count: number) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 50 && (yield* received()).length < count; attempt++)
          yield* Effect.sleep("20 millis")
        // Give a duplicate report time to arrive before asserting that it did not.
        yield* Effect.sleep("150 millis")
        return yield* received()
      })
    const synthetic = () =>
      database.db
        .select()
        .from(SessionInboxTable)
        .where(eq(SessionInboxTable.type, "synthetic"))
        .all()
        .pipe(Effect.orDie)
    return { sessions, bus, database, parent, task, received, respond, settle, synthetic }
  })

it.live("a succeeded child run reports its final response to the parent once", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: fixture.task.id })
    yield* fixture.respond("Intermediate note")
    const final = yield* fixture.respond("Implemented the feature. Tests pass.")
    yield* fixture.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.task.id })

    const messages = yield* fixture.settle(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ id: `${final}_report`, to: fixture.parent.id, state: "pending" })
    expect(messages[0]?.text).toContain("outcome: succeeded")
    expect(messages[0]?.text).toContain("Implemented the feature. Tests pass.")
    expect(messages[0]?.text).not.toContain("Intermediate note")
    expect(wakes).toContain(fixture.parent.id)
    expect(wakes).not.toContain(fixture.task.id)
    const inbox = yield* SessionInbox.find(fixture.database.db, messages[0]!.id)
    expect(inbox?.payload).toMatchObject({
      text: expect.stringContaining(`Message from task ${fixture.task.id} (Child)`),
    })
  }),
)

it.live("a replayed terminal event does not duplicate a report the parent already read", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: fixture.task.id })
    yield* fixture.respond("Done")
    yield* fixture.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.task.id })
    const [first] = yield* fixture.settle(1)
    yield* fixture.bus.publish(SessionEvent.InboxDelivered, { sessionID: fixture.parent.id, inboxID: first!.id })
    expect((yield* fixture.received())[0]?.state).toBe("delivered")

    // The same run settling again (a retry or restart) reuses the ID derived from its final message.
    yield* fixture.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.task.id })
    expect(yield* fixture.settle(2)).toHaveLength(1)

    // A later run triggered by the parent reports once more, with its own final response.
    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: fixture.task.id })
    yield* fixture.respond("Follow-up done")
    yield* fixture.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.task.id })
    const messages = yield* fixture.settle(2)
    expect(messages).toHaveLength(2)
    expect(messages[1]?.text).toContain("Follow-up done")
  }),
)

it.live("a final result the child already sent with task_send in this run is not sent again", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: fixture.task.id })
    yield* fixture.sessions.taskMessage({ sessionID: fixture.task.id, targetID: fixture.parent.id, text: "All done" })
    yield* fixture.respond("All done")
    yield* fixture.bus.publish(SessionEvent.Execution.Succeeded, { sessionID: fixture.task.id })

    const messages = yield* fixture.settle(2)
    expect(messages.map((message) => message.text)).toEqual(["All done"])
  }),
)

it.live("failed and interrupted runs report a short status", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: fixture.task.id })
    yield* fixture.respond("Partial work")
    yield* fixture.bus.publish(SessionEvent.Execution.Failed, {
      sessionID: fixture.task.id,
      error: { type: "unknown", message: "boom" },
    })
    const [failed] = yield* fixture.settle(1)
    expect(failed?.text).toContain("outcome: failed")
    expect(failed?.text).toContain("Error: boom")
    expect(failed?.text).not.toContain("Partial work")

    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: fixture.task.id })
    yield* fixture.bus.publish(SessionEvent.Execution.Interrupted, { sessionID: fixture.task.id, reason: "user" })
    const messages = yield* fixture.settle(2)
    expect(messages).toHaveLength(2)
    expect(messages[1]?.text).toContain("outcome: interrupted, reason: user")
  }),
)

it.live("shutdown interruptions are not reported because the restarted run settles later", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID: fixture.task.id })
    yield* fixture.bus.publish(SessionEvent.Execution.Interrupted, { sessionID: fixture.task.id, reason: "shutdown" })
    expect(yield* fixture.settle(1)).toHaveLength(0)
  }),
)

it.live("sessions without a task parent and subagents never report", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    const subagent = yield* fixture.sessions.create({ parentID: fixture.parent.id, title: "Search" })
    const taskSubagent = yield* fixture.sessions.create({ parentID: fixture.task.id, title: "Nested search" })
    for (const sessionID of [fixture.parent.id, subagent.id, taskSubagent.id]) {
      yield* fixture.bus.publish(SessionEvent.Execution.Started, { sessionID })
      yield* fixture.bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
      yield* fixture.bus.publish(SessionEvent.Execution.Failed, {
        sessionID,
        error: { type: "unknown", message: "boom" },
      })
    }
    yield* Effect.sleep("200 millis")
    expect(yield* fixture.synthetic()).toEqual([])
    expect(wakes).toEqual([])
  }),
)
