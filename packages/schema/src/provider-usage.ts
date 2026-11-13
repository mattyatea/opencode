export * as ProviderUsage from "./provider-usage.js"

import { Schema } from "effect"
import { Rpc } from "./rpc.js"
import { optional } from "./schema.js"

/** One subscription limit: how much of the window is used and when it resets. */
export interface Meter extends Schema.Schema.Type<typeof Meter> {}
export const Meter = Schema.Struct({
  id: Schema.String,
  /** A short period name, such as "5時間" or "週間". */
  label: Schema.String,
  /** Used share of the limit, 0 to 100. */
  usedPercent: Schema.Number,
  /** When the window resets, in epoch milliseconds. */
  resetsAt: optional(Schema.Number),
  /** The provider reports the limit as hit. */
  limited: optional(Schema.Boolean),
}).annotate({ identifier: "ProviderUsage.Meter" })

export const State = Schema.Literals(["ready", "signed-out", "unavailable"])
export type State = typeof State.Type

/** The usage of one subscription provider. */
export interface Provider extends Schema.Schema.Type<typeof Provider> {}
export const Provider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  state: State,
  /** The plan name when ready, or why the usage could not be read. */
  detail: optional(Schema.String),
  meters: Schema.Array(Meter),
}).annotate({ identifier: "ProviderUsage.Provider" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  checkedAt: Schema.Number,
  providers: Schema.Array(Provider),
}).annotate({ identifier: "ProviderUsage.Snapshot" })

/**
 * The provider usage plugin's RPC. `snapshot` returns the subscription usage of OpenCode Go, Codex, xAI and Claude,
 * cached for five minutes unless `fresh` is set.
 */
export const Definition = Rpc.define({
  id: "opencode.provider-usage",
  methods: {
    snapshot: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ fresh: optional(Schema.Boolean) })),
      output: Schema.toStandardSchemaV1(Snapshot),
    },
  },
  events: {},
})
