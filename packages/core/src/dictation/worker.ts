import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
// Imported as text so compiled binaries carry the worker; it runs through `python -c`.
import source from "./worker.py" with { type: "text" }

/**
 * The model for languages the fast model lacks and for phrases with a registered term, unless
 * `OPENCODE_DICTATION_MODEL` names another. It follows hotwords.
 */
export const DEFAULT_MODEL = "mlx-community/Qwen3-ASR-0.6B-8bit"
/**
 * Writes the languages it knows unless `OPENCODE_DICTATION_FAST_MODEL` names another or is empty. Measured on an M3 Pro
 * against the main model, about 8 times faster with half the errors on read Japanese, but it spells English terms out
 * in kana and takes no hotwords.
 */
export const DEFAULT_FAST_MODEL = "ibm-granite/granite-speech-5.0-470m-turboctc"
/** The mlx-audio release the worker is tested with. */
export const MLX_AUDIO = "mlx-audio==0.6.5"

/** How to start the Python worker and what it transcribes with. */
export interface Config {
  readonly executable: string
  readonly args: readonly string[]
  readonly model: string
  /** Empty when the main model writes everything. */
  readonly fastModel: string
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

/**
 * Reads the worker settings from the environment. Without `OPENCODE_DICTATION_PYTHON`, uv builds and caches a Python
 * with mlx-audio on first use.
 */
export function config(env: Record<string, string | undefined> = process.env): Config {
  const python = env.OPENCODE_DICTATION_PYTHON || undefined
  return {
    executable: python ?? (env.OPENCODE_DICTATION_UV || "uv"),
    args: python
      ? ["-c", source]
      : ["run", "--no-project", "--python", "3.12", "--with", MLX_AUDIO, "python", "-c", source],
    model: env.OPENCODE_DICTATION_MODEL || DEFAULT_MODEL,
    fastModel: env.OPENCODE_DICTATION_FAST_MODEL ?? DEFAULT_FAST_MODEL,
    // No default: a hotword pulls similar-sounding speech toward itself ("useEffect" came back as "OpenCode").
    hotwords: (env.OPENCODE_DICTATION_HOTWORDS ?? "")
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean),
  }
}

/**
 * Every Location shares one model: a second worker would load it into memory again. Workers are shared by
 * configuration and stop when their last Location releases them.
 */
const shared = new Map<string, { worker: Worker; users: number }>()

export function acquire(input: Config) {
  const key = JSON.stringify(input)
  const entry = shared.get(key) ?? { worker: createWorker(input), users: 0 }
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

export function createWorker(input: Config) {
  const pending = new Map<number, { resolve: (reply: Reply) => void; reject: (error: WorkerError) => void }>()
  const log: string[] = []
  const state: { child?: ChildProcessWithoutNullStreams; next: number } = { next: 0 }
  const tail = () => log.slice(-20).join("\n")

  const start = () => {
    const child = spawn(input.executable, [...input.args], {
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        OPENCODE_DICTATION_MODEL: input.model,
        OPENCODE_DICTATION_FAST_MODEL: input.fastModel,
        OPENCODE_DICTATION_HOTWORDS: input.hotwords.join("\n"),
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
    child.on("error", (error) => fail(`Could not start ${input.executable}: ${error.message}`))
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
    /** Reads the model configuration only, not its weights. */
    languages: () =>
      request({ op: "languages" }).then((reply) =>
        Array.isArray(reply.languages)
          ? reply.languages.filter((value): value is string => typeof value === "string")
          : [],
      ),
    /** Starts the worker and loads the model. Resolves with the model's name. */
    load: () => request({ op: "load" }).then((reply) => String(reply.model)),
    /** Appends PCM audio to a dictation and resolves with its transcript so far and the part of it now settled. */
    transcribe: (session: string, audio: string, final: boolean, language?: string) =>
      request({ op: "transcribe", session, audio, final, language }).then((reply) => ({
        text: String(reply.text ?? ""),
        committed: String(reply.committed ?? ""),
      })),
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
