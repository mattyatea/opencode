import { describe, expect, test } from "bun:test"
import { createWorker, script, WorkerError } from "../worker"

// The real worker needs a Python with numpy (and mlx-audio to transcribe speech). Silence and protocol errors are
// answered before the model loads, so these tests run without downloading a model.
const python = process.env.OPENCODE_VOICE_PYTHON

describe.skipIf(!python)("worker", () => {
  const start = () => createWorker({ executable: python!, args: [script], model: "unused", hotwords: [] })

  test("answers silence without loading the model", async () => {
    const worker = start()
    const silence = Buffer.alloc(16000 * 2).toString("base64")
    expect(await worker.transcribe("a", silence, false)).toBe("")
    expect(await worker.transcribe("a", silence, true)).toBe("")
    await worker.cancel("a")
    worker.close()
  })

  test("rejects a failed request with the worker's log", async () => {
    const worker = start()
    const error = await worker.transcribe("a", "not base64!", true).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(WorkerError)
    if (error instanceof WorkerError) expect(error.log).toContain("Traceback")
    worker.close()
  })
})

test("rejects pending requests when the worker cannot start", async () => {
  const worker = createWorker({ executable: "/nonexistent/python", args: [script], model: "unused", hotwords: [] })
  const error = await worker.load().catch((error: unknown) => error)
  expect(error).toBeInstanceOf(WorkerError)
  expect(String(error)).toContain("/nonexistent/python")
})
