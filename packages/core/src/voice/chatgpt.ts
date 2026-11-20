import { Option, Schema } from "effect"
import type { Socket } from "effect/socket"

/**
 * GPT-Live on a ChatGPT plan, the way the Codex CLI starts its voice: the call is created on the ChatGPT backend with
 * a Codex sign-in, audio flows between the client and OpenAI over WebRTC, and the server joins the call's sideband
 * WebSocket. Delegation targets the client, so every request the voice delegates arrives here for OpenCode to answer.
 */

const CALLS_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas"
const SIDEBAND_URL = "wss://api.openai.com/v1/live/"
/** How long an events request waits for something to happen before the client asks again. */
const POLL_MS = 20_000
/** Events a call keeps for a client that falls behind; older ones only fed captions. */
const BACKLOG = 2_000
/** How long a closed call keeps answering its events so the client sees why it closed. */
const LINGER_MS = 60_000

/** A Codex sign-in to the ChatGPT plan. */
export interface Credentials {
  readonly token: string
  readonly account?: string
}

export interface SessionOptions {
  readonly instructions: string
  readonly voice?: string
  readonly model?: string
  readonly ackFiller?: boolean
}

type EventBody =
  | { readonly type: "transcript"; readonly role: "user" | "assistant"; readonly delta: string }
  | { readonly type: "transcript.done"; readonly role: "user" | "assistant"; readonly text: string }
  | { readonly type: "delegation"; readonly id: string; readonly status: "started" | "completed" }
  | { readonly type: "open"; readonly sessionID: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly reason?: string }

/** What happened on a call, numbered so a client that asks again gets only what it hasn't seen. */
export type Event = EventBody & { readonly seq: number }

/** A request the voice delegated: what the user asked, as the voice heard it. */
export interface Delegation {
  readonly id: string
  readonly text: string
}

export class CallError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "unavailable",
  ) {
    super(message)
  }
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => Socket.WebSocketLike

/** WebSocket readyState for an open connection. */
const OPEN = 1

const Message = Schema.Struct({
  type: Schema.String,
  item: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      target: Schema.optional(Schema.String),
      content: Schema.optional(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  turn: Schema.optional(
    Schema.Struct({ role: Schema.optional(Schema.String), transcript: Schema.optional(Schema.String) }),
  ),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export function createChatGPTVoice(input: {
  readonly socket: WebSocketFactory
  /** Answers one delegation; the text it returns is what the voice says. Calls run one delegation at a time. */
  readonly delegate: (call: Call, delegation: Delegation) => Promise<string>
}) {
  const calls = new Map<string, Call>()

  const get = (id: string) => {
    const call = calls.get(id)
    if (!call) throw new CallError(`Unknown voice call: ${id}`, "invalid")
    return call
  }

  return {
    start: async (credentials: Credentials, sdp: string, session: SessionOptions) => {
      const headers = authHeaders(credentials)
      const response = await fetch(CALLS_URL, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: encodeJson({
          sdp,
          session: {
            instructions: session.instructions,
            audio: { output: { voice: session.voice ?? "cove" } },
            delegation: {
              type: "client",
              ...(session.ackFiller === undefined ? {} : { ack_filler: session.ackFiller }),
            },
            ...(session.model ? { model: session.model } : {}),
          },
        }),
      }).catch((error: unknown) => {
        throw new CallError(`Could not reach ChatGPT: ${message(error)}`, "unavailable")
      })
      const text = await response.text()
      if (!response.ok) throw new CallError(callFailure(response.status, text), "unavailable")
      const id = response.headers.get("location")?.split("/").filter(Boolean).at(-1)
      if (!id) throw new CallError("ChatGPT answered the call without its ID", "unavailable")
      const call: Call = new Call(
        id,
        input.socket(`${SIDEBAND_URL}${encodeURIComponent(id)}`, headers),
        (delegation) => input.delegate(call, delegation),
        () => calls.get(id) === call && calls.delete(id),
      )
      calls.set(id, call)
      return { call: id, sdp: text }
    },

    get,

    events: (id: string, after: number) => get(id).events(after),

    /** Has the voice say text, such as a session's reply that landed while nobody asked. */
    speech: (id: string, text: string) => get(id).send({ type: "session.context.append", content: [inputText(text)] }),

    stop: (id: string) => calls.get(id)?.close("stopped"),

    close: () => calls.forEach((call) => call.close("OpenCode stopped")),
  }
}

/** One call: its sideband, the events a client reads, and the delegations OpenCode answers in order. */
export class Call {
  closed = false
  private seq = 0
  private backlog: Event[] = []
  private waiters = new Set<() => void>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly id: string,
    private readonly socket: Socket.WebSocketLike,
    private readonly delegate: (delegation: Delegation) => Promise<string>,
    private readonly forget: () => void,
  ) {
    socket.addEventListener("message", (event) => this.receive(String(event.data)))
    socket.addEventListener("close", (event) => this.close(event.reason || "The call ended"))
    socket.addEventListener("error", () =>
      this.push({ type: "error", message: "The call's control connection failed" }),
    )
  }

  /** Records something for the client, such as a session OpenCode asks it to show. */
  push(event: EventBody) {
    if (this.closed) return
    this.seq++
    this.backlog.push({ ...event, seq: this.seq })
    if (this.backlog.length > BACKLOG) this.backlog.splice(0, this.backlog.length - BACKLOG)
    this.waiters.forEach((wake) => wake())
  }

  send(message: Record<string, unknown>) {
    if (this.closed || this.socket.readyState !== OPEN)
      throw new CallError("The voice call is not connected", "invalid")
    this.socket.send(encodeJson(message))
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
    // Recorded before waking anyone, so a waiting events request reports the call as closed.
    this.seq++
    this.backlog.push({ type: "closed", reason, seq: this.seq })
    this.closed = true
    this.waiters.forEach((wake) => wake())
    if (this.socket.readyState === OPEN) {
      this.socket.send(encodeJson({ type: "session.close" }))
      this.socket.close()
    }
    setTimeout(this.forget, LINGER_MS).unref?.()
  }

  private receive(raw: string) {
    const message = Option.getOrUndefined(decodeMessage(raw))
    if (!message) return
    if (message.type === "input_transcript.added" || message.type === "output_transcript.added") {
      const delta = message.item?.text
      if (delta) this.push({ type: "transcript", role: role(message.type), delta })
      return
    }
    if (message.type === "turn.done") {
      const turn = message.turn
      if (turn?.transcript !== undefined && (turn.role === "user" || turn.role === "assistant"))
        this.push({ type: "transcript.done", role: turn.role, text: turn.transcript })
      return
    }
    if (message.type === "delegation.created") {
      const item = message.item
      if (item?.type !== "delegation" || item.target !== "client" || !item.id) return
      const text = (item.content ?? []).flatMap((part) => (part.type === "input_text" && part.text ? [part.text] : []))
      return this.answer({ id: item.id, text: text.join("") })
    }
    if (message.type === "error") this.push({ type: "error", message: message.error?.message ?? "The voice failed" })
  }

  /** Answers delegations one at a time, so the voice hears results in the order it asked. */
  private answer(delegation: Delegation) {
    this.queue = this.queue.then(async () => {
      if (this.closed) return
      this.push({ type: "delegation", id: delegation.id, status: "started" })
      const text = await this.delegate(delegation).catch(
        (error: unknown) => `OpenCode could not finish that request: ${message(error)}. Do not claim it succeeded.`,
      )
      this.push({ type: "delegation", id: delegation.id, status: "completed" })
      if (this.closed) return
      try {
        this.send({ type: "delegation.context.append", delegation_item_id: delegation.id, content: [inputText(text)] })
      } catch {
        // The call ended while OpenCode worked; nobody is left to hear the answer.
      }
    })
  }
}

function authHeaders(credentials: Credentials) {
  return {
    authorization: `Bearer ${credentials.token}`,
    originator: "opencode",
    "openai-alpha": "quicksilver=v2",
    ...(credentials.account ? { "chatgpt-account-id": credentials.account } : {}),
  }
}

const inputText = (text: string) => ({ type: "input_text", text })

const role = (type: string) => (type === "input_transcript.added" ? ("user" as const) : ("assistant" as const))

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function callFailure(status: number, body: string) {
  if (status === 401 || status === 403)
    return `ChatGPT rejected the sign-in (${status}). Sign in again with Codex (legacy) in OpenCode, or run the Codex CLI once to refresh its sign-in.`
  if (status === 429) return "ChatGPT's voice limit for this plan is used up for now."
  return `ChatGPT could not start the call (${status}): ${body.slice(0, 300)}`
}
