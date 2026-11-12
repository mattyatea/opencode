/** Sample rate the worker transcribes at. */
export const RATE = 16000

/** Converts float samples in [-1, 1] to little-endian 16-bit PCM, clamping out-of-range values. */
export function toPcm16(samples: Float32Array) {
  const pcm = new Int16Array(samples.length)
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    pcm[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  })

  return pcm
}

/** Joins captured PCM chunks and encodes them as base64 for the server. */
export function encodeChunks(chunks: readonly Int16Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const joined = new Int16Array(total)
  chunks.reduce((offset, chunk) => {
    joined.set(chunk, offset)

    return offset + chunk.length
  }, 0)
  const bytes = new Uint8Array(joined.buffer)

  // String.fromCharCode takes arguments on the stack; encode in slices so long buffers never overflow it.
  const parts = Array.from({ length: Math.ceil(bytes.length / 0x8000) }, (_, index) =>
    String.fromCharCode(...bytes.subarray(index * 0x8000, (index + 1) * 0x8000)),
  )

  return btoa(parts.join(""))
}

/** Root-mean-square level of a block, for the button's level meter. */
export function level(samples: Float32Array) {
  if (samples.length === 0) return 0
  const sum = samples.reduce((total, sample) => total + sample * sample, 0)

  return Math.sqrt(sum / samples.length)
}

/**
 * The prompt with the dictation so far: the text the prompt held when dictation started, then the transcript. A
 * space separates them only when the prompt ends in Latin text and the transcript starts with Latin text, since
 * Japanese runs together.
 */
export function withTranscript(base: string, transcript: string) {
  if (!transcript) return base

  if (!base || /\s$/.test(base)) return base + transcript
  const latin = /[\x21-\x7e]$/.test(base) && /^[\x21-\x7e]/.test(transcript)

  return latin ? `${base} ${transcript}` : base + transcript
}
