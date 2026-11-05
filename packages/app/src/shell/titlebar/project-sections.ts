import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { pathKey } from "@/workspaces/path-key"

export const ProjectSectionsState = Persistence.struct({
  sections: Persistence.array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  order: Persistence.array(Schema.String),
  assignments: Persistence.record(Schema.String),
  collapsed: Persistence.record(Schema.Boolean),
})

export function sidebarProjectKey(server: string, directory: string) {
  return JSON.stringify([server, pathKey(directory)])
}

export function projectSection(state: typeof ProjectSectionsState.Type, project: string) {
  const id = state.assignments[project]

  return state.sections.some((section) => section.id === id) ? id : ""
}
