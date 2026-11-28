export * as SidebarTools from "./sidebar.js"

import { randomUUID } from "node:crypto"
import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { Preference } from "@opencode/schema/preference"
import { comparablePath, containsDirectory, getFilename } from "@opencode/util/path"
import { DateTime, Effect, Option, Schema, Semaphore } from "effect"
import { Bus } from "../../bus.js"
import { KV } from "../../kv.js"
import { Project } from "../../project.js"
import { Session } from "../../session.js"
import { toolFailure } from "../runtime.js"

// The app's Projects sidebar keeps its layout in two shared preferences, stored where the preference API stores them
// (`preference:<key>` in KV). The shared copy names this server "sidecar" (`translateProjectSections` and
// `createSessionPins` in packages/app), so keys written here match the same project or session on every client.
const SERVER = "sidecar"
const SECTIONS = "sidebar.project-sections"
const PINS = "sidebar.recent"

type PreferenceKey = typeof Preference.Key.Type
type JsonObject = { readonly [key: string]: Schema.Json }

const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const Sorting = Schema.Literals(["updated", "name", "manual"])

const SectionsState = Schema.Struct({
  sections: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  order: Schema.Array(Schema.String),
  projects: Schema.Array(Schema.String),
  sorting: Schema.Record(Schema.String, Sorting),
  assignments: Schema.Record(Schema.String, Schema.String),
  collapsed: Schema.Record(Schema.String, Schema.Boolean),
  sessions: Schema.Record(Schema.String, Schema.Array(Schema.Struct({ id: Schema.String, updated: Schema.Number }))),
})
type SectionsState = typeof SectionsState.Type

const PinsState = Schema.Struct({ pins: Schema.Array(Schema.String) })

const emptySections: SectionsState = {
  sections: [],
  order: [],
  projects: [],
  sorting: {},
  assignments: {},
  collapsed: {},
  sessions: {},
}

const ProjectRef = Schema.String.annotate({ description: "Project ID or canonical directory, from sidebar.list." })

const SessionRow = Schema.Struct({
  id: Session.ID,
  title: Schema.String.pipe(Schema.optional),
  pinned: Schema.Boolean,
})

const ListOutput = Schema.Struct({
  sections: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: 'Section ID. "" is the default section, which cannot be deleted.' }),
      name: Schema.String.pipe(Schema.optional),
      collapsed: Schema.Boolean,
      sort: Sorting,
      projects: Schema.Array(
        Schema.Struct({
          projectID: Project.ID,
          name: Schema.String,
          directory: Schema.String,
          collapsed: Schema.Boolean,
          folders: Schema.Array(
            Schema.Struct({
              directory: Schema.String,
              worktree: Schema.Boolean.annotate({ description: "False for the project's own checkout." }),
              collapsed: Schema.Boolean.pipe(Schema.optional).annotate({
                description: "Worktree folders only. Absent means the app opens it while it holds the open session.",
              }),
              sessions: Schema.Array(SessionRow).annotate({ description: "Pinned first, in sidebar order." }),
              hidden: Schema.Int.annotate({ description: "Sessions beyond the limit." }),
            }),
          ),
        }),
      ),
    }),
  ),
})

export const Plugin = {
  id: "opencode.tool.sidebar",
  effect: Effect.fn("SidebarTools.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const bus = yield* Bus.Service
    const projects = yield* Project.Service
    const sessions = yield* Session.Service
    // Code Mode can run several edits at once; each reads and rewrites a whole preference.
    const lock = yield* Semaphore.make(1)

    const read = <A extends JsonObject>(key: PreferenceKey, schema: Schema.Codec<A, A>, initial: A) =>
      Effect.gen(function* () {
        const raw = yield* kv.get(storageKey(key))
        const stored = isJsonObject(raw) ? raw : {}
        const value = Schema.decodeUnknownOption(schema)({ ...initial, ...stored })
        if (Option.isNone(value))
          return yield* new ToolFailure({ message: `The stored ${key} preference is not in the expected format.` })
        return { stored, value: value.value }
      })

    const update = <A extends JsonObject>(
      key: PreferenceKey,
      schema: Schema.Codec<A, A>,
      initial: A,
      change: (value: A) => Effect.Effect<A, ToolFailure>,
    ) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* read(key, schema, initial)
          const next = yield* change(current.value)
          // Keep fields a newer app writes that this schema does not know.
          yield* kv.set(storageKey(key), { ...current.stored, ...Schema.encodeSync(schema)(next) })
          yield* bus.publish(Preference.Event.Updated, { key })
          return current.value
        }),
      )

    const updateSections = (change: (state: SectionsState) => Effect.Effect<SectionsState, ToolFailure>) =>
      update(SECTIONS, SectionsState, emptySections, change)

    const findProject = (ref: string) =>
      Effect.gen(function* () {
        const list = yield* projects.list({ archived: false })
        const project = list.find(
          (item) => item.id === ref || comparablePath(item.canonical) === comparablePath(ref.trim()),
        )
        if (!project) return yield* new ToolFailure({ message: `No project matches ${ref}. Use sidebar.list.` })
        return project
      })

    // The root sessions the app lists for a project: persistent tasks render under their parent instead.
    const rootSessions = (project: Project.Info) =>
      sessions
        .list({ project: project.id, parentID: null, archived: false, limit: 500 })
        .pipe(
          Effect.map((page) =>
            page.data.filter((session) => !session.experimental?.taskParentID && !session.time.archived),
          ),
        )

    const layout = Effect.gen(function* () {
      const state = (yield* read(SECTIONS, SectionsState, emptySections)).value
      const pins = (yield* read(PINS, PinsState, { pins: [] })).value.pins.flatMap((key) => {
        const [server, sessionID] = key.split("\u0000")
        return server === SERVER && sessionID ? [sessionID] : []
      })
      const items = yield* Effect.forEach(
        yield* projects.list({ archived: false }),
        (project) => rootSessions(project).pipe(Effect.map((list) => ({ project, list, key: projectKey(project) }))),
        { concurrency: 4 },
      )
      const sectionIDs = new Set(state.sections.map((section) => section.id))
      const sectionOf = (key: string) => {
        const id = state.assignments[key]
        return id !== undefined && sectionIDs.has(id) ? id : ""
      }
      const order = new Map(state.order.map((id, index) => [id, index]))
      const sections = [{ id: "", name: undefined }, ...state.sections].toSorted(
        (a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size),
      )
      const projectOrder = new Map(state.projects.map((key, index) => [key, index]))
      const collator = new Intl.Collator(undefined, { numeric: true })
      const sortFor = (id: string) =>
        state.sorting[id] ?? (state.projects.some((key) => sectionOf(key) === id) ? "manual" : "updated")
      const latest = (item: (typeof items)[number]) => Math.max(item.project.time.created, ...item.list.map(updatedAt))
      const projectsIn = (id: string) =>
        items
          .filter((item) => sectionOf(item.key) === id)
          .toSorted((a, b) => {
            const sort = sortFor(id)
            const delta =
              sort === "manual"
                ? (projectOrder.get(a.key) ?? projectOrder.size) - (projectOrder.get(b.key) ?? projectOrder.size)
                : sort === "updated"
                  ? latest(b) - latest(a)
                  : 0
            return delta || collator.compare(projectName(a.project), projectName(b.project))
          })
      return { state, pins, sections, sortFor, projectsIn }
    })

    yield* ctx.tool
      .transform((draft) => {
        draft.add({
          name: "list",
          description: [
            "List the Projects sidebar the app shows: sections, their projects, each project's worktree folders and root sessions, with pin and collapse state.",
            "Edit it with the other opencode.sidebar tools; the app updates live. Move a session to another folder or project with opencode.session.move, and create or remove worktree folders with opencode.worktree_create and opencode.worktree_remove.",
          ].join("\n"),
          input: Schema.Struct({
            project: ProjectRef.pipe(Schema.optional).annotate({ description: "Only this project." }),
            limit: Schema.Int.pipe(Schema.optional).annotate({ description: "Sessions per folder (default 10)." }),
          }),
          output: ListOutput,
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            Effect.gen(function* () {
              const view = yield* layout
              const only = input.project === undefined ? undefined : yield* findProject(input.project)
              const limit = Math.max(input.limit ?? 10, 0)
              const sections = view.sections.map((section) => ({
                id: section.id,
                ...(section.name === undefined ? {} : { name: section.name }),
                collapsed: !!view.state.collapsed[`section:${section.id}`],
                sort: view.sortFor(section.id),
                projects: view
                  .projectsIn(section.id)
                  .filter((item) => !only || item.project.id === only.id)
                  .map((item) => ({
                    projectID: item.project.id,
                    name: projectName(item.project),
                    directory: item.project.canonical,
                    collapsed: !!view.state.collapsed[`project:${item.key}`],
                    folders: folders(
                      item.project,
                      ordered(item.list, view.state.sessions[item.key] ?? [], view.pins),
                    ).map((folder) => {
                      const collapsed = view.state.collapsed[`worktree:${folderKey(folder.directory)}`]
                      return {
                        directory: folder.directory,
                        worktree: folder.directory !== item.project.canonical,
                        ...(folder.directory === item.project.canonical || collapsed === undefined
                          ? {}
                          : { collapsed }),
                        sessions: folder.sessions.slice(0, limit).map((session) => ({
                          id: session.id,
                          ...(session.title === undefined ? {} : { title: session.title }),
                          pinned: view.pins.includes(session.id),
                        })),
                        hidden: Math.max(folder.sessions.length - limit, 0),
                      }
                    }),
                  })),
              }))
              return {
                output: { sections: only ? sections.filter((section) => section.projects.length > 0) : sections },
              }
            }).pipe(Effect.mapError(toolFailure("Unable to read the sidebar"))),
        })
        draft.add({
          name: "section_create",
          description: "Create a sidebar section. It starts empty, after the existing sections.",
          input: Schema.Struct({ name: Schema.Trim.check(Schema.isNonEmpty()) }),
          output: Schema.Struct({ sectionID: Schema.String }),
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            Effect.gen(function* () {
              const sectionID = randomUUID()
              yield* updateSections((state) =>
                Effect.succeed({ ...state, sections: [...state.sections, { id: sectionID, name: input.name }] }),
              )
              return { output: { sectionID }, content: `Created section ${input.name} (${sectionID}).` }
            }).pipe(Effect.mapError(toolFailure(`Unable to create section ${input.name}`))),
        })
        draft.add({
          name: "section_rename",
          description: "Rename a sidebar section.",
          input: Schema.Struct({ sectionID: Schema.String, name: Schema.Trim.check(Schema.isNonEmpty()) }),
          output: Schema.Struct({ sectionID: Schema.String, name: Schema.String }),
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            updateSections((state) =>
              requireSection(state, input.sectionID).pipe(
                Effect.as({
                  ...state,
                  sections: state.sections.map((section) =>
                    section.id === input.sectionID ? { ...section, name: input.name } : section,
                  ),
                }),
              ),
            ).pipe(
              Effect.as({ output: { sectionID: input.sectionID, name: input.name } }),
              Effect.mapError(toolFailure(`Unable to rename section ${input.sectionID}`)),
            ),
        })
        draft.add({
          name: "section_delete",
          description:
            "Delete a sidebar section. Its projects return to the default section; no project, folder or session is deleted.",
          input: Schema.Struct({ sectionID: Schema.String }),
          output: Schema.Struct({ sectionID: Schema.String, projects: Schema.Int }),
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            Effect.gen(function* () {
              const previous = yield* updateSections((state) =>
                requireSection(state, input.sectionID).pipe(
                  Effect.as({
                    ...state,
                    sections: state.sections.filter((section) => section.id !== input.sectionID),
                    order: state.order.filter((id) => id !== input.sectionID),
                    sorting: omit(state.sorting, input.sectionID),
                    collapsed: omit(state.collapsed, `section:${input.sectionID}`),
                    assignments: Object.fromEntries(
                      Object.entries(state.assignments).filter(([, id]) => id !== input.sectionID),
                    ),
                  }),
                ),
              )
              const count = Object.values(previous.assignments).filter((id) => id === input.sectionID).length
              return {
                output: { sectionID: input.sectionID, projects: count },
                content: `Deleted section ${input.sectionID}; ${count} project(s) moved to the default section.`,
              }
            }).pipe(Effect.mapError(toolFailure(`Unable to delete section ${input.sectionID}`))),
        })
        draft.add({
          name: "section_move",
          description: 'Move a section to a zero-based position among the sections, including the default section "".',
          input: Schema.Struct({ sectionID: Schema.String, index: Schema.Int }),
          output: Schema.Struct({ order: Schema.Array(Schema.String) }),
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            Effect.gen(function* () {
              const view = yield* layout
              const ids = view.sections.map((section) => section.id)
              const source = ids.indexOf(input.sectionID)
              if (source < 0) return yield* missingSection(input.sectionID)
              const order = ids.toSpliced(source, 1).toSpliced(clamp(input.index, ids.length), 0, input.sectionID)
              yield* updateSections((state) => Effect.succeed({ ...state, order }))
              return { output: { order } }
            }).pipe(Effect.mapError(toolFailure(`Unable to move section ${input.sectionID}`))),
        })
        draft.add({
          name: "project_move",
          description:
            'Move a project to another section ("" is the default section) and/or to a zero-based position within its section. A position switches that section to manual ordering.',
          input: Schema.Struct({
            project: ProjectRef,
            sectionID: Schema.String.pipe(Schema.optional),
            index: Schema.Int.pipe(Schema.optional),
          }),
          output: Schema.Struct({ projectID: Project.ID, sectionID: Schema.String }),
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            Effect.gen(function* () {
              const project = yield* findProject(input.project)
              const key = projectKey(project)
              const view = yield* layout
              const sectionID =
                input.sectionID ??
                view.sections.find((section) => view.projectsIn(section.id).some((item) => item.key === key))?.id ??
                ""
              if (sectionID && !view.state.sections.some((section) => section.id === sectionID))
                return yield* missingSection(sectionID)
              const keys = view
                .projectsIn(sectionID)
                .map((item) => item.key)
                .filter((other) => other !== key)
              const index = input.index
              yield* updateSections((state) =>
                Effect.succeed({
                  ...state,
                  assignments: { ...state.assignments, [key]: sectionID },
                  collapsed: omit(state.collapsed, `section:${sectionID}`),
                  ...(index === undefined
                    ? {}
                    : {
                        projects: [
                          ...state.projects.filter((other) => other !== key && !keys.includes(other)),
                          ...keys.toSpliced(clamp(index, keys.length), 0, key),
                        ],
                        sorting: { ...state.sorting, [sectionID]: "manual" as const },
                      }),
                }),
              )
              return { output: { projectID: project.id, sectionID } }
            }).pipe(Effect.mapError(toolFailure(`Unable to move project ${input.project}`))),
        })
        draft.add({
          name: "pin",
          description:
            "Pin or unpin a root session. Pinned sessions lead their folder in the Projects sidebar and the Pinned list.",
          input: Schema.Struct({ sessionID: Session.ID, pinned: Schema.Boolean }),
          output: Schema.Struct({ sessionID: Session.ID, pinned: Schema.Boolean }),
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            Effect.gen(function* () {
              yield* sessions.get(input.sessionID)
              const key = `${SERVER}\u0000${input.sessionID}`
              yield* update(PINS, PinsState, { pins: [] }, (state) =>
                Effect.succeed({
                  pins: input.pinned
                    ? state.pins.includes(key)
                      ? state.pins
                      : [...state.pins, key]
                    : state.pins.filter((pin) => pin !== key),
                }),
              )
              return { output: input }
            }).pipe(Effect.mapError(toolFailure(`Unable to ${input.pinned ? "pin" : "unpin"} ${input.sessionID}`))),
        })
        draft.add({
          name: "collapse",
          description:
            "Collapse or expand a sidebar section (by section ID), project (by project ID or directory) or worktree folder (by directory).",
          input: Schema.Struct({
            target: Schema.Literals(["section", "project", "folder"]),
            id: Schema.String,
            collapsed: Schema.Boolean,
          }),
          output: Schema.Struct({ key: Schema.String, collapsed: Schema.Boolean }),
          options: { namespace: "opencode.sidebar", codemode: true },
          execute: (input) =>
            Effect.gen(function* () {
              const key = yield* Effect.gen(function* () {
                if (input.target === "project") return `project:${projectKey(yield* findProject(input.id))}`
                if (input.target === "folder") {
                  const list = yield* projects.list({ archived: false })
                  const known = list.some((project) =>
                    [project.canonical, ...project.sandboxes].some((root) => containsDirectory(root, input.id)),
                  )
                  if (!known)
                    return yield* new ToolFailure({ message: `${input.id} is not inside a known project or worktree.` })
                  return `worktree:${folderKey(input.id)}`
                }
                return `section:${input.id}`
              })
              yield* updateSections((state) =>
                (input.target === "section" && input.id ? requireSection(state, input.id) : Effect.void).pipe(
                  Effect.as({ ...state, collapsed: { ...state.collapsed, [key]: input.collapsed } }),
                ),
              )
              return { output: { key, collapsed: input.collapsed } }
            }).pipe(Effect.mapError(toolFailure(`Unable to update ${input.target} ${input.id}`))),
        })
      })
      .pipe(Effect.orDie)
  }),
}

const storageKey = (key: PreferenceKey) => `preference:${key}`

const projectKey = (project: Project.Info) => JSON.stringify([SERVER, comparablePath(project.canonical)])

const folderKey = (directory: string) => JSON.stringify([SERVER, comparablePath(directory)])

const projectName = (project: Project.Info) => project.name ?? getFilename(project.canonical)

const updatedAt = (session: Session.Info) => DateTime.toEpochMillis(session.time.updated)

const clamp = (index: number, length: number) => Math.min(Math.max(index, 0), length)

const omit = <T>(record: Readonly<Record<string, T>>, key: string) =>
  Object.fromEntries(Object.entries(record).filter(([other]) => other !== key))

const missingSection = (sectionID: string) =>
  new ToolFailure({ message: `No section ${sectionID}. Use sidebar.list to see the sections.` })

const requireSection = (state: SectionsState, sectionID: string) =>
  state.sections.some((section) => section.id === sectionID) ? Effect.void : Effect.fail(missingSection(sectionID))

// The app's session order: pinned first, then sessions updated since their manual position, newest first, then the
// manual order (`ordered` in project-sidebar.tsx).
function ordered(
  list: readonly Session.Info[],
  saved: readonly { id: string; updated: number }[],
  pins: readonly string[],
) {
  const positions = new Map(saved.map((entry, index) => [entry.id, { ...entry, index }]))
  const rank = new Map(pins.map((id, index) => [id, index]))
  return list
    .toSorted((a, b) => {
      const left = positions.get(a.id)
      const right = positions.get(b.id)
      const freshA = !left || updatedAt(a) > left.updated
      const freshB = !right || updatedAt(b) > right.updated
      if (freshA && freshB) return updatedAt(b) - updatedAt(a)
      if (freshA !== freshB) return freshA ? -1 : 1
      return left!.index - right!.index
    })
    .toSorted((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size))
}

// Worktree folders with sessions, by name, then the project's own checkout, as the app groups them.
function folders(project: Project.Info, list: readonly Session.Info[]) {
  const roots = [project.canonical, ...project.sandboxes].toSorted((a, b) => b.length - a.length)
  const groups = Map.groupBy(
    list,
    (session) => roots.find((root) => containsDirectory(root, session.location.directory)) ?? project.canonical,
  )
  return [
    ...[...groups.keys()]
      .filter((directory) => directory !== project.canonical)
      .toSorted((a, b) => getFilename(a).localeCompare(getFilename(b)) || a.localeCompare(b)),
    project.canonical,
  ].map((directory) => ({ directory, sessions: groups.get(directory) ?? [] }))
}
