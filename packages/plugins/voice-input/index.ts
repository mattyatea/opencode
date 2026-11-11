import { Plugin } from "@opencode/plugin"
import { Dictation } from "./rpc"
import { acquire, script, WorkerError, type WorkerConfig } from "./worker"

/** The model the plugin transcribes with unless `options.model` names another. Chosen by measurement; see README. */
export const DEFAULT_MODEL = "mlx-community/Qwen3-ASR-0.6B-8bit"
/** The mlx-audio release the worker is tested with. */
export const MLX_AUDIO = "mlx-audio==0.6.5"

export default Plugin.define({
  id: "opencode.voice-input",
  async setup(ctx) {
    const lease = acquire(config(ctx.options))
    const failure = (error: unknown) =>
      error instanceof WorkerError
        ? { message: error.message, log: error.log }
        : { message: error instanceof Error ? error.message : String(error), log: "" }

    await ctx.rpc.register(Dictation, {
      prepare: async (_input, call) => {
        if (process.platform !== "darwin" || process.arch !== "arm64")
          return call.error("worker", "Voice input runs MLX models, which need a Mac with Apple Silicon.", { log: "" })
        return lease.worker.load().then(
          (model) => ({ model }),
          (error) => {
            const detail = failure(error)
            return call.error("worker", detail.message, { log: detail.log })
          },
        )
      },
      transcribe: async (input, call) =>
        lease.worker.transcribe(input.session, input.audio, input.final).then(
          (text) => ({ text }),
          (error) => {
            const detail = failure(error)
            return call.error("worker", detail.message, { log: detail.log })
          },
        ),
      cancel: async (input) => {
        await lease.worker.cancel(input.session).catch(() => undefined)
        return {}
      },
    })

    return () => lease.release()
  },
})

function config(options: Readonly<Record<string, unknown>>): WorkerConfig {
  const text = (key: string) => (typeof options[key] === "string" && options[key] ? options[key] : undefined)
  const python = text("python")
  const hotwords = Array.isArray(options.hotwords)
    ? options.hotwords.filter((word): word is string => typeof word === "string")
    : // No default: a hotword pulls similar-sounding speech toward itself ("useEffect" came back as "OpenCode").
      []
  return {
    // Without a Python of their own, uv builds and caches an environment with mlx-audio on first use.
    executable: python ?? text("uv") ?? "uv",
    args: python ? [script] : ["run", "--no-project", "--python", "3.12", "--with", MLX_AUDIO, "python", script],
    model: text("model") ?? DEFAULT_MODEL,
    language: text("language"),
    hotwords,
  }
}
