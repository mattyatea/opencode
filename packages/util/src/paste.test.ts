import { expect, test } from "bun:test"
import { largePaste } from "./paste.js"

test.each([
  ["x".repeat(7999), false],
  ["界".repeat(8000), true],
  ["\n".repeat(119), false],
  ["\n".repeat(120), true],
] as const)("large paste threshold %#", (text, expected) => {
  expect(largePaste(text)).toBe(expected)
})
