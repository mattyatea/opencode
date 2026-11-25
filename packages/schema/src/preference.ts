export * as Preference from "./preference.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"

export const Key = Schema.Literals([
  "model",
  "language",
  "projects",
  "settings",
  "sidebar.organize",
  "sidebar.project-sections",
  "sidebar.recent",
  "sidebar.view",
  "sidebar.inbox",
]).annotate({ identifier: "PreferenceKey" })

const Updated = ephemeral({ type: "preference.updated", schema: { key: Key } })
export const Event = { Updated, Definitions: inventory(Updated) }
