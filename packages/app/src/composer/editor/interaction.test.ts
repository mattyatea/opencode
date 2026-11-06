import { expect, test } from "bun:test"
import { shouldHandlePasteAsAttachment } from "./interaction"

test("handles clipboard files, and native images only when the clipboard has no text", () => {
  expect(shouldHandlePasteAsAttachment(clipboard(), false)).toBe(false)
  expect(shouldHandlePasteAsAttachment(clipboard(), true)).toBe(true)
  expect(shouldHandlePasteAsAttachment(clipboard(["text/plain"]), true)).toBe(false)
  expect(shouldHandlePasteAsAttachment(clipboard([], [{ kind: "file" }]), false)).toBe(true)
})

test("routes only large plain text to attachments when paste files is enabled", () => {
  const data = new DataTransfer()
  data.setData("text/plain", "界".repeat(8000))
  expect(shouldHandlePasteAsAttachment(data, false, true)).toBe(true)
  expect(shouldHandlePasteAsAttachment(data, false, false)).toBe(false)
  data.setData("text/plain", "line\r\n".repeat(120))
  expect(shouldHandlePasteAsAttachment(data, false, true)).toBe(true)
  data.setData("text/plain", "small\npaste")
  expect(shouldHandlePasteAsAttachment(data, true, true)).toBe(false)
})

function clipboard(types: string[] = [], items: Array<{ kind: string }> = []) {
  return { types, items } as unknown as DataTransfer
}
