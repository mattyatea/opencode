export * as ConfigVoice from "./voice.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export const Provider = Schema.Literals(["openai", "chatgpt"]).annotate({
  identifier: "ConfigVoice.Provider",
  description:
    "openai runs GPT-Live on an OpenAI or OpenCode API key. chatgpt runs it on your ChatGPT plan through a Codex sign-in, and OpenCode answers its requests in a voice session",
})
export type Provider = typeof Provider.Type

export const TokenSource = Schema.Literals(["auto", "opencode", "codex"]).annotate({
  identifier: "ConfigVoice.TokenSource",
  description:
    "Where the ChatGPT plan's sign-in comes from: opencode is OpenCode's Codex (legacy) sign-in, codex is the Codex CLI's ~/.codex/auth.json, read without refreshing it, and auto tries them in that order",
})
export type TokenSource = typeof TokenSource.Type

export class ChatGPT extends Schema.Class<ChatGPT>("ConfigVoice.ChatGPT")({
  token: TokenSource.pipe(optional),
  voice: Schema.String.pipe(optional).annotate({
    description: "Output voice, such as cove, juniper, maple or himari (default: cove)",
  }),
  model: Schema.String.pipe(optional).annotate({
    description: "Realtime voice model (default: the ChatGPT backend's choice)",
  }),
  ack_filler: Schema.Boolean.pipe(optional).annotate({
    description: "Let the voice say a short acknowledgement while OpenCode works on a request",
  }),
  instructions: Schema.String.pipe(optional).annotate({
    description: "Replaces the system instructions of the voice, the part you talk to",
  }),
}) {}

export class Agent extends Schema.Class<Agent>("ConfigVoice.Agent")({
  model: Schema.String.pipe(optional).annotate({
    description: "Model of the voice session's agent, as provider/model (default: the default model)",
  }),
  instructions: Schema.String.pipe(optional).annotate({
    description: "Extra instructions for the voice session's agent, added after OpenCode's own",
  }),
}) {}

export class Info extends Schema.Class<Info>("ConfigVoice.Info")({
  provider: Provider.pipe(optional),
  work_model: Schema.String.pipe(optional).annotate({
    description:
      "Model of the sessions and tasks the voice creates, as provider/model or provider/model#variant (default: the main session's model)",
  }),
  chatgpt: ChatGPT.pipe(optional).annotate({
    description: "GPT-Live on your ChatGPT plan",
  }),
  agent: Agent.pipe(optional).annotate({
    description: "The OpenCode agent that answers the voice's requests when the provider is chatgpt",
  }),
}) {}
