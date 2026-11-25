import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { pathKey } from "@/workspaces/path-key"

export const projectSorts = ["updated", "name", "manual"] as const
export const ProjectSectionsState = Persistence.struct({
  sections: Persistence.array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  order: Persistence.array(Schema.String),
  projects: Persistence.array(Schema.String),
  sorting: Persistence.record(Schema.Literals(projectSorts)),
  assignments: Persistence.record(Schema.String),
  collapsed: Persistence.record(Schema.Boolean),
  sessions: Persistence.record(Schema.Array(Schema.Struct({ id: Schema.String, updated: Schema.Number }))),
})

// Desktop calls its own server "sidecar"; a browser reaches the same server by URL. Keep that difference
// out of the shared order, section assignments, and disclosure state, without changing local storage keys.
export function translateProjectSections(state: typeof ProjectSectionsState.Type, from: string, to: string) {
  if (from === to) return state
  const old = `[${JSON.stringify(from)},`
  const next = `[${JSON.stringify(to)},`
  const key = (value: string) => {
    for (const prefix of ["", "project:", "worktree:"]) {
      if (value.startsWith(prefix + old)) return prefix + next + value.slice(prefix.length + old.length)
    }
    return value
  }
  const translate = <T>(map: Record<string, T>) =>
    Object.fromEntries(Object.entries(map).map(([id, value]) => [key(id), value]))
  return {
    ...state,
    projects: state.projects.map(key),
    assignments: translate(state.assignments),
    collapsed: translate(state.collapsed),
    sessions: translate(state.sessions),
  }
}

export function sidebarProjectKey(server: string, directory: string) {
  return JSON.stringify([server, pathKey(directory)])
}

export function projectSection(state: typeof ProjectSectionsState.Type, project: string) {
  const id = state.assignments[project]

  return state.sections.some((section) => section.id === id) ? id : ""
}
