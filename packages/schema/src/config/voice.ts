export * as ConfigVoice from "./voice.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class CodexRealtime extends Schema.Class<CodexRealtime>("ConfigVoice.CodexRealtime")({
  model: Schema.String.pipe(optional).annotate({
    description: "Realtime voice model, such as gpt-live-1.1-codex. Defaults to Codex's choice for the version",
  }),
  version: Schema.Literals(["v1", "v2", "v3"]).pipe(optional).annotate({
    description: "Codex realtime protocol version. v3 is GPT-Live with Codex delegation (default: v3)",
  }),
  voice: Schema.String.pipe(optional).annotate({
    description: "Output voice, such as marin or cove. Run `codex app-server` thread/realtime/listVoices for the list",
  }),
  ack_filler: Schema.Boolean.pipe(optional).annotate({
    description: "Let the voice speak a short acknowledgement while Codex works on a delegation (v3 only)",
  }),
  startup_context: Schema.Boolean.pipe(optional).annotate({
    description:
      "Include Codex's own startup context (workspace and recent threads) in the voice prompt (default: false)",
  }),
  reasoning_status: Schema.Boolean.pipe(optional).annotate({
    description: "Relay Codex's public reasoning summaries to the voice as quiet context while it works (v3 only)",
  }),
}) {}

export class CodexInstructions extends Schema.Class<CodexInstructions>("ConfigVoice.CodexInstructions")({
  voice: Schema.String.pipe(optional).annotate({
    description: "Replaces the system instructions of the realtime voice model, the part that talks with you",
  }),
  delegator: Schema.String.pipe(optional).annotate({
    description:
      "Replaces the base instructions of the Codex agent that receives the voice's delegations and drives OpenCode with tools",
  }),
  append: Schema.String.pipe(optional).annotate({
    description: "Extra developer instructions appended for the Codex agent, keeping OpenCode's defaults",
  }),
  start: Schema.String.pipe(optional).annotate({
    description: "Developer instructions given to the Codex agent when a voice call starts",
  }),
  end: Schema.String.pipe(optional).annotate({
    description: "Developer instructions given to the Codex agent when a voice call ends",
  }),
}) {}

export class Codex extends Schema.Class<Codex>("ConfigVoice.Codex")({
  command: Schema.String.pipe(optional).annotate({
    description: "Codex CLI executable (default: codex on PATH)",
  }),
  args: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      'Arguments passed after `codex app-server`, such as ["-c", "model_reasoning_effort=\\"low\\"", "--disable", "hooks"]',
  }),
  env: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description: "Extra environment variables for the Codex app-server process, such as CODEX_HOME",
  }),
  cwd: Schema.String.pipe(optional).annotate({
    description: "Working directory of the Codex thread behind a call (default: the home directory)",
  }),
  model: Schema.String.pipe(optional).annotate({
    description: "Model of the Codex agent that handles delegations, such as gpt-6.1-sol (default: Codex config)",
  }),
  reasoning_effort: Schema.String.pipe(optional).annotate({
    description: "Reasoning effort of the Codex agent, such as low or medium (default: low)",
  }),
  config: Schema.Record(Schema.String, Schema.Unknown).pipe(optional).annotate({
    description: "Codex config overrides for the voice thread, using dotted Codex config keys",
  }),
  realtime: CodexRealtime.pipe(optional).annotate({
    description: "Realtime voice session options",
  }),
  instructions: CodexInstructions.pipe(optional).annotate({
    description: "System instruction overrides for the voice model and the Codex agent",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigVoice.Info")({
  engine: Schema.Literals(["codex", "gpt-live"]).pipe(optional).annotate({
    description:
      "Voice engine Desktop calls with. codex uses the Codex CLI's app-server with your Codex sign-in; gpt-live uses an OpenAI or OpenCode key. Defaults to codex when voice.codex is set",
  }),
  codex: Codex.pipe(optional).annotate({
    description: "Codex realtime voice through `codex app-server`",
  }),
}) {}
