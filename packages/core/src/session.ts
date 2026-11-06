export * as Session from "./session.js"
export * from "./session/schema.js"

import { Clock, DateTime, Effect, Layer, Context, Option, Schema, Stream } from "effect"
import { LLMClient } from "@opencode/ai/effect"
import { ListAnchor, ListCursor, ListFilter } from "@opencode/schema/session"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { SessionTask } from "@opencode/schema/session-task"
import { Project } from "./project.js"
import { Model } from "@opencode/schema/model"
import { Location } from "./location.js"
import type { FileSystem } from "./filesystem.js"
import { SessionMessage } from "./session/message.js"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Bus } from "./bus.js"
import { Instance } from "./instance/service.js"
import { Database } from "./database/database.js"
import { SessionProjector } from "./session/projector.js"
import { SessionInboxTable, SessionMessageTable, SessionTable } from "./session/sql.js"
import { SessionBlob } from "./session/blob.js"
import { SessionSchema } from "./session/schema.js"
import { RelativePath } from "./schema.js"
import { Agent } from "@opencode/schema/agent"
import type { Permission } from "@opencode/schema/permission"
import { App } from "./app.js"
import { Slug } from "./util/slug.js"
import path from "path"
import { SessionRunner } from "./session/runner/index.js"
import { SessionStore } from "./session/store.js"
import { SessionExecution } from "./session/execution.js"
import {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  InvalidListCursorError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
} from "./session/error.js"
import { Node } from "@opencode/util/effect/app-node"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { SessionEvent } from "./session/event.js"
import { SessionInbox } from "./session/inbox.js"
import { InstructionState } from "./session/instruction-state.js"
import { SessionGenerate } from "./session/generate.js"
import { SessionCommand } from "./session/command.js"
import {
  SessionMove,
  DestinationNotFoundError,
  DestinationNotDirectoryError,
  DestinationUnavailableError,
} from "./session/move.js"
import { SessionModelTransport } from "./session/model-transport.js"
import { llmClient } from "./effect/app-node-platform.js"
import { Snapshot } from "./snapshot.js"
import { Session } from "./session/session.js"
import { SessionDiff, TurnRangeError } from "./session/diff.js"
import { LocationServiceMap } from "./location-service-map.js"
import { FSUtil } from "@opencode/util/fs-util"
import type { EventLog } from "@opencode/schema/event-log"
import type { FileDiff } from "@opencode/schema/file-diff"
import { Job } from "./job.js"
import type { Command } from "./command.js"
import { SessionEnvironment } from "./session/environment.js"
import { InstructionEntry } from "./session/instruction-entry.js"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor, ListCursor }

export const ListInput = SessionStore.ListInput
export type ListInput = SessionStore.ListInput

const DefaultListLimit = 50

type CreateBaseInput = {
  id?: SessionSchema.ID
  title?: string
  agent?: Agent.ID
  model?: Model.Ref
  metadata?: SessionSchema.Metadata
  permissions?: Permission.Ruleset
}
type CreateInput = CreateBaseInput &
  (
    | { location: Location.Ref; parentID?: never; taskParentID?: never }
    | { parentID: SessionSchema.ID; location?: never; taskParentID?: never }
    | { taskParentID: SessionSchema.ID; parentID?: never; location?: never }
  )

export class TaskRelationError extends Schema.TaggedError<TaskRelationError>()("Session.TaskRelationError", {
  message: Schema.String,
}) {}

type CompactInput = Parameters<Session.Handle["compact"]>[0] & { sessionID: SessionSchema.ID }

type ForkInput = {
  sessionID: SessionSchema.ID
  before?: SessionMessage.ID
}

export {
  AttachmentError,
  BusyError,
  CompactionConflictError,
  ForkEmptyError,
  InboxConflictError,
  InvalidListCursorError,
  MessageDecodeError,
  MessageNotFoundError,
  NotFoundError,
  PromptConflictError,
  SkillNotFoundError,
  SyntheticConflictError,
}
type InboxItemRef = { readonly sessionID: SessionSchema.ID; readonly inboxID: SessionMessage.ID }

export { DestinationNotFoundError, DestinationNotDirectoryError, DestinationUnavailableError }
export { TurnRangeError }

export interface Interface {
  /** A cursor carries the filters of the request that produced it, so filters passed with a cursor are ignored. */
  readonly list: (input?: ListFilter & { readonly limit?: number; readonly cursor?: ListCursor }) => Effect.Effect<
    {
      readonly data: SessionSchema.Info[]
      readonly cursor: { readonly previous?: ListCursor; readonly next?: ListCursor }
    },
    InvalidListCursorError
  >
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly taskTree: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info[], NotFoundError>
  readonly taskMessages: (sessionID: SessionSchema.ID) => Effect.Effect<SessionTask.Message[], NotFoundError>
  readonly taskCreate: (input: {
    readonly sessionID: SessionSchema.ID
    readonly title: string
    readonly id?: SessionSchema.ID
  }) => Effect.Effect<SessionSchema.Info, NotFoundError | TaskRelationError>
  readonly taskMessage: (input: {
    readonly sessionID: SessionSchema.ID
    readonly targetID: SessionSchema.ID
    readonly text: string
    readonly id?: SessionMessage.ID
  }) => Effect.Effect<SessionInbox.Synthetic, NotFoundError | TaskRelationError | SyntheticConflictError>
  readonly fork: (
    input: ForkInput,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | MessageNotFoundError | ForkEmptyError>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly environment: (input: {
    readonly sessionID: SessionSchema.ID
    readonly variables?: SessionEnvironment.Variables
  }) => Effect.Effect<SessionEnvironment.Variables | undefined, NotFoundError>
  readonly view: (input: { sessionID: SessionSchema.ID; idle: number }) => Effect.Effect<void, NotFoundError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly messages: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Info | undefined>
  /** Experimental: {@link Interface.messages} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  readonly messagesWithRefs: (
    input: SessionStore.MessagesInput,
  ) => Effect.Effect<SessionMessage.MediaInfo[], NotFoundError | MessageDecodeError>
  /** Experimental: {@link Interface.message} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  readonly messageWithRefs: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.MediaInfo | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Info[], NotFoundError | MessageDecodeError>
  /** Structured diffs of the files changed by a turn or range of turns; see `SessionDiff.turn`. */
  readonly diff: (input: {
    readonly sessionID: SessionSchema.ID
    readonly from?: SessionMessage.ID
    readonly to?: SessionMessage.ID
    readonly context?: number
  }) => Effect.Effect<
    readonly FileDiff.Info[],
    NotFoundError | MessageNotFoundError | TurnRangeError | Snapshot.Error | FileSystem.DirectoryNotFoundError
  >
  /**
   * Durable admitted session work not yet visible in projected history,
   * ordered by admission. Includes unpromoted user and synthetic inputs and
   * unhandled compaction barriers.
   */
  readonly inbox: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.Info[], NotFoundError>
  /** Experimental: {@link Interface.inbox} with files stored in `blob` left as `media:` refs when the session's location enables `experimental.media_blob`. */
  readonly inboxWithRefs: (sessionID: SessionSchema.ID) => Effect.Effect<SessionInbox.MediaInfo[], NotFoundError>
  readonly cancelInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly steerInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  readonly queueInbox: (input: InboxItemRef) => Effect.Effect<void, NotFoundError | InboxConflictError>
  /**
   * Durable, ordered session log read. Replays durable session bus after
   * the exclusive `after` cursor, emits a `Synced` marker at the captured
   * replay watermark, then continues live when `follow` is set.
   * The marker's seq may exceed the last emitted event because other durable
   * bus share the aggregate's sequence space.
   */
  readonly log: (input: {
    sessionID: SessionSchema.ID
    after?: number
    follow?: boolean
  }) => Stream.Stream<SessionEvent.DurableEvent | EventLog.Synced, NotFoundError>
  readonly switchAgent: (input: { sessionID: SessionSchema.ID; agent: Agent.ID }) => Effect.Effect<void, NotFoundError>
  readonly switchModel: (input: { sessionID: SessionSchema.ID; model: Model.Ref }) => Effect.Effect<void, NotFoundError>
  readonly rename: (input: { sessionID: SessionSchema.ID; title: string }) => Effect.Effect<void, NotFoundError>
  readonly archive: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly unarchive: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly setMetadata: (input: {
    sessionID: SessionSchema.ID
    metadata: SessionSchema.Metadata
  }) => Effect.Effect<void, NotFoundError>
  readonly setPermissions: (input: {
    sessionID: SessionSchema.ID
    permissions: Permission.Ruleset
  }) => Effect.Effect<void, NotFoundError>
  readonly move: SessionMove.Interface["move"]
  readonly prompt: (
    input: Parameters<Session.Handle["prompt"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["prompt"]>
  /** Generates text from current Session context without admitting input or mutating history. */
  readonly generate: (input: {
    sessionID: SessionSchema.ID
    prompt: string
  }) => Effect.Effect<string, NotFoundError | SessionGenerate.Error>
  readonly command: (input: {
    sessionID: SessionSchema.ID
    command: string
    text: string
    files?: PromptInput.Prompt["files"]
    agents?: PromptInput.Prompt["agents"]
    skills?: PromptInput.Prompt["skills"]
    delivery?: SessionInbox.Delivery
  }) => Effect.Effect<
    void,
    NotFoundError | Command.NotFoundError | Command.ExecutionError | FileSystem.DirectoryNotFoundError
  >
  readonly shell: (
    input: Parameters<Session.Handle["shell"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["shell"]>
  readonly skill: (
    input: Parameters<Session.Handle["skill"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["skill"]>
  readonly compact: (
    input: CompactInput,
  ) => Effect.Effect<SessionInbox.Compaction, NotFoundError | CompactionConflictError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly background: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly resume?: boolean }) => Effect.Effect<boolean>
  readonly synthetic: (
    input: Parameters<Session.Handle["synthetic"]>[0] & { sessionID: SessionSchema.ID },
  ) => ReturnType<Session.Handle["synthetic"]>
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<
      SessionSchema.Revert,
      NotFoundError | MessageNotFoundError | BusyError | Snapshot.Error | FileSystem.DirectoryNotFoundError
    >
    readonly clear: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<void, NotFoundError | BusyError | Snapshot.Error | FileSystem.DirectoryNotFoundError>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | BusyError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const app = yield* App.Metadata
    const database = yield* Database.Service
    const db = database.db
    const bus = yield* Bus.Service
    const projects = yield* Project.Service
    const execution = yield* SessionExecution.Service
    const llm = yield* LLMClient.Service
    const transport = yield* SessionModelTransport.Service
    const store = yield* SessionStore.Service
    const instances = yield* Instance.Service
    const moves = yield* SessionMove.Service
    const jobs = yield* Job.Service
    const environments = yield* SessionEnvironment.Service
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.make()
    const mediaBlob = (session: SessionSchema.Info) => SessionBlob.enabledFor(instances, app, session)
    const isDurableSessionEvent = (item: Bus.LogItem): item is SessionEvent.DurableEvent =>
      Object.hasOwn(SessionEvent.Durable.cases, item.type)

    const result = Service.of({
      create: Effect.fn("Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const recorded = yield* store.get(sessionID)
        if (recorded) return recorded
        const parentID = input.parentID ?? input.taskParentID
        const parent = parentID ? yield* store.get(parentID) : undefined
        if (parentID && parent === undefined) return yield* new NotFoundError({ sessionID: parentID })
        const location = parent?.location ?? (input.location && LocationServiceMap.canonical(input.location))
        if (location === undefined)
          return yield* Effect.die(new Error("Session.create requires either location or an existing parentID"))
        const project = yield* projects.resolve(location.directory)
        const projected = yield* bus
          .publish(
            SessionEvent.Created,
            {
              sessionID,
              slug: Slug.create(),
              version: app.version,
              projectID: project.id,
              parentID: input.parentID,
              taskParentID: input.taskParentID,
              location,
              subpath: RelativePath.make(path.relative(project.directory, location.directory).replaceAll("\\", "/")),
              title: input.title,
              agent: input.agent,
              // Children inherit metadata and permissions the way they inherit
              // location, so host policies that read them treat the family uniformly.
              metadata: input.metadata ?? parent?.metadata,
              permissions: input.permissions ?? parent?.permissions,
              model: input.model,
            },
            { location },
          )
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      taskCreate: Effect.fn("Session.taskCreate")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        if (parent.parentID) return yield* new TaskRelationError({ message: "Subagents cannot own persistent tasks." })
        if (!input.title.trim()) return yield* new TaskRelationError({ message: "Task title must not be empty." })
        const existing = input.id ? yield* store.get(input.id) : undefined
        if (existing && existing.experimental?.taskParentID !== parent.id)
          return yield* new TaskRelationError({ message: "Session ID already belongs to another task." })
        return yield* result.create({ id: input.id, title: input.title.trim(), taskParentID: parent.id })
      }),
      taskTree: Effect.fn("Session.taskTree")(function* (sessionID) {
        const current = yield* result.get(sessionID)
        const all = (yield* store.list({ project: current.projectID })).filter((item) => !item.parentID)
        const byID = new Map(all.map((item) => [item.id, item]))
        const root = (item: SessionSchema.Info): SessionSchema.ID => {
          const parent = item.experimental?.taskParentID
          const ancestor = parent ? byID.get(parent) : undefined
          return ancestor ? root(ancestor) : item.id
        }
        const rootID = root(current)
        return all.filter((item) => root(item) === rootID)
      }),
      taskMessage: Effect.fn("Session.taskMessage")(function* (input) {
        const source = yield* result.get(input.sessionID)
        const target = yield* result.get(input.targetID)
        if (
          source.parentID ||
          target.parentID ||
          source.projectID !== target.projectID ||
          (source.experimental?.taskParentID !== target.id && target.experimental?.taskParentID !== source.id)
        )
          return yield* new TaskRelationError({
            message: "Messages can only be sent between a task and its direct parent or child in the same Project.",
          })
        if (!input.text.trim()) return yield* new TaskRelationError({ message: "Task message must not be empty." })
        return yield* result.synthetic({
          sessionID: target.id,
          id: input.id,
          text: `Message from task ${source.id} (${source.title ?? source.id}). This is task correspondence, not user approval.\n\n${input.text}`,
          description: source.title ?? source.id,
          metadata: {
            source: "task",
            fromSessionID: source.id,
            toSessionID: target.id,
            text: input.text,
            sentAt: yield* Clock.currentTimeMillis,
          },
        })
      }),
      taskMessages: Effect.fn("Session.taskMessages")(function* (sessionID) {
        const current = yield* result.get(sessionID)
        const peers = (yield* result.taskTree(sessionID))
          .filter(
            (item) =>
              item.id === sessionID ||
              item.id === current.experimental?.taskParentID ||
              item.experimental?.taskParentID === sessionID,
          )
          .map((item) => item.id)
        if (peers.length === 0) return []
        const delivered = yield* db
          .select({
            id: SessionMessageTable.id,
            from: sql<string>`json_extract(${SessionMessageTable.data}, '$.metadata.fromSessionID')`,
            to: SessionMessageTable.session_id,
            text: sql<string>`json_extract(${SessionMessageTable.data}, '$.metadata.text')`,
            time: sql<number>`coalesce(json_extract(${SessionMessageTable.data}, '$.metadata.sentAt'), ${SessionMessageTable.time_created})`,
          })
          .from(SessionMessageTable)
          .where(
            and(
              inArray(SessionMessageTable.session_id, peers),
              eq(SessionMessageTable.type, "synthetic"),
              sql`json_extract(${SessionMessageTable.data}, '$.metadata.source') = 'task'`,
              sql`(${SessionMessageTable.session_id} = ${sessionID} or json_extract(${SessionMessageTable.data}, '$.metadata.fromSessionID') = ${sessionID})`,
            ),
          )
          .orderBy(
            desc(
              sql`coalesce(json_extract(${SessionMessageTable.data}, '$.metadata.sentAt'), ${SessionMessageTable.time_created})`,
            ),
            desc(SessionMessageTable.id),
          )
          .limit(100)
          .all()
          .pipe(Effect.orDie)
        const pending = yield* db
          .select({
            id: SessionInboxTable.id,
            from: sql<string>`json_extract(${SessionInboxTable.payload}, '$.metadata.fromSessionID')`,
            to: SessionInboxTable.session_id,
            text: sql<string>`json_extract(${SessionInboxTable.payload}, '$.metadata.text')`,
            time: sql<number>`coalesce(json_extract(${SessionInboxTable.payload}, '$.metadata.sentAt'), ${SessionInboxTable.time_created})`,
          })
          .from(SessionInboxTable)
          .where(
            and(
              inArray(SessionInboxTable.session_id, peers),
              eq(SessionInboxTable.type, "synthetic"),
              sql`json_extract(${SessionInboxTable.payload}, '$.metadata.source') = 'task'`,
              sql`(${SessionInboxTable.session_id} = ${sessionID} or json_extract(${SessionInboxTable.payload}, '$.metadata.fromSessionID') = ${sessionID})`,
            ),
          )
          .orderBy(
            desc(
              sql`coalesce(json_extract(${SessionInboxTable.payload}, '$.metadata.sentAt'), ${SessionInboxTable.time_created})`,
            ),
            desc(SessionInboxTable.id),
          )
          .limit(100)
          .all()
          .pipe(Effect.orDie)
        const decode = Schema.decodeUnknownOption(SessionTask.Message)
        return [
          ...new Map(
            [
              ...pending.map((item) => ({ ...item, state: "pending" })),
              ...delivered.map((item) => ({ ...item, state: "delivered" })),
            ].map((item) => [item.id, item]),
          ).values(),
        ]
          .toSorted((a, b) => a.time - b.time || a.id.localeCompare(b.id))
          .slice(-100)
          .flatMap((item) => Option.toArray(decode(item)))
      }),
      fork: Effect.fn("Session.fork")(function* (input) {
        const parent = yield* result.get(input.sessionID)
        const boundary = yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.sessionID),
              input.before ? eq(SessionMessageTable.id, input.before) : undefined,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        if (!boundary && input.before)
          return yield* new MessageNotFoundError({
            sessionID: input.sessionID,
            messageID: input.before,
          })
        if (!boundary) return yield* new ForkEmptyError({ sessionID: input.sessionID })
        const sessionID = SessionSchema.ID.create()
        const inherited = yield* db
          .transaction(() =>
            Effect.all({
              instructions: InstructionState.current(db, parent.id),
              instructionEntries: InstructionEntry.snapshot(db, parent.id),
            }),
          )
          .pipe(Effect.orDie)
        // The fork adopts the parent's newest instruction values rather than the
        // values in effect at the boundary; copied history may contain frozen
        // instruction-update text the initial baseline already reflects.
        // The parent's location, not the caller's, decides whether the copy's media is stored as blobs.
        const media = yield* mediaBlob(parent)
        yield* bus
          .publish(SessionEvent.Forked, {
            sessionID,
            parentID: parent.id,
            boundary: { type: input.before ? "before" : "through", messageID: boundary.id },
            ...inherited,
          })
          .pipe(Effect.provideService(SessionBlob.ForkMedia, media))
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: (sessionID) => sessions.forSession(sessionID).get(),
      environment: Effect.fn("Session.environment")(function* (input) {
        yield* result.get(input.sessionID)
        if (input.variables !== undefined) yield* environments.set(input.sessionID, input.variables)
        return yield* environments.get(input.sessionID)
      }),
      view: (input) => sessions.forSession(input.sessionID).view(input),
      remove: Effect.fn("Session.remove")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.interrupt(sessionID)
        yield* execution.awaitIdle(sessionID)
        yield* jobs.cancelSession(sessionID)
        yield* transport.close(sessionID)
        const children = yield* store.list({ parentID: sessionID })
        yield* Effect.forEach(children, (child) => result.remove(child.id), { concurrency: 1, discard: true })
        const tasks = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.task_parent_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        yield* Effect.forEach(tasks, (task) => result.remove(task.id), { concurrency: 1, discard: true })
        yield* environments.clear(sessionID)
        yield* bus.publish(SessionEvent.Deleted, { sessionID })
        yield* bus.remove(sessionID)
      }),
      list: Effect.fn("Session.list")(function* (input = {}) {
        const filter =
          input.cursor === undefined
            ? input
            : yield* ListCursor.parse(input.cursor).pipe(Effect.mapError(() => new InvalidListCursorError()))
        const data = yield* store.list({ ...filter, limit: input.limit ?? DefaultListLimit })
        const first = data[0]
        const last = data.at(-1)
        return {
          data,
          cursor: {
            previous: first
              ? ListCursor.make({
                  ...filter,
                  anchor: { id: first.id, time: DateTime.toEpochMillis(first.time.updated), direction: "previous" },
                })
              : undefined,
            next: last
              ? ListCursor.make({
                  ...filter,
                  anchor: { id: last.id, time: DateTime.toEpochMillis(last.time.updated), direction: "next" },
                })
              : undefined,
          },
        }
      }),
      messages: Effect.fn("Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* store.messages(input)
      }),
      message: (input) => sessions.forSession(input.sessionID).message(input.messageID),
      messagesWithRefs: Effect.fn("Session.messagesWithRefs")(function* (input) {
        const session = yield* result.get(input.sessionID)
        if (!(yield* mediaBlob(session))) return yield* store.messages(input)
        return yield* store.messagesWithRefs(input)
      }),
      messageWithRefs: Effect.fn("Session.messageWithRefs")(function* (input) {
        const session = yield* result.get(input.sessionID).pipe(Effect.option)
        if (Option.isNone(session)) return undefined
        if (!(yield* mediaBlob(session.value))) return yield* result.message(input)
        const stored = yield* store.messageWithRefs(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      diff: Effect.fn("Session.diff")(function* (input) {
        const session = yield* result.get(input.sessionID)
        const active = yield* execution.isActive(input.sessionID)
        return yield* SessionDiff.turn(db, locations, {
          session,
          active,
          from: input.from,
          to: input.to,
          context: input.context,
        })
      }),
      inbox: (sessionID) => sessions.forSession(sessionID).inbox(),
      inboxWithRefs: Effect.fn("Session.inboxWithRefs")(function* (sessionID) {
        const session = yield* result.get(sessionID)
        if (!(yield* mediaBlob(session))) return yield* result.inbox(sessionID)
        return yield* SessionInbox.listWithRefs(db, sessionID)
      }),
      cancelInbox: (input) => sessions.forSession(input.sessionID).cancelInbox(input.inboxID),
      steerInbox: (input) => sessions.forSession(input.sessionID).steerInbox(input.inboxID),
      queueInbox: (input) => sessions.forSession(input.sessionID).queueInbox(input.inboxID),
      log: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(bus.log({ aggregateID: input.sessionID, after: input.after, follow: input.follow }))),
        ).pipe(
          Stream.filter(
            (item): item is SessionEvent.DurableEvent | EventLog.Synced =>
              Bus.isSynced(item) || isDurableSessionEvent(item),
          ),
        ),
      prompt: (input) => sessions.forSession(input.sessionID).prompt(input),
      generate: Effect.fn("Session.generate")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionGenerate.generate({ session, prompt: input.prompt }).pipe(
          Effect.provideService(Instance.Service, instances),
          Effect.provideService(Database.Service, database),
          Effect.provideService(LLMClient.Service, llm),
        )
      }),
      command: Effect.fn("Session.command")(function* (input) {
        const session = yield* result.get(input.sessionID)
        return yield* SessionCommand.execute({ ...input, session }).pipe(
          Effect.provideService(Instance.Service, instances),
        )
      }),
      shell: (input) => sessions.forSession(input.sessionID).shell(input),
      skill: (input) => sessions.forSession(input.sessionID).skill(input),
      switchAgent: (input) => sessions.forSession(input.sessionID).switchAgent(input),
      switchModel: (input) => sessions.forSession(input.sessionID).switchModel(input),
      rename: (input) => sessions.forSession(input.sessionID).rename(input),
      archive: (sessionID) => sessions.forSession(sessionID).archive(),
      unarchive: (sessionID) => sessions.forSession(sessionID).unarchive(),
      setMetadata: (input) => sessions.forSession(input.sessionID).setMetadata(input),
      setPermissions: (input) => sessions.forSession(input.sessionID).setPermissions(input),
      move: moves.move,
      compact: (input) => sessions.forSession(input.sessionID).compact(input),
      wait: (sessionID) => sessions.forSession(sessionID).wait(),
      active: execution.active,
      background: Effect.fn("Session.background")(function* (sessionID) {
        yield* result.get(sessionID)
        const backgrounded = yield* jobs.backgroundAll({ sessionID })
        if (backgrounded.length === 0) return
        yield* result
          .synthetic({
            sessionID,
            text: [
              "User requested that active blocking work be moved to the background.",
              "",
              "Backgrounded work:",
              ...backgrounded.map((job) => `- ${job.type}: ${job.title && job.title.length > 0 ? job.title : job.id}`),
              "",
              "The backgrounded work is still unfinished. Move on to other work if you can. If there is nothing else useful to do, finish your response. Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation.",
            ].join("\n"),
          })
          .pipe(Effect.catchTag("Session.SyntheticConflictError", Effect.die))
      }),
      resume: (sessionID) => sessions.forSession(sessionID).resume(),
      synthetic: (input) => sessions.forSession(input.sessionID).synthetic(input),
      interrupt: (sessionID, options) => sessions.forSession(sessionID).interrupt(options),
      revert: {
        stage: (input) => sessions.forSession(input.sessionID).revert.stage(input),
        clear: (sessionID) => sessions.forSession(sessionID).revert.clear(),
        commit: (sessionID) => sessions.forSession(sessionID).revert.commit(),
      },
    })

    return result
  }),
)

export const node: LayerNode.Provider<Service, never, typeof Node.tags.values.global> = Node.makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Job.node,
    SessionEnvironment.node,
    Database.node,
    Bus.node,
    Project.node,
    SessionExecution.node,
    SessionModelTransport.node,
    llmClient,
    SessionStore.node,
    Instance.node,
    SessionInbox.node,
    SessionMove.node,
    SessionProjector.node,
    LocationServiceMap.node,
    FSUtil.node,
    App.node,
  ],
})
