import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiSchema, OpenApi } from "effect/http-api"

/** The client settings the server keeps, so every client of the server shares them. */
export const PreferenceKey = Schema.Literals([
  "model",
  "sidebar.organize",
  "sidebar.project-sections",
  "sidebar.recent",
  "sidebar.view",
  "sidebar.inbox",
]).annotate({ identifier: "PreferenceKey" })
export type PreferenceKey = typeof PreferenceKey.Type

const params = { key: PreferenceKey }

const annotations = (identifier: string, summary: string, description: string) =>
  OpenApi.annotations({
    identifier: `experimental.preference.${identifier}`,
    summary,
    description: `${description} Experimental: may change without compatibility guarantees.`,
    transform: (operation) => ({ ...operation, tags: ["experimental"] }),
  })

/** Lives in the `server.experimental` group (see `groups/experimental.ts`). */
export const PreferenceEndpoints = [
  HttpApiEndpoint.get("preference.get", "/api/experimental/preference/:key", {
    params,
    success: Schema.Struct({ data: Schema.NullOr(Schema.Json) }),
  }).annotateMerge(
    annotations(
      "get",
      "Get shared preference",
      "Read a client setting shared by every client of this server, or null when none was saved.",
    ),
  ),
  HttpApiEndpoint.put("preference.set", "/api/experimental/preference/:key", {
    params,
    payload: Schema.Struct({ value: Schema.Json }),
    success: HttpApiSchema.NoContent,
  }).annotateMerge(
    annotations("set", "Set shared preference", "Replace a client setting shared by every client of this server."),
  ),
] as const
