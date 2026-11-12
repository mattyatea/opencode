export * as ConfigToolCalls from "./tool-calls.js"

import { Schema } from "effect"
import { ParallelToolCalls } from "../agent.js"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.ToolCalls")({
  parallel: ParallelToolCalls.pipe(optional).annotate({
    description:
      'Run the tool calls of one model step concurrently. "auto" (default) runs independent calls concurrently without changing the provider request; true also asks the provider to enable parallel tool calling, for models that only batch when asked; false runs the calls one at a time and asks the provider not to batch them.',
  }),
}) {}
