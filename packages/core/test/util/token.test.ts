import { describe, expect, test } from "bun:test"
import { Token } from "@opencode/core/util/token"

describe("Token.estimate", () => {
  test("counts ASCII text at 4 characters per token", () => {
    expect(Token.estimate("")).toBe(0)
    expect(Token.estimate("abcd".repeat(25))).toBe(25)
  })

  test("counts CJK text at 1 token per character", () => {
    // Kana, kanji, CJK punctuation, Hangul, and a full-width letter.
    expect(Token.estimate("トークンの見積もり。")).toBe(10)
    expect(Token.estimate("토큰")).toBe(2)
    expect(Token.estimate("Ａ")).toBe(1)
  })

  test("counts other non-ASCII text at 2 characters per token", () => {
    expect(Token.estimate("токен")).toBe(3)
  })

  test("adds the parts of mixed text", () => {
    // 8 ASCII characters and 4 kanji.
    expect(Token.estimate("context 見積誤差")).toBe(6)
  })
})
