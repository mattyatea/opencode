export * as ContextUsage from "./context-usage.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

/** Experimental: estimates of the logical request, before provider serialization and HTTP hooks. */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  estimates: Schema.Struct({
    messages: NonNegativeInt,
    system: NonNegativeInt,
    tools: NonNegativeInt,
    mcp: NonNegativeInt,
    skills: NonNegativeInt,
    instructions: NonNegativeInt,
  }),
  deferredTools: NonNegativeInt,
  autoCompactLimit: NonNegativeInt.pipe(optional),
  fingerprints: Schema.Struct({
    system: Schema.String,
    tools: Schema.String,
    history: Schema.String,
    routing: Schema.String,
  }),
}).annotate({ identifier: "ContextUsage.Info" })
