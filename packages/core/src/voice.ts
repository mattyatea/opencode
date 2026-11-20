export * as Voice from "./voice.js"

import { type AIError } from "@opencode/ai/effect"
import {
  Realtime,
  type RealtimeSession,
  type RealtimeTransport,
  type RealtimeTransportInput,
  type RealtimeTransportType,
} from "@opencode/ai/experimental"
import { RequestExecutor } from "@opencode/ai/route"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { Config } from "./config.js"
import { Credential } from "./credential.js"
import { requestExecutor } from "./effect/app-node-platform.js"
import { Flag } from "./flag.js"
import { Integration } from "./integration.js"
import {
  CallError,
  createCodexVoice,
  resolveCommand,
  type Event as CodexEvent,
  type StartInput,
} from "./voice/codex.js"

export type { CodexEvent, StartInput as CodexStartInput }

export interface ModelInfo {
  readonly model: string
  readonly provider: string
  readonly transports: readonly RealtimeTransportType[]
  readonly available: boolean
}

export interface Models {
  readonly models: readonly ModelInfo[]
  readonly default?: string
}

export interface SessionInput {
  readonly model: string
  readonly session?: RealtimeSession
  readonly transport: RealtimeTransportInput
}

export class InvalidRequestError extends Schema.TaggedError<InvalidRequestError>()("Voice.InvalidRequestError", {
  message: Schema.String,
}) {}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Voice.UnavailableError", {
  message: Schema.String,
  service: Schema.optional(Schema.String),
}) {}

export type Error = InvalidRequestError | UnavailableError

export interface Interface {
  readonly models: () => Effect.Effect<Models>
  readonly session: (input: SessionInput) => Effect.Effect<RealtimeTransport, Error>
  /** Calls on Codex realtime through `codex app-server`, with the server's Codex sign-in. */
  readonly codex: {
    readonly start: (input: StartInput) => Effect.Effect<{ readonly call: string; readonly sdp: string }, Error>
    /** Waits briefly for the call's events after `after`, so a client can ask again right away. */
    readonly events: (
      call: string,
      after: number,
    ) => Effect.Effect<{ readonly events: readonly CodexEvent[]; readonly closed: boolean }, Error>
    readonly tool: (call: string, id: string, output: string, success: boolean) => Effect.Effect<void, Error>
    readonly speech: (call: string, text: string) => Effect.Effect<void, Error>
    readonly context: (call: string, text: string) => Effect.Effect<void, Error>
    readonly stop: (call: string) => Effect.Effect<void>
  }
}

/** The model ID that selects Codex realtime in `models` and the client. */
export const codexModel = "codex"

export class Service extends Context.Service<Service, Interface>()("@opencode/Voice") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    const integrations = yield* Integration.Service
    const config = yield* Config.Service
    const flags = yield* Flag.Service
    const codex = yield* Effect.acquireRelease(Effect.sync(createCodexVoice), (codex) => Effect.sync(codex.close))

    const voiceConfig = () => config.entries().pipe(Effect.map((entries) => Config.latest(entries, "voice")))

    // Integration lists the active credential first, then newer stored credentials, then non-empty env vars.
    const findConnection = (provider: string, methods: readonly string[] = ["key"]) =>
      integrations
        .get(Integration.ID.make(provider))
        .pipe(
          Effect.map((info) => info?.connections.find((item) => item.type === "env" || methods.includes(item.method))),
        )

    // Where an engine's sessions start: its provider with the server's key or, for GPT-Live without an OpenAI key,
    // OpenCode's hosted GPT-Live with the server's OpenCode Console connection, whose sign-in works as well as a key.
    const source = Effect.fnUntraced(function* (engine: (typeof Realtime.engines)[number]) {
      const connection = yield* findConnection(engine.provider)
      if (connection) return { provider: engine.provider, connection }
      if (engine.id !== "openai-live") return undefined
      const hosted = yield* findConnection(openCodeLive.provider, ["key", "oauth"])
      return hosted && { provider: openCodeLive.provider, connection: hosted }
    })

    const models = Effect.fn("Voice.models")(function* () {
      const list = yield* Effect.forEach(Realtime.engines, (engine) =>
        source(engine).pipe(
          Effect.map((found) => ({
            model: engine.model,
            provider: found?.provider ?? engine.provider,
            transports: engine.transports,
            available: found !== undefined,
          })),
        ),
      )
      const settings = yield* voiceConfig()
      const codexEntry = (yield* flags.enabled("codex_voice"))
        ? [
            {
              model: codexModel,
              provider: "codex",
              transports: ["webrtc" as const],
              available: resolveCommand(settings?.codex) !== undefined,
            },
          ]
        : []
      const preferCodex = settings?.engine === "codex" || (settings?.engine === undefined && !!settings?.codex)
      const first = [...(preferCodex ? codexEntry : []), ...list].find((item) => item.available)?.model
      const models = [...codexEntry, ...list]
      return first ? { models, default: first } : { models }
    })

    const session = Effect.fn("Voice.session")(function* (input: SessionInput) {
      const engine = Realtime.engine(input.model)
      if (!engine) return yield* new InvalidRequestError({ message: `Unsupported voice model: ${input.model}` })

      const found = yield* source(engine)
      const credential = found
        ? yield* integrations.connection
            .resolve(found.connection)
            .pipe(Effect.mapError((error) => new UnavailableError({ service: found.provider, message: error.message })))
        : undefined
      const access = found && credential && sessionAccess(found.provider, credential)
      if (found === undefined || access === undefined)
        return yield* new UnavailableError({
          service: engine.provider,
          message: engine.id === "openai-live" ? missingLiveKeyMessage : missingKeyMessage[engine.provider],
        })

      return yield* Realtime.connect({
        model: input.model,
        session: input.session,
        transport: input.transport,
        ...access,
      }).pipe(
        Effect.provideService(RequestExecutor.Service, executor),
        Effect.mapError(
          (error: AIError): Error =>
            error.reason._tag === "InvalidRequest" || error.reason._tag === "UnsupportedOperation"
              ? new InvalidRequestError({ message: error.message })
              : new UnavailableError({ message: error.message, service: found.provider }),
        ),
      )
    })

    const codexCall = <A>(name: string, run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (error): Error =>
          error instanceof CallError && error.kind === "invalid"
            ? new InvalidRequestError({ message: error.message })
            : new UnavailableError({
                service: "codex",
                message: error instanceof Error ? error.message : String(error),
              }),
      }).pipe(Effect.withSpan(`Voice.codex.${name}`))

    const codexStart = Effect.fn("Voice.codex.start")(function* (input: StartInput) {
      if (!(yield* flags.enabled("codex_voice")))
        return yield* new UnavailableError({
          service: "codex",
          message: "Codex voice is turned off. Enable the codex_voice flag.",
        })
      const settings = yield* voiceConfig()
      return yield* codexCall("call", () => codex.start(settings?.codex, input))
    })

    return Service.of({
      models,
      session,
      codex: {
        start: codexStart,
        events: (call, after) => codexCall("events", () => codex.events(call, after)),
        tool: (call, id, output, success) =>
          codexCall("tool", () => Promise.resolve().then(() => codex.tool(call, id, output, success))),
        speech: (call, text) => codexCall("speech", () => codex.speech(call, text)),
        context: (call, text) => codexCall("context", () => codex.context(call, text)),
        stop: (call) => Effect.promise(() => codex.stop(call)),
      },
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, requestExecutor, Config.node, Flag.node],
})

/** OpenCode hosts GPT-Live on its OpenAI account, billed to the workspace whose credential starts a session. */
const openCodeLive = { provider: "opencode", baseURL: "https://opencode.ai/inference/openai/v1" } as const

/**
 * What a credential starts a session with: a provider's API key on its own API, or an OpenCode Console API key or
 * account sign-in on OpenCode's hosted GPT-Live, for the workspace the sign-in chose.
 */
const sessionAccess = (provider: string, credential: Credential.Value) => {
  if (provider !== openCodeLive.provider)
    return credential.type === "key" ? { apiKey: Redacted.make(credential.key) } : undefined
  if (credential.type === "external") return undefined
  const orgID = credential.metadata?.orgID
  return {
    apiKey: Redacted.make(credential.type === "oauth" ? credential.access : credential.key),
    baseURL: openCodeLive.baseURL,
    ...(typeof orgID === "string" ? { headers: { "x-opencode-org-id": orgID } } : {}),
  }
}

const missingLiveKeyMessage =
  "GPT-Live needs an OpenAI API key (a stored key or OPENAI_API_KEY) or an OpenCode Console connection on the server. ChatGPT sign-in can't start voice sessions."

const missingKeyMessage = {
  openai:
    "Voice needs an OpenAI API key on the server (a stored key or OPENAI_API_KEY). ChatGPT sign-in can't start voice sessions.",
  xai: "Voice needs an xAI API key on the server (a stored key or XAI_API_KEY).",
  google:
    "Voice needs a Google API key on the server (a stored key, GEMINI_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GOOGLE_API_KEY).",
} as const
