import { expect } from "bun:test"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/core/permission"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Agent } from "@opencode/schema/agent"
import { Project } from "@opencode/core/project"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionTable } from "@opencode/core/session/sql"
import { EventTable } from "@opencode/core/event/sql"
import { Tool } from "@opencode/core/tool"
import { OpenCodeTools } from "@opencode/core/tool/plugin/opencode"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, toolIdentity } from "./lib/tool"
import { makePluginTestLayer } from "./plugin/fixture"

// The model drain cannot run in a unit test, so this boundary records that `Session.prompt`
// really asked the process-global execution service to start the newly created session.
const wakes: Session.ID[] = []
const active = new Set<Session.ID>()
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.sync(() => new Set(active)),
    isActive: (sessionID) => Effect.sync(() => active.has(sessionID)),
    resume: () => Effect.void,
    wake: (sessionID) =>
      Effect.sync(() => {
        wakes.push(sessionID)
        active.add(sessionID)
      }),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)

const approvals: Permission.AssertInput[] = []
let reject = false
const permission = permissionLayer({
  assert: (input) =>
    Effect.sync(() => approvals.push(input)).pipe(
      Effect.andThen(
        reject && input.action === "opencode_session_create"
          ? Effect.fail(new Permission.CorrectedError({ feedback: "Session creation declined" }))
          : Effect.void,
      ),
    ),
})

const it = testEffect(
  makePluginTestLayer(permission, undefined, undefined, [
    SessionExecution.node.replace(execution),
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)

const prepareProject = (directory: string, name: string) =>
  Effect.gen(function* () {
    const projects = yield* Project.Service
    const resolved = yield* projects.resolve(AbsolutePath.make(directory))
    yield* projects.update({ projectID: resolved.id, name })
    return resolved.id
  })

const setup = () =>
  Effect.gen(function* () {
    const alpha = yield* tmpdirScoped()
    const beta = yield* tmpdirScoped()
    const alphaID = yield* prepareProject(alpha.path, "Alpha One")
    const betaID = yield* prepareProject(beta.path, "Alpha Two")
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const location = yield* Location.Service
    const database = yield* Database.Service
    yield* OpenCodeTools.Plugin.effect(yield* PluginHost.make(plugins, "test"))
    const caller = yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })
    const registry = yield* Tool.Service
    const call = (name: string, input: Record<string, unknown>, sessionID = caller.id) =>
      executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: `call-${name}-${JSON.stringify(input)}`,
          name: "execute",
          input: { code: `return await tools.opencode.${name}(${JSON.stringify(input)})` },
        },
      })
    const run = (name: string, input: Record<string, unknown>, sessionID = caller.id) =>
      call(name, input, sessionID).pipe(
        Effect.map((result) => {
          const text = result.content?.[0]?.type === "text" ? result.content[0].text : ""
          if (result.metadata?.error) throw new Error(`${name}: ${text}`)
          return JSON.parse(text)
        }),
      )
    const sessionCount = () =>
      database.db
        .select()
        .from(SessionTable)
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.length),
        )
    return { alpha, beta, alphaID, betaID, caller, registry, sessions, location, database, call, run, sessionCount }
  })

it.live("child task instructions require contacting the parent before waiting", () =>
  Effect.gen(function* () {
    const fixture = yield* setup()
    const child = yield* fixture.sessions.taskCreate({ sessionID: fixture.caller.id, title: "Child" })
    const hooks = yield* PluginHooks.Service
    const request = (sessionID: Session.ID) => ({
      sessionID,
      agent: Agent.ID.make("build"),
      model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
      system: [],
      messages: [],
      options: {},
      tools: {},
    })

    for (const name of ["context", "compaction", "generate"] as const) {
      const childContext = yield* hooks.trigger("session", name, request(child.id))
      const text = childContext.system.map((part) => part.text).join("\n")
      expect(text).toContain(`persistent child task of ${fixture.caller.id}`)
      expect(text).toContain("use opencode.task_send to send the parent the question")
      expect(text).toContain("before ending or waiting")
      expect(text).toContain("If sending fails, report that the parent was not notified")
      expect(text).toContain("Before modifying a Git repository, assess whether isolation is needed")
      expect(text).toContain("use a dedicated worktree based on the required branch or commit")
      expect(text).toContain("If the correct base requires a parent decision, ask your parent rather than guessing")
      expect(text).toContain("The move takes effect at the next safe boundary")
      const rootContext = yield* hooks.trigger("session", name, request(fixture.caller.id))
      expect(rootContext.system.map((part) => part.text).join("\n")).not.toContain("This is a persistent child task")
      expect(rootContext.system.map((part) => part.text).join("\n")).not.toContain("Before modifying a Git repository")
    }
  }),
)

it.effect("lists real Projects by ID, name, and canonical directory", () =>
  Effect.gen(function* () {
    const { alpha, beta, alphaID, betaID, run } = yield* setup()
    const listed = yield* run("project_list", {})
    expect(listed.projects).toEqual(
      expect.arrayContaining([
        { id: alphaID, name: "Alpha One", canonical: alpha.path },
        { id: betaID, name: "Alpha Two", canonical: beta.path },
      ]),
    )
    expect(yield* run("project_list", { query: "one" })).toEqual({
      projects: [{ id: alphaID, name: "Alpha One", canonical: alpha.path }],
    })
    expect(yield* run("project_list", { query: "nomatch" })).toEqual({ projects: [] })
  }),
)

it.effect("creates a parentless session in the selected Project, admits the instruction, and starts execution", () =>
  Effect.gen(function* () {
    wakes.length = 0
    active.clear()
    approvals.length = 0
    reject = false
    const { alpha, alphaID, caller, sessions, location, database, run, sessionCount } = yield* setup()
    const model = Model.Ref.parse("openai/example#high")
    yield* sessions.switchModel({ sessionID: caller.id, model })
    const created = yield* run("session_create", {
      projectID: alphaID,
      title: "Task A",
      prompt: "Do the thing",
    })
    expect(created).toMatchObject({
      status: "created",
      project: { id: alphaID, name: "Alpha One", canonical: alpha.path },
      title: "Task A",
      execution: "running",
    })
    expect(created.sessionID).toMatch(/^ses_/)
    expect(typeof created.admitted).toBe("string")
    expect(wakes).toContain(created.sessionID)
    expect(approvals).toContainEqual(
      expect.objectContaining({
        action: "opencode_session_create",
        resources: [alphaID],
        save: [alphaID],
      }),
    )

    const session = yield* sessions.get(created.sessionID)
    expect(session.parentID).toBeUndefined()
    expect(session.title).toBe("Task A")
    expect(session.model).toEqual(model)
    expect(session.projectID).toBe(alphaID)
    expect(session.location.directory).toBe(AbsolutePath.make(alpha.path))
    expect(session.location.directory).not.toBe(location.directory)

    const inbox = yield* SessionInbox.find(database.db, created.admitted)
    expect(inbox).toMatchObject({
      type: "user",
      sessionID: created.sessionID,
      payload: { text: expect.stringContaining("Do the thing") },
    })
    expect(yield* sessionCount()).toBe(2) // the caller plus the new independent session
  }),
)

it.effect("resolves a unique Project name and refuses ambiguous, missing, or unknown selections", () =>
  Effect.gen(function* () {
    wakes.length = 0
    active.clear()
    approvals.length = 0
    reject = false
    const { beta, alphaID, betaID, sessions, run, call, sessionCount } = yield* setup()
    const before = yield* sessionCount()

    const named = yield* run("session_create", { project: "Alpha Two", title: "Named", prompt: "Second task" })
    expect(named.status).toBe("created")
    expect(named.project).toEqual({ id: betaID, name: "Alpha Two", canonical: beta.path })
    expect((yield* sessions.get(named.sessionID)).location.directory).toBe(AbsolutePath.make(beta.path))

    const ambiguous = yield* run("session_create", { project: "Alpha", title: "Ambiguous", prompt: "Ambiguous" })
    expect(ambiguous.status).toBe("select_project")
    expect(ambiguous.candidates).toHaveLength(2)
    expect(ambiguous.candidates.map((candidate: { id: string }) => candidate.id)).toEqual(
      expect.arrayContaining([alphaID, betaID]),
    )
    expect(ambiguous.message).toMatch(/projectID/)

    const missing = yield* run("session_create", { project: "nomatch", title: "Nope", prompt: "Nope" })
    expect(missing.status).toBe("select_project")
    expect(missing.candidates).toEqual([])

    const unspecified = yield* run("session_create", { title: "Nope", prompt: "Nope" })
    expect(unspecified.status).toBe("select_project")
    expect(unspecified.candidates.length).toBeGreaterThanOrEqual(2)

    const unknown = yield* call("session_create", { projectID: "prj_missing", title: "Nope", prompt: "Nope" })
    expect(unknown).toMatchObject({ metadata: { error: true } })

    expect(yield* sessionCount()).toBe(before + 1)
  }),
)

it.effect("uses an explicitly selected chat model and rejects invalid references before creating a session", () =>
  Effect.gen(function* () {
    const { alphaID, sessions, run, call, sessionCount } = yield* setup()
    const providers = yield* Provider.Service
    yield* providers.transform((editor) => {
      editor.models.update(Provider.ID.make("test"), Model.ID.make("override"), (model) => {
        model.variants = [{ id: Model.VariantID.make("fast") }]
      })
    })
    const before = yield* sessionCount()
    const created = yield* run("session_create", {
      projectID: alphaID,
      title: "Override",
      prompt: "Do the thing",
      model: "test/override#fast",
    })
    expect((yield* sessions.get(created.sessionID)).model).toEqual(Model.Ref.parse("test/override#fast"))
    for (const model of ["invalid", "test/missing", "test/override#slow"]) {
      const result = yield* call("session_create", { projectID: alphaID, title: "Invalid", prompt: "Nope", model })
      expect(result).toMatchObject({ metadata: { error: true } })
    }
    expect(yield* sessionCount()).toBe(before + 1)
  }),
)

it.effect("applies normal permission approval before creating anything", () =>
  Effect.gen(function* () {
    wakes.length = 0
    active.clear()
    approvals.length = 0
    const { alphaID, call, sessionCount } = yield* setup()
    const before = yield* sessionCount()
    reject = true
    const denied = yield* call("session_create", { projectID: alphaID, title: "Denied", prompt: "Denied" })
    expect(denied).toMatchObject({ metadata: { error: true } })
    expect(denied).toMatchObject({ content: [{ type: "text", text: expect.stringContaining("declined") }] })
    expect(yield* sessionCount()).toBe(before)
    expect(wakes).toHaveLength(0)
    reject = false
  }),
)

it.live(
  "persistent tasks form a durable tree, stay interactive, and exchange attributed messages without duplicates",
  () =>
    Effect.gen(function* () {
      reject = false
      wakes.length = 0
      active.clear()
      const fixture = yield* setup()
      const child = yield* fixture.run("task_create", {
        title: "Implementation",
        prompt: "Implement the requested feature",
      })
      const task = yield* fixture.sessions.get(child.sessionID)
      expect(task.parentID).toBeUndefined()
      expect(task.experimental?.taskParentID).toBe(fixture.caller.id)
      expect(task.location).toEqual(fixture.caller.location)
      expect(wakes).toContain(task.id)
      const grandchild = yield* fixture.sessions.taskCreate({ sessionID: task.id, title: "Regression tests" })
      const subagent = yield* fixture.sessions.create({ parentID: task.id, title: "Temporary search" })
      const unrelated = yield* fixture.sessions.create({ location: task.location, title: "Other task" })
      const expected = [fixture.caller.id, task.id, grandchild.id].sort()
      expect((yield* fixture.sessions.taskTree(grandchild.id)).map((item) => item.id).sort()).toEqual(expected)
      expect((yield* fixture.run("task_tree", {})).tasks.map((item: { id: string }) => item.id).sort()).toEqual(
        expected,
      )

      const sent = yield* fixture.run("task_send", { targetID: task.id, text: "Use option A" })
      const pending = yield* SessionInbox.find(fixture.database.db, sent.admitted)
      expect(pending).toMatchObject({
        type: "synthetic",
        payload: {
          metadata: { source: "task", fromSessionID: fixture.caller.id, toSessionID: task.id, text: "Use option A" },
        },
      })
      yield* fixture.sessions.taskMessage({
        sessionID: fixture.caller.id,
        targetID: task.id,
        id: sent.admitted,
        text: "Ignored retry payload",
      })
      const outgoing = yield* fixture.sessions.taskMessages(fixture.caller.id)
      expect(outgoing).toHaveLength(1)
      expect(outgoing[0]).toMatchObject({
        from: fixture.caller.id,
        to: task.id,
        text: "Use option A",
        state: "pending",
      })
      expect(yield* fixture.sessions.taskMessages(task.id)).toEqual(outgoing)
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: task.id, inboxID: sent.admitted })
      expect((yield* fixture.sessions.taskMessages(fixture.caller.id))[0]?.state).toBe("delivered")
      const reply = yield* fixture.run(
        "task_send",
        { targetID: fixture.caller.id, text: "Finished implementation" },
        task.id,
      )
      expect((yield* fixture.sessions.taskMessages(task.id)).map((message) => message.text)).toEqual([
        "Use option A",
        "Finished implementation",
      ])
      expect(wakes).toContain(fixture.caller.id)
      expect(reply.targetID).toBe(fixture.caller.id)
      expect(
        yield* fixture.sessions
          .taskMessage({ sessionID: grandchild.id, targetID: fixture.caller.id, text: "Skip parent" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Session.TaskRelationError)
      expect(
        yield* fixture.sessions
          .taskMessage({ sessionID: unrelated.id, targetID: task.id, text: "Unrelated" })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Session.TaskRelationError)
      expect(
        yield* fixture.sessions.taskCreate({ sessionID: subagent.id, title: "Not allowed" }).pipe(Effect.flip),
      ).toBeInstanceOf(Session.TaskRelationError)
      const id = Session.ID.create()
      const once = yield* fixture.sessions.taskCreate({ sessionID: task.id, title: "Retry", id })
      expect((yield* fixture.sessions.taskCreate({ sessionID: task.id, title: "Changed", id })).id).toBe(once.id)
      const descendant = yield* fixture.sessions.taskCreate({ sessionID: grandchild.id, title: "Follow-up" })
      expect(
        yield* fixture.sessions.taskCreate({ sessionID: unrelated.id, title: "Reuse", id }).pipe(Effect.flip),
      ).toBeInstanceOf(Session.TaskRelationError)
      yield* fixture.sessions.remove(task.id)
      expect((yield* fixture.sessions.taskTree(fixture.caller.id)).map((item) => item.id)).toEqual([fixture.caller.id])
      expect((yield* fixture.sessions.get(grandchild.id)).experimental?.taskParentID).toBeUndefined()
      expect((yield* fixture.sessions.taskTree(grandchild.id)).map((item) => item.id).sort()).toEqual(
        [grandchild.id, descendant.id].sort(),
      )
      expect((yield* fixture.sessions.get(descendant.id)).experimental?.taskParentID).toBe(grandchild.id)
      expect((yield* fixture.sessions.get(once.id)).experimental?.taskParentID).toBeUndefined()
      const events = yield* fixture.database.db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, grandchild.id))
        .all()
        .pipe(Effect.orDie)
      expect(events.map((event) => event.type)).toContain(Bus.versionedType(SessionEvent.TaskDetached.type, 1))
    }),
)
