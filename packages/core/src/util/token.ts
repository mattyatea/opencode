export * as Token from "./token.js"

/**
 * A tokenizer-free estimate. Measured against o200k and cl100k: ASCII text and code run about 4 characters per token,
 * CJK about 1 token per character, and most other scripts (Cyrillic, Arabic, Devanagari, Thai, ...) about 2 characters
 * per token or more. Counting everything at 4 characters per token underestimated Japanese text 2.5-4x.
 */
export const estimate = (input: string) => {
  // Counted in quarter tokens. A plain loop, because this runs over whole conversations on every step and an array
  // per character would cost more than the count.
  let quarters = 0
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index)
    quarters += code < 0x80 ? 1 : isCJK(code) ? 4 : 2
  }
  return Math.round(quarters / 4)
}

/** Kana, CJK ideographs and punctuation, Hangul syllables, and full-width forms. */
const isCJK = (code: number) =>
  (code >= 0x3000 && code <= 0x30ff) ||
  (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0xac00 && code <= 0xd7af) ||
  (code >= 0xff00 && code <= 0xffef)
