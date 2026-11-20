import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { Option, Schema } from "effect"

/** How to start `codex app-server`; processes are shared by these settings. */
export interface Options {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** A JSON-RPC error from app-server, or the process failing, with the end of its stderr. */
export class AppServerError extends Error {
  constructor(
    message: string,
    readonly log: string,
  ) {
    super(message)
  }
}

export type Notification = { readonly method: string; readonly params: unknown }
export type ServerRequest = { readonly id: string | number; readonly method: string; readonly params: unknown }

const Message = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.String })),
})
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message))

/**
 * Codex CLI app-server spoken over stdio JSON-RPC (one JSON object per line). It starts on the first request,
 * initializes with the experimental API that thread realtime needs, and starts again after it exits.
 */
export function createAppServer(options: Options) {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: AppServerError) => void }>()
  const notifications = new Set<(notification: Notification) => void>()
  const requests = new Set<(request: ServerRequest) => boolean>()
  const log: string[] = []
  const state: { child?: ChildProcessWithoutNullStreams; ready?: Promise<void>; next: number } = { next: 1 }
  const tail = () => log.slice(-20).join("\n")

  const write = (child: ChildProcessWithoutNullStreams, message: Record<string, unknown>) =>
    child.stdin.write(JSON.stringify(message) + "\n")

  const receive = (child: ChildProcessWithoutNullStreams, line: string) => {
    const message = Option.getOrUndefined(decodeMessage(line))
    if (!message) return void log.push(line)
    if (message.method !== undefined && message.id !== undefined) {
      const request = { id: message.id, method: message.method, params: message.params }
      // A request no call claims still needs an answer, or the Codex turn waits forever.
      if (![...requests].some((handle) => handle(request)))
        write(child, { id: message.id, error: { code: -32601, message: `Unsupported request: ${message.method}` } })
      return
    }
    if (message.method !== undefined) {
      const notification = { method: message.method, params: message.params }
      return notifications.forEach((listen) => listen(notification))
    }
    if (typeof message.id !== "number") return
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) return waiter?.reject(new AppServerError(message.error.message, tail()))
    waiter?.resolve(message.result)
  }

  const start = () => {
    const child = spawn(options.command, ["app-server", ...options.args], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    createInterface({ input: child.stdout }).on("line", (line) => receive(child, line))
    createInterface({ input: child.stderr }).on("line", (line) => {
      log.push(line)
      if (log.length > 200) log.splice(0, log.length - 200)
    })
    child.on("error", (error) => stop(child, `Could not start ${options.command}: ${error.message}`))
    child.on("exit", (code, signal) => stop(child, `Codex app-server exited (${signal ?? `code ${code}`})`))
    state.child = child
    state.ready = call(child, "initialize", {
      clientInfo: { name: "opencode", title: "OpenCode", version: "voice" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }).then(
      () => void write(child, { method: "initialized" }),
      (error) => {
        // A process that answered initialize with an error can't serve requests; the next one starts fresh.
        stop(child, "Codex app-server failed to initialize")
        throw error
      },
    )
    return state.ready
  }

  /** Ends one process: its requests fail and calls on it close. A process already replaced is left alone. */
  const stop = (child: ChildProcessWithoutNullStreams, message: string) => {
    if (state.child !== child) return
    state.child = undefined
    state.ready = undefined
    child.stdin.end()
    child.kill()
    const error = new AppServerError(message, tail())
    pending.forEach((waiter) => waiter.reject(error))
    pending.clear()
    notifications.forEach((listen) => listen({ method: "opencode/exited", params: { message } }))
  }

  const close = () => {
    if (state.child) stop(state.child, "Codex app-server stopped")
  }

  const call = (child: ChildProcessWithoutNullStreams, method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = state.next++
      pending.set(id, { resolve, reject })
      write(child, { id, method, params })
    })

  return {
    request: async (method: string, params: unknown) => {
      await (state.ready ?? start())
      const child = state.child
      if (!child) throw new AppServerError("Codex app-server is not running", tail())
      return call(child, method, params)
    },
    /** Answers a request from app-server, such as a dynamic tool call. */
    respond: (id: string | number, result: unknown) => {
      if (state.child) write(state.child, { id, result })
    },
    onNotification: (listen: (notification: Notification) => void) => {
      notifications.add(listen)
      return () => void notifications.delete(listen)
    },
    /** The handler returns true when it takes the request and will answer it with `respond`. */
    onRequest: (handle: (request: ServerRequest) => boolean) => {
      requests.add(handle)
      return () => void requests.delete(handle)
    },
    close,
  }
}

export type AppServer = ReturnType<typeof createAppServer>
