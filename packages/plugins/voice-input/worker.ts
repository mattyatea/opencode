import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"

/** How to start the Python worker and what it transcribes with. */
export interface WorkerConfig {
  readonly executable: string
  readonly args: readonly string[]
  readonly model: string
  readonly language?: string
  readonly hotwords: readonly string[]
}

/** A request the worker failed, or the worker exiting, with the end of its log. */
export class WorkerError extends Error {
  constructor(
    message: string,
    readonly log: string,
  ) {
    super(message)
  }
}

type Reply = { readonly id: number; readonly error?: string } & Record<string, unknown>

/** The plugin's worker script, which runs beside this file. */
export const script = fileURLToPath(new URL("./worker.py", import.meta.url))

/**
 * Plugins set up once per Location, but every Location shares one model: a second worker would load the model into
 * memory again. Workers are shared by configuration and stop when their last Location releases them.
 */
const shared = new Map<string, { worker: Worker; users: number }>()

export function acquire(config: WorkerConfig) {
  const key = JSON.stringify(config)
  const entry = shared.get(key) ?? { worker: createWorker(config), users: 0 }
  entry.users++
  shared.set(key, entry)
  return {
    worker: entry.worker,
    release: () => {
      entry.users--
      if (entry.users > 0) return
      shared.delete(key)
      entry.worker.close()
    },
  }
}

export type Worker = ReturnType<typeof createWorker>

export function createWorker(config: WorkerConfig) {
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: WorkerError) => void }>()
  const log: string[] = []
  const state: { child?: ChildProcessWithoutNullStreams; next: number } = { next: 0 }
  const tail = () => log.slice(-20).join("\n")

  const start = () => {
    const child = spawn(config.executable, [...config.args], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        OPENCODE_VOICE_MODEL: config.model,
        OPENCODE_VOICE_LANGUAGE: config.language ?? "",
        OPENCODE_VOICE_HOTWORDS: config.hotwords.join("\n"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    createInterface({ input: child.stdout }).on("line", (line) => {
      const reply = parseReply(line)
      if (!reply) return void log.push(line)
      const waiter = pending.get(reply.id)
      pending.delete(reply.id)
      waiter?.resolve(reply)
    })
    createInterface({ input: child.stderr }).on("line", (line) => {
      log.push(line)
      if (log.length > 200) log.splice(0, log.length - 200)
    })
    const fail = (message: string) => {
      if (state.child === child) state.child = undefined
      const error = new WorkerError(message, tail())
      pending.forEach((waiter) => waiter.reject(error))
      pending.clear()
    }
    child.on("error", (error) => fail(`Could not start ${config.executable}: ${error.message}`))
    child.on("exit", (code, signal) => fail(`The transcription worker exited (${signal ?? `code ${code}`})`))
    state.child = child
    return child
  }

  const request = (body: Record<string, unknown>) =>
    new Promise<Reply>((resolve, reject) => {
      const child = state.child ?? start()
      const id = state.next++
      pending.set(id, {
        resolve: (reply) => (reply.error ? reject(new WorkerError(reply.error, tail())) : resolve(reply)),
        reject,
      })
      child.stdin.write(JSON.stringify({ ...body, id }) + "\n")
    })

  return {
    /** Starts the worker and loads the model. Resolves with the model's name. */
    load: () => request({ op: "load" }).then((reply) => String(reply.model)),
    /** Appends PCM audio to a dictation and resolves with its transcript so far. */
    transcribe: (session: string, audio: string, final: boolean) =>
      request({ op: "transcribe", session, audio, final }).then((reply) => String(reply.text ?? "")),
    /** Drops a dictation. */
    cancel: (session: string) => request({ op: "cancel", session }).then(() => undefined),
    close: () => {
      state.child?.stdin.end()
      state.child?.kill()
      state.child = undefined
    },
  }
}

function parseReply(line: string): Reply | undefined {
  if (!line.startsWith("{")) return undefined
  const value: unknown = JSON.parse(line)
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "number") return undefined
  // SAFETY: an object with a numeric id is the worker's reply shape; other fields are read with String() above.
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  return value as Reply
}
