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
import { Cause, Context, Duration, Effect, Layer, Redacted, Schedule, Schema } from "effect"
import { Socket } from "effect/socket"
import { AbsolutePath } from "@opencode/schema/schema"
import { Config } from "./config.js"
import { Credential } from "./credential.js"
import { requestExecutor, webSocketConstructor } from "./effect/app-node-platform.js"
import { Flag } from "./flag.js"
import { Integration } from "./integration.js"
import { Location } from "./location.js"
import { Model } from "./model.js"
import { voiceAgentID } from "./plugin/agent.js"
import { Session } from "./session.js"
import { mainSession, messageText } from "./tool/plugin/voice.js"
import { CallError, createChatGPTVoice, type Call as ChatGPTCall, type Event as CallEvent } from "./voice/chatgpt.js"
import { codexCLICredentials } from "./voice/codex-cli.js"
import { VoiceRegistry } from "./voice/registry.js"

export type { CallEvent }

/** Where a ChatGPT voice call's requests are answered, and the session Desktop shows when it starts. */
export interface CallInput {
  readonly sdp: string
  /** The project or worktree directory the call's voice session runs in. */
  readonly directory: string
  readonly viewing?: Viewing
}

export interface Viewing {
  readonly id: string
  readonly title?: string
}

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
  /**
   * GPT-Live on the ChatGPT plan, created by the server with a Codex sign-in. OpenCode answers the voice's requests in
   * a voice session per call.
   */
  readonly call: {
    readonly start: (input: CallInput) => Effect.Effect<{ readonly call: string; readonly sdp: string }, Error>
    /** Waits briefly for the call's events after `after`, so a client can ask again right away. */
    readonly events: (
      call: string,
      after: number,
    ) => Effect.Effect<{ readonly events: readonly CallEvent[]; readonly closed: boolean }, Error>
    readonly speech: (call: string, text: string) => Effect.Effect<void, Error>
    /** Records which session Desktop shows now. */
    readonly view: (call: string, viewing: Viewing) => Effect.Effect<void, Error>
    readonly stop: (call: string) => Effect.Effect<void>
  }
}

/** The model ID of GPT-Live on the ChatGPT plan in `models` and the client. */
export const chatgptModel = "chatgpt-live"

/** How long OpenCode may work on one request before the voice hears that it is still running. */
const DELEGATION_LIMIT = Duration.minutes(3)

const defaultVoiceInstructions = `You are OpenCode's voice assistant. Speak naturally and briefly, in the user's language.
You cannot see sessions, projects, code, files, or the screen. Your backend can: it manages OpenCode's sessions with tools.
Delegate every request about coding, sessions, projects, status, the screen, models, or work to your backend in the same turn you hear it, before you say anything about the result.
Never answer those yourself and never guess: names, counts, statuses and results come only from the backend.
"It didn't work" or "nothing happened" is a request to check: delegate it.
When you delegate, react briefly ("let me check") and never phrase it as done. Wait for the backend's answer, then give only the outcome and where.
Results for work sent earlier arrive with their session title and request. Attribute each result to that session.
Do not read IDs, code blocks, or long paths aloud. Summarize results in one to three sentences.
Background speech and remarks to other people are not requests. Ask once if a request is unintelligible.
Do not speak until the user speaks.`

export class Service extends Context.Service<Service, Interface>()("@opencode/Voice") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const executor = yield* RequestExecutor.Service
    const integrations = yield* Integration.Service
    const config = yield* Config.Service
    const flags = yield* Flag.Service
    const sessions = yield* Session.Service
    const makeSocket = yield* Socket.WebSocketConstructor
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    // Per call: where its voice session runs, the session Desktop shows, and the voice session once it exists.
    const states = new Map<string, CallState>()
    const chatgpt = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createChatGPTVoice({
          socket: (url, headers) => makeSocket(url, { headers }),
          delegate: (call, delegation) => run(delegate(call, delegation.text)),
        }),
      ),
      (voice) =>
        Effect.sync(() => {
          voice.close()
          states.forEach((state) => state.unlink?.())
        }),
    )

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
      const subscription = (yield* chatgptEnabled(settings))
        ? [
            {
              model: chatgptModel,
              provider: "chatgpt",
              transports: ["webrtc" as const],
              available: yield* hasChatGPTSignIn(settings?.chatgpt?.token ?? "auto"),
            },
          ]
        : []
      // An explicit provider wins; otherwise an API key, then the ChatGPT plan.
      const order =
        settings?.provider === "chatgpt"
          ? [...subscription, ...list]
          : settings?.provider === "openai"
            ? list
            : [...list, ...subscription]
      const first = order.find((item) => item.available)?.model
      const models = [...subscription, ...list]
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

    // Choosing the ChatGPT plan as the provider opts in, so release builds, which keep flags off, can use it too.
    const chatgptEnabled = (settings: { readonly provider?: string } | undefined) =>
      settings?.provider === "chatgpt" ? Effect.succeed(true) : flags.enabled("chatgpt_voice")

    const callEffect = <A>(name: string, work: () => A | Promise<A>) =>
      Effect.tryPromise({
        try: async () => work(),
        catch: (error): Error =>
          error instanceof CallError && error.kind === "invalid"
            ? new InvalidRequestError({ message: error.message })
            : new UnavailableError({
                service: "chatgpt",
                message: error instanceof Error ? error.message : String(error),
              }),
      }).pipe(Effect.withSpan(`Voice.call.${name}`))

    const hasChatGPTSignIn = Effect.fnUntraced(function* (source: string) {
      if (source !== "codex") {
        const info = yield* integrations.get(Integration.ID.make("openai"))
        if (info?.connections.some((item) => item.type === "credential" && item.method === "oauth")) return true
      }
      return source !== "opencode" && codexCLICredentials() !== undefined
    })

    // OpenCode's Codex (legacy) sign-in first, refreshed as needed; then the Codex CLI's, read as it is.
    const chatgptCredentials = Effect.fn("Voice.chatgptCredentials")(function* (source: string) {
      if (source !== "codex") {
        const info = yield* integrations.get(Integration.ID.make("openai"))
        for (const connection of info?.connections ?? []) {
          if (connection.type !== "credential" || connection.method !== "oauth") continue
          const value = yield* integrations.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
          if (value?.type !== "oauth" || !["chatgpt-browser", "chatgpt-headless"].includes(value.methodID)) continue
          const account = value.metadata?.accountID
          return { token: value.access, ...(typeof account === "string" ? { account } : {}) }
        }
      }
      const cli = source === "opencode" ? undefined : codexCLICredentials()
      if (cli?.expired)
        return yield* new UnavailableError({
          service: "chatgpt",
          message:
            "The Codex CLI's sign-in has expired. Run the Codex CLI once to refresh it, or sign in with Codex (legacy) in OpenCode.",
        })
      if (cli) return { token: cli.token, ...(cli.account ? { account: cli.account } : {}) }
      return yield* new UnavailableError({
        service: "chatgpt",
        message:
          "Voice on the ChatGPT plan needs a Codex sign-in: connect OpenAI with Codex browser (legacy) in OpenCode, or sign in to the Codex CLI.",
      })
    })

    /** Answers one request in the call's voice session and returns what the voice should say. */
    // Annotated so this layer's type doesn't depend on Session's inferred types, which reach back to this layer.
    const delegate = (call: ChatGPTCall, request: string): Effect.Effect<string> =>
      answer(call, request).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            `OpenCode could not finish that request (${Cause.pretty(cause).split("\n")[0]}). Do not claim it succeeded.`,
          ),
        ),
        Effect.withSpan("Voice.delegate"),
      )

    const answer = Effect.fnUntraced(function* (call: ChatGPTCall, request: string) {
      const state = states.get(call.id)
      if (!state) return "The call ended before OpenCode could answer."
      const settings = yield* voiceConfig()
      const sessionID = state.session ?? (yield* openVoiceSession(call, state, settings?.agent?.model))
      const viewing = state.viewing
      const extra = !state.session && settings?.agent?.instructions ? `\n\n${settings.agent.instructions}` : ""
      state.session = sessionID
      const admitted = yield* sessions.prompt({
        sessionID,
        text: `${request}\n\n(Desktop shows ${viewing ? `"${viewing.title ?? "Untitled"}" (${viewing.id})` : "no session"}.)${extra}`,
      })
      const finished = yield* settle(sessionID).pipe(
        Effect.timeout(DELEGATION_LIMIT),
        Effect.as(true),
        Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
      )
      if (!finished) return "That is still running in OpenCode. Say so, and offer to check again later."
      const recent = yield* sessions.messages({ sessionID, order: "desc", limit: 20 })
      const reply = recent.find(
        (message) => message.type === "assistant" && message.id > admitted.id && messageText(message),
      )
      return reply ? messageText(reply) : "OpenCode finished without an answer. Say you're not sure it worked."
    })

    /** Waits for work just admitted to a session to finish. */
    const settle = Effect.fnUntraced(function* (sessionID: Session.ID) {
      // The work starts shortly after it is admitted; waiting before then would return at once.
      yield* Effect.gen(function* () {
        return (yield* sessions.active).has(sessionID) ? true : yield* Effect.fail("idle" as const)
      }).pipe(Effect.retry({ times: 50, schedule: Schedule.spaced("100 millis") }), Effect.ignore)
      yield* sessions.wait(sessionID)
    })

    /** Waits for a session the voice sent work to, then has the voice read its reply. */
    const announce = (
      call: ChatGPTCall,
      input: { readonly sessionID: string; readonly after: string; readonly title: string; readonly request: string },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make(input.sessionID)
        yield* settle(sessionID)
        if (call.closed) return
        const recent = yield* sessions.messages({ sessionID, order: "desc", limit: 20 })
        const reply = recent.find(
          (message) => message.type === "assistant" && message.id > input.after && messageText(message),
        )
        if (!reply) return
        const text = messageText(reply)
          .replace(/```[\s\S]*?```/g, "[code in session]")
          .slice(0, 800)
        call.send({
          type: "session.context.append",
          content: [
            {
              type: "input_text",
              text: `Result from session ${JSON.stringify(input.title.slice(0, 100))}, request ${JSON.stringify(input.request.slice(0, 100))}: ${text}`,
            },
          ],
        })
      }).pipe(Effect.ignoreCause, Effect.withSpan("Voice.announce"))

    const openVoiceSession = (
      call: ChatGPTCall,
      state: CallState,
      model?: string,
    ): Effect.Effect<Session.ID, unknown> =>
      Effect.gen(function* () {
        const parsed = model?.includes("/") ? Model.parse(model) : undefined
        const base = {
          title: "Voice call",
          agent: voiceAgentID,
          ...(parsed ? { model: { providerID: parsed.providerID, id: parsed.modelID } } : {}),
        }
        const viewing = state.viewing
        const main = viewing
          ? yield* mainSession(sessions, viewing.id)
          : yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(state.directory) }) })
        if (!state.viewing) {
          state.viewing = { id: main.id, title: main.title }
          call.push({ type: "open", sessionID: main.id })
        }
        // Keep the voice helper out of the session list even when a child task is on screen.
        const session = yield* sessions.create({ ...base, parentID: main.id })
        state.unlink = VoiceRegistry.link(session.id, {
          viewing: () => state.viewing,
          open: (sessionID) => call.push({ type: "open", sessionID }),
          watch: (input) => void run(announce(call, input)),
        })
        return session.id
      })

    const callStart = Effect.fn("Voice.call.start")(function* (input: CallInput) {
      const voice = yield* voiceConfig()
      if (!(yield* chatgptEnabled(voice)))
        return yield* new UnavailableError({
          service: "chatgpt",
          message:
            "Voice on the ChatGPT plan is turned off. Choose it as the voice provider, or enable the chatgpt_voice flag.",
        })
      const settings = voice?.chatgpt
      const credentials = yield* chatgptCredentials(settings?.token ?? "auto")
      const started = yield* callEffect("start", () =>
        chatgpt.start(credentials, input.sdp, {
          instructions: settings?.instructions ?? defaultVoiceInstructions,
          voice: settings?.voice,
          model: settings?.model,
          ackFiller: settings?.ack_filler,
        }),
      )
      states.set(started.call, { directory: input.directory, viewing: input.viewing })
      return started
    })

    return Service.of({
      models,
      session,
      call: {
        start: callStart,
        events: (call, after) => callEffect("events", () => chatgpt.events(call, after)),
        speech: (call, text) => callEffect("speech", () => chatgpt.speech(call, text)),
        view: (call, viewing) =>
          callEffect("view", () => {
            chatgpt.get(call)
            const state = states.get(call)
            if (state) state.viewing = viewing
          }),
        stop: (call) =>
          Effect.sync(() => {
            chatgpt.stop(call)
            states.get(call)?.unlink?.()
            states.delete(call)
          }),
      },
    })
  }),
)

interface CallState {
  readonly directory: string
  viewing?: Viewing
  session?: Session.ID
  unlink?: () => void
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Integration.node, requestExecutor, Config.node, Flag.node, Session.node, webSocketConstructor],
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
