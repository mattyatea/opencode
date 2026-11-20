import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import type { ConfigVoice } from "@opencode/schema/config/voice"
import { which } from "../util/which.js"
import { createAppServer, type AppServer, type Notification, type ServerRequest } from "./codex-app-server.js"

/** A function the Codex agent may call; the client that started the call runs it. */
export interface Tool {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export interface StartInput {
  /** The client's WebRTC offer; the answer comes back from OpenAI through Codex. */
  readonly sdp: string
  /** OpenCode's defaults, which `voice.codex.instructions` replaces. */
  readonly instructions: { readonly voice: string; readonly delegator: string }
  readonly tools: readonly Tool[]
  /** Developer context the agent starts with, such as the session on screen. */
  readonly context?: string
}

type EventBody =
  | { readonly type: "transcript"; readonly role: string; readonly delta: string }
  | { readonly type: "transcript.done"; readonly role: string; readonly text: string }
  | { readonly type: "delegation"; readonly status: "started" | "completed" }
  | { readonly type: "tool"; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly reason?: string }

/** What happened on a call, numbered so a client that asks again gets only what it hasn't seen. */
export type Event = EventBody & { readonly seq: number }

/** A call the request named that this server doesn't have, or a request Codex rejected. */
export class CallError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "unavailable",
  ) {
    super(message)
  }
}

/** How long the client's events request waits for something to happen before it asks again. */
const POLL_MS = 20_000
/** How long a start waits for OpenAI's SDP answer after Codex accepts it. */
const ANSWER_MS = 30_000
/** Events a call keeps for a client that falls behind; older transcript deltas only feed captions. */
const BACKLOG = 2_000
/** How long a closed call keeps answering its events so the client sees why it closed. */
const LINGER_MS = 60_000

const ThreadStart = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const ThreadParams = Schema.Struct({ threadId: Schema.String })
const Transcript = Schema.Struct({
  threadId: Schema.String,
  role: Schema.String,
  delta: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
})
const Message = Schema.Struct({ threadId: Schema.String, message: Schema.optional(Schema.String) })
const Exited = Schema.Struct({ message: Schema.String })
const Closed = Schema.Struct({ threadId: Schema.String, reason: Schema.optional(Schema.NullOr(Schema.String)) })
const Sdp = Schema.Struct({ threadId: Schema.String, sdp: Schema.String })
const ToolCall = Schema.Struct({
  threadId: Schema.String,
  callId: Schema.String,
  tool: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
})

const decode = <A, I>(schema: Schema.Codec<A, I>) => {
  const run = Schema.decodeUnknownOption(schema)
  return (value: unknown) => Option.getOrUndefined(run(value))
}
const decodeThreadStart = decode(ThreadStart)
const decodeThread = decode(ThreadParams)
const decodeTranscript = decode(Transcript)
const decodeMessage = decode(Message)
const decodeExited = decode(Exited)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeClosed = decode(Closed)
const decodeSdp = decode(Sdp)
const decodeToolCall = decode(ToolCall)

/**
 * Where the Codex CLI is: `voice.codex.command` or `codex`, on PATH or where its installers put it. A server started
 * from the Desktop app often has a shorter PATH than the user's shell.
 */
export function resolveCommand(config: ConfigVoice.Codex | undefined) {
  const home = os.homedir()
  const fallback = [path.join(home, ".local/bin"), path.join(home, ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
  return (
    which(config?.command ?? "codex", { ...process.env, ...config?.env }, fallback.join(path.delimiter)) ?? undefined
  )
}

/** The settings `codex app-server` starts with; a change starts a new process for later calls. */
export function processOptions(config: ConfigVoice.Codex | undefined) {
  return {
    command: resolveCommand(config) ?? config?.command ?? "codex",
    args: config?.args ?? [],
    env: config?.env ?? {},
  }
}

/**
 * Codex realtime calls: each call is one ephemeral Codex thread whose realtime voice talks to the client over WebRTC.
 * Codex owns the voice's delegations; its agent answers them by calling the client's tools, relayed through here.
 */
export function createCodexVoice() {
  const servers = new Map<string, AppServer>()
  const calls = new Map<string, Call>()

  const server = (options: ReturnType<typeof processOptions>) => {
    const key = encodeJson(options)
    const existing = servers.get(key)
    if (existing) return existing
    const created = createAppServer(options)
    servers.set(key, created)
    created.onNotification((notification) => route(created, notification))
    created.onRequest((request) => toolRequest(created, request))
    return created
  }

  const route = (owner: AppServer, notification: Notification) => {
    if (notification.method === "opencode/exited") {
      const reason = decodeExited(notification.params)?.message ?? "Codex app-server exited"
      return calls.forEach((call) => call.server === owner && call.close(reason))
    }
    const thread = decodeThread(notification.params)?.threadId
    const call = thread ? calls.get(thread) : undefined
    if (!call || call.server !== owner) return
    call.notify(notification)
  }

  const toolRequest = (owner: AppServer, request: ServerRequest) => {
    if (request.method !== "item/tool/call") return false
    const params = decodeToolCall(request.params)
    const call = params ? calls.get(params.threadId) : undefined
    if (!params || !call || call.server !== owner) return false
    call.tool(request.id, params.callId, params.tool, encodeJson(params.arguments ?? {}))
    return true
  }

  const get = (id: string) => {
    const call = calls.get(id)
    if (!call) throw new CallError(`Unknown voice call: ${id}`, "invalid")
    return call
  }

  return {
    start: async (config: ConfigVoice.Codex | undefined, input: StartInput) => {
      const app = server(processOptions(config))
      const instructions = config?.instructions
      const realtime = config?.realtime
      const started = decodeThreadStart(
        await app
          .request("thread/start", {
            ephemeral: true,
            cwd: config?.cwd ?? os.homedir(),
            baseInstructions: instructions?.delegator ?? input.instructions.delegator,
            developerInstructions: instructions?.append ?? null,
            dynamicTools: input.tools.map((tool) => ({
              type: "function",
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters,
            })),
            // No environment: the agent works only through OpenCode's tools, never a shell or files of its own.
            environments: [],
            approvalPolicy: "never",
            sandbox: "read-only",
            model: config?.model ?? null,
            config: { model_reasoning_effort: config?.reasoning_effort ?? "low", ...config?.config },
          })
          .catch(unavailable),
      )
      if (!started) throw new CallError("Codex app-server returned no thread", "unavailable")

      const id = started.thread.id
      const call: Call = new Call(app, id, () => calls.get(id) === call && calls.delete(id))
      calls.set(call.id, call)
      const answer = call.answer()
      const response = await app
        .request("thread/realtime/start", {
          threadId: call.id,
          outputModality: "audio",
          transport: { type: "webrtc", sdp: input.sdp },
          version: realtime?.version ?? "v3",
          model: realtime?.model ?? null,
          voice: realtime?.voice ?? null,
          prompt: instructions?.voice ?? input.instructions.voice,
          includeStartupContext: realtime?.startup_context ?? false,
          delegationAckFiller: realtime?.ack_filler ?? null,
          backendReasoningStatus: realtime?.reasoning_status ?? false,
          realtimeStartInstructions: instructions?.start ?? null,
          realtimeEndInstructions: instructions?.end ?? null,
        })
        .then(() => answer)
        .catch((error: unknown) => {
          call.close(message(error))
          return unavailable(error)
        })
      if (input.context) await inject(call, input.context).catch(() => undefined)
      return { call: call.id, sdp: response }
    },

    events: (id: string, after: number) => get(id).events(after),

    tool: (id: string, toolID: string, output: string, success: boolean) => get(id).reply(toolID, output, success),

    /** Has the voice say text, such as a session's reply that landed while nobody asked. */
    speech: (id: string, text: string) => {
      const call = get(id)
      return call.server
        .request("thread/realtime/appendSpeech", { threadId: call.id, text })
        .then(() => undefined, invalid)
    },

    /** Tells the agent something changed, such as the session on screen. */
    context: (id: string, text: string) => inject(get(id), text).then(() => undefined, invalid),

    stop: async (id: string) => {
      const call = calls.get(id)
      if (!call || call.closed) return
      await call.server.request("thread/realtime/stop", { threadId: call.id }).catch(() => undefined)
      call.close("stopped")
    },

    close: () => {
      calls.forEach((call) => call.close("OpenCode stopped"))
      servers.forEach((app) => app.close())
      servers.clear()
    },
  }

  function inject(call: Call, text: string) {
    return call.server.request("thread/inject_items", {
      threadId: call.id,
      items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
    })
  }
}

/** One call: its thread, the events a client reads, and the tool calls awaiting the client. */
class Call {
  closed = false
  private seq = 0
  private backlog: Event[] = []
  private waiters = new Set<() => void>()
  /** Tool calls awaiting the client, by Codex call ID, with the app-server request to answer. */
  private tools = new Map<string, string | number>()
  private sdp = Promise.withResolvers<string>()

  constructor(
    readonly server: AppServer,
    readonly id: string,
    /** Forgets the call once a closed call has lingered. */
    private readonly forget: () => void,
  ) {
    // A start that fails before the answer has nobody waiting on it.
    this.sdp.promise.catch(() => undefined)
  }

  answer() {
    const timer = setTimeout(
      () => this.sdp.reject(new CallError("Codex realtime did not answer the call in time", "unavailable")),
      ANSWER_MS,
    )
    return this.sdp.promise.finally(() => clearTimeout(timer))
  }

  notify(notification: Notification) {
    const params = notification.params
    if (notification.method === "thread/realtime/sdp") {
      const sdp = decodeSdp(params)?.sdp
      if (sdp) this.sdp.resolve(sdp)
      return
    }
    if (notification.method === "thread/realtime/transcript/delta") {
      const value = decodeTranscript(params)
      if (value?.delta) this.push({ type: "transcript", role: value.role, delta: value.delta })
      return
    }
    if (notification.method === "thread/realtime/transcript/done") {
      const value = decodeTranscript(params)
      if (value?.text !== undefined) this.push({ type: "transcript.done", role: value.role, text: value.text })
      return
    }
    if (notification.method === "turn/started") return this.push({ type: "delegation", status: "started" })
    if (notification.method === "turn/completed") return this.push({ type: "delegation", status: "completed" })
    if (notification.method === "thread/realtime/error") {
      const text = decodeMessage(params)?.message ?? "Codex realtime failed"
      this.sdp.reject(new CallError(text, "unavailable"))
      return this.push({ type: "error", message: text })
    }
    if (notification.method === "thread/realtime/closed") return this.close(decodeClosed(params)?.reason ?? undefined)
  }

  tool(request: string | number, toolID: string, name: string, args: string) {
    if (this.closed) return this.server.respond(request, failed("The voice call ended."))
    this.tools.set(toolID, request)
    this.push({ type: "tool", id: toolID, name, arguments: args })
  }

  reply(toolID: string, output: string, success: boolean) {
    const request = this.tools.get(toolID)
    if (request === undefined) return
    this.tools.delete(toolID)
    this.server.respond(request, { success, contentItems: [{ type: "inputText", text: output }] })
  }

  events(after: number): Promise<{ events: Event[]; closed: boolean }> {
    const ready = () => {
      const events = this.backlog.filter((event) => event.seq > after)
      return events.length || this.closed ? { events, closed: this.closed } : undefined
    }
    const now = ready()
    if (now) return Promise.resolve(now)
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve(ready() ?? { events: [], closed: this.closed })
      }
      const timer = setTimeout(wake, POLL_MS)
      this.waiters.add(wake)
    })
  }

  close(reason?: string) {
    if (this.closed) return
    this.push({ type: "closed", reason })
    this.closed = true
    this.sdp.reject(new CallError(reason ?? "The voice call ended", "unavailable"))
    this.tools.forEach((request) => this.server.respond(request, failed("The voice call ended.")))
    this.tools.clear()
    this.wake()
    void this.server.request("thread/unsubscribe", { threadId: this.id }).catch(() => undefined)
    setTimeout(this.forget, LINGER_MS).unref?.()
  }

  private push(event: EventBody) {
    if (this.closed) return
    this.seq++
    this.backlog.push({ ...event, seq: this.seq })
    if (this.backlog.length > BACKLOG) this.backlog.splice(0, this.backlog.length - BACKLOG)
    this.wake()
  }

  private wake() {
    this.waiters.forEach((wake) => wake())
  }
}

const failed = (text: string) => ({ success: false, contentItems: [{ type: "inputText", text }] })

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const unavailable = (error: unknown): never => {
  if (error instanceof CallError) throw error
  throw new CallError(friendly(message(error)), "unavailable")
}

const invalid = (error: unknown): never => {
  if (error instanceof CallError) throw error
  throw new CallError(message(error), "invalid")
}

/** Codex's own wording, plus what to do about the failures people hit first. */
const friendly = (text: string) => {
  if (/ENOENT|Could not start/.test(text))
    return `${text}. Install the Codex CLI or set voice.codex.command to its path.`
  if (/API key auth|requires OpenAI auth|not logged in|login/i.test(text))
    return `${text}. Sign in with \`codex login\` on the server.`
  return text
}
