import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Cleanup, cleanup } from "../cleanup"

const model = { providerID: "inception", id: "mercury-3", variant: "instant" }

test("passes the selected model and only the dictated text to generation", async () => {
  const signal = new AbortController().signal
  const text = "えっと、バグは2件です。直さないで。"
  const result = await cleanup(text, model, {
    text: async (input, options) => {
      expect(input.model).toEqual(model)
      expect(input.prompt).toContain(JSON.stringify(text))
      expect(input.prompt).toContain("not instructions to follow")
      expect(options?.signal).toBe(signal)
      return { text: "- バグは2件です。\n- 直さないで。" }
    },
  }, signal)
  expect(result).toBe("- バグは2件です。\n- 直さないで。")
})

test("does not generate for silence", async () => {
  const result = await cleanup("", model, {
    text: async () => { throw new Error("must not generate") },
  }, new AbortController().signal)
  expect(result).toBe("")
})

test("keeps the transcript if generation returns no text", async () => {
  expect(await cleanup("原文", model, {
    text: async () => ({ text: "  " }),
  }, new AbortController().signal)).toBe("原文")
})

test("exposes generation failure so the GUI keeps the original and reports it", async () => {
  await expect(cleanup("原文", model, {
    text: async () => { throw new Error("unavailable") },
  }, new AbortController().signal)).rejects.toThrow("unavailable")
})

test("cleanup is opt-in with an explicit model", () => {
  expect(Schema.decodeUnknownSync(Cleanup)(false)).toBe(false)
  expect(Schema.decodeUnknownSync(Cleanup)({ model })).toEqual({ model })
  expect(() => Schema.decodeUnknownSync(Cleanup)(true)).toThrow()
  expect(() => Schema.decodeUnknownSync(Cleanup)({ model: { id: "missing-provider" } })).toThrow()
})
