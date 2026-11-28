import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { ProjectTable } from "@opencode/core/project/sql"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { SidebarTools } from "@opencode/core/tool/plugin/sidebar"
import { Preference } from "@opencode/schema/preference"
import { comparablePath } from "@opencode/util/path"
import { Effect, Fiber, Stream } from "effect"
import { TestClock } from "effect/testing"
import { testEffect } from "./lib/effect"
import { executeTool, toolIdentity } from "./lib/tool"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const setup = Effect.gen(function* () {
  const plugins = yield* Plugin.Service
  const sessions = yield* Session.Service
  const location = yield* Location.Service
  const database = yield* Database.Service
  yield* SidebarTools.Plugin.effect(yield* PluginHost.make(plugins, "test"))
  const create = (title: string) =>
    sessions.create({ title, location: Location.Ref.make({ directory: location.directory }) })
  const older = yield* create("Older")
  yield* TestClock.adjust("1 second")
  const newer = yield* create("Newer")
  // Sessions resolve their project from the directory; list the same project.
  yield* database.db
    .insert(ProjectTable)
    .values({ id: newer.projectID, worktree: location.directory, sandboxes: [], time_created: 1, time_updated: 1 })
    .onConflictDoUpdate({ target: ProjectTable.id, set: { worktree: location.directory } })
    .run()
    .pipe(Effect.orDie)
  const registry = yield* Tool.Service
  const call = (name: string, input: Record<string, unknown>) =>
    executeTool(registry, {
      sessionID: newer.id,
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: `call-${name}-${JSON.stringify(input)}`,
        name: "execute",
        input: { code: `return await tools.opencode.sidebar.${name}(${JSON.stringify(input)})` },
      },
    }).pipe(Effect.map((result) => (result.content?.[0]?.type === "text" ? result.content[0].text : "")))
  const run = (name: string, input: Record<string, unknown>) => call(name, input).pipe(Effect.map(JSON.parse))
  const project = { id: newer.projectID, key: JSON.stringify(["sidecar", comparablePath(location.directory)]) }
  return { call, run, project, older, newer, directory: location.directory }
})

it.effect("edits the shared sidebar preferences the app reads, without deleting sessions", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const bus = yield* Bus.Service
    const sessions = yield* Session.Service
    const ctx = yield* setup
    const stored = (key: string) => kv.get(`preference:${key}`)
    // The app's own fields stay as they are, including ones this tool does not know.
    yield* kv.set("preference:sidebar.project-sections", { collapsed: { "section:": true }, future: 1 })
    yield* kv.set("preference:sidebar.recent", { pins: ["https://remote\u0000ses_elsewhere"] })

    const list = yield* ctx.run("list", {})
    expect(list.sections).toHaveLength(1)
    expect(list.sections[0]).toMatchObject({ id: "", collapsed: true, sort: "updated" })
    const folder = list.sections[0].projects.find((item: { projectID: string }) => item.projectID === ctx.project.id)
    expect(folder.folders).toEqual([
      {
        directory: ctx.directory,
        worktree: false,
        sessions: [
          { id: ctx.newer.id, title: "Newer", pinned: false },
          { id: ctx.older.id, title: "Older", pinned: false },
        ],
        hidden: 0,
      },
    ])

    // Pinning leads the folder and keeps pins from other servers.
    const events = yield* bus
      .subscribe(Preference.Event.Updated)
      .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    expect(yield* ctx.run("pin", { sessionID: ctx.older.id, pinned: true })).toEqual({
      sessionID: ctx.older.id,
      pinned: true,
    })
    expect(yield* Fiber.join(events)).toMatchObject([{ data: { key: "sidebar.recent" } }])
    expect(yield* stored("sidebar.recent")).toEqual({
      pins: ["https://remote\u0000ses_elsewhere", `sidecar\u0000${ctx.older.id}`],
    })
    expect(
      (yield* ctx.run("list", { project: ctx.project.id, limit: 1 })).sections[0].projects[0].folders[0],
    ).toMatchObject({ sessions: [{ id: ctx.older.id, pinned: true }], hidden: 1 })

    // A new section takes the project; deleting the section returns it and keeps every session.
    const { sectionID } = yield* ctx.run("section_create", { name: " Work " })
    yield* ctx.run("project_move", { project: ctx.directory, sectionID, index: 0 })
    yield* ctx.run("section_move", { sectionID, index: 0 })
    yield* ctx.run("collapse", { target: "project", id: ctx.project.id, collapsed: true })
    expect(yield* stored("sidebar.project-sections")).toMatchObject({
      future: 1,
      sections: [{ id: sectionID, name: "Work" }],
      order: [sectionID, ""],
      projects: [ctx.project.key],
      sorting: { [sectionID]: "manual" },
      assignments: { [ctx.project.key]: sectionID },
      collapsed: { "section:": true, [`project:${ctx.project.key}`]: true },
    })
    expect((yield* ctx.run("list", {})).sections.map((section: { id: string }) => section.id)).toEqual([sectionID, ""])

    expect(yield* ctx.run("section_delete", { sectionID })).toEqual({ sectionID, projects: 1 })
    expect(yield* stored("sidebar.project-sections")).toMatchObject({ sections: [], order: [""], assignments: {} })
    expect((yield* sessions.get(ctx.older.id)).id).toBe(ctx.older.id)
    expect((yield* sessions.get(ctx.newer.id)).id).toBe(ctx.newer.id)

    // The default section stays, and unknown IDs fail without writing.
    expect(yield* ctx.call("section_delete", { sectionID: "" })).toContain("No section")
    expect(yield* ctx.call("collapse", { target: "folder", id: "/not/a/project", collapsed: true })).toContain(
      "not inside a known project",
    )

    yield* ctx.run("pin", { sessionID: ctx.older.id, pinned: false })
    expect(yield* stored("sidebar.recent")).toEqual({ pins: ["https://remote\u0000ses_elsewhere"] })
  }),
)

it.effect("refuses to rewrite a stored preference it cannot read", () =>
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const ctx = yield* setup
    yield* kv.set("preference:sidebar.project-sections", { sections: "broken" })

    expect(yield* ctx.call("section_create", { name: "Work" })).toContain("not in the expected format")
    expect(yield* kv.get("preference:sidebar.project-sections")).toEqual({ sections: "broken" })
  }),
)
