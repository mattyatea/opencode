import { describe, expect, test } from "bun:test"
import { DictationWorker } from "../src/dictation/index.js"

// The real worker needs a Python with numpy (and mlx-audio to transcribe speech). Silence and protocol errors are
// answered before the model loads, so these tests run without downloading a model.
const python = process.env.OPENCODE_DICTATION_PYTHON

describe.skipIf(!python)("dictation worker", () => {
  const start = () => DictationWorker.createWorker(DictationWorker.config({ OPENCODE_DICTATION_PYTHON: python }))

  test("answers silence without loading the model", async () => {
    const worker = start()
    const silence = Buffer.alloc(16000 * 2).toString("base64")
    expect(await worker.transcribe("a", silence, false)).toEqual({ text: "", committed: "" })
    expect(await worker.transcribe("a", silence, true)).toEqual({ text: "", committed: "" })
    await worker.cancel("a")
    worker.close()
  })

  test("rejects a failed request with the worker's log", async () => {
    const worker = start()
    const error = await worker.transcribe("a", "not base64!", true).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DictationWorker.WorkerError)
    if (error instanceof DictationWorker.WorkerError) expect(error.log).toContain("Traceback")
    worker.close()
  })
})

test("rejects pending requests when the worker cannot start", async () => {
  const worker = DictationWorker.createWorker(
    DictationWorker.config({ OPENCODE_DICTATION_PYTHON: "/nonexistent/python" }),
  )
  const error = await worker.load().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(DictationWorker.WorkerError)
  expect(String(error)).toContain("/nonexistent/python")
})

test("builds the Python environment with uv unless a Python is configured", () => {
  const config = DictationWorker.config({ OPENCODE_DICTATION_HOTWORDS: "OpenCode, MLX ," })
  expect(config.executable).toBe("uv")
  expect(config.args).toContain(DictationWorker.MLX_AUDIO)
  expect(config.model).toBe(DictationWorker.DEFAULT_MODEL)
  expect(config.hotwords).toEqual(["OpenCode", "MLX"])
})

test("shares one worker between users of the same configuration", () => {
  const config = DictationWorker.config({ OPENCODE_DICTATION_PYTHON: "/nonexistent/python" })
  const first = DictationWorker.acquire(config)
  const second = DictationWorker.acquire(config)
  expect(second.worker).toBe(first.worker)
  first.release()
  second.release()
  const third = DictationWorker.acquire(config)
  expect(third.worker).not.toBe(first.worker)
  third.release()
})
