import { expect, test } from "bun:test"
import { encodeChunks, level, toPcm16, withTranscript } from "../src/pcm"

test("converts float samples to clamped 16-bit PCM", () => {
  expect([...toPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]))]).toEqual([0, 32767, -32768, 32767, -32768, 16383])
})

test("encodes chunks as little-endian base64 in order", () => {
  const encoded = encodeChunks([new Int16Array([1, -2]), new Int16Array([258])])
  expect([...Buffer.from(encoded, "base64")]).toEqual([1, 0, 0xfe, 0xff, 2, 1])
})

test("encodes buffers longer than one argument slice", () => {
  const samples = new Int16Array(16000 * 30).map((_, index) => index % 1000)
  const decoded = Buffer.from(encodeChunks([samples]), "base64")
  expect(new Int16Array(decoded.buffer, decoded.byteOffset, decoded.length / 2)).toEqual(samples)
})

test("measures the RMS level", () => {
  expect(level(new Float32Array())).toBe(0)
  expect(level(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5)
})

test("appends the transcript to the prompt it started from", () => {
  expect(withTranscript("", "こんにちは")).toBe("こんにちは")
  expect(withTranscript("修正して。", "")).toBe("修正して。")
  expect(withTranscript("修正して。", "次に")).toBe("修正して。次に")
  expect(withTranscript("Fix", "useEffect")).toBe("Fix useEffect")
  expect(withTranscript("Fix ", "useEffect")).toBe("Fix useEffect")
  expect(withTranscript("修正", "useEffect")).toBe("修正useEffect")
})
