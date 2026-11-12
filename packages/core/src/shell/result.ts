export * as ShellResult from "./result.js"

import type { Shell } from "@opencode/schema/shell"

export type Result = {
  info: Shell.Info
  capture: { output: string; truncated: boolean } | undefined
}

type Output = { output: string; truncated: boolean; exit?: number; signal?: string; timeout?: boolean }

const missing = "Shell command output is no longer available."
export const unavailable: Shell.Output = {
  output: missing,
  cursor: Buffer.byteLength(missing),
  size: Buffer.byteLength(missing),
  truncated: false,
}

export function output(result: Result): Output {
  return {
    output: result.capture?.output ?? unavailable.output,
    truncated: result.capture?.truncated ?? false,
    ...(result.info.exit !== undefined ? { exit: result.info.exit } : {}),
    ...(result.info.signal !== undefined ? { signal: result.info.signal } : {}),
    ...(result.info.status === "timeout" ? { timeout: true } : {}),
  }
}

export function notice(output: Pick<Output, "exit" | "signal" | "timeout">) {
  if (output.timeout) return "Timed out before completion"
  if (output.signal !== undefined) return `Killed by ${output.signal}`
  if (output.exit !== undefined && output.exit !== 0) return `Exited with code ${output.exit}`
}

export function metadata(output: Output) {
  return {
    truncated: output.truncated,
    ...(output.exit !== undefined ? { exit: output.exit } : {}),
    ...(output.signal !== undefined ? { signal: output.signal } : {}),
    ...(output.timeout !== undefined ? { timeout: output.timeout } : {}),
  }
}

const COMMAND_LABEL_MAX = 200

/**
 * The command as a completion notice names it. The agent's own tool call already holds the full command, so a
 * notice for an agent-started job only needs enough to identify it.
 */
export function commandLabel(command: string) {
  const chars = Array.from(command)
  if (chars.length <= COMMAND_LABEL_MAX) return command
  return `${chars.slice(0, COMMAND_LABEL_MAX).join("")}… [${chars.length - COMMAND_LABEL_MAX} more characters in the original tool call]`
}

// Keep more of the end, where successful commands usually print their summary.
const SUCCESS_MAX_CHARS = 15_000

/** Keeps the head and tail of a long successful output by whole lines, pointing to the saved full output. */
export function boundSuccess(text: string, file: string, max = SUCCESS_MAX_CHARS) {
  if (text.length <= max) return text
  const lines = text.split("\n")
  let head = 0
  let headChars = 0
  while (head < lines.length && headChars + lines[head]!.length + 1 <= max / 3) {
    headChars += lines[head]!.length + 1
    head++
  }
  let tail = lines.length
  let tailChars = 0
  while (tail > head && tailChars + lines[tail - 1]!.length + 1 <= (max * 2) / 3) {
    tail--
    tailChars += lines[tail]!.length + 1
  }
  // One enormous line leaves nothing to keep by line; the generic tool output limit still bounds it.
  if (head === 0 && tail === lines.length) return text
  const omitted = lines.slice(head, tail).join("\n").length
  const note = `[${tail - head} lines (${omitted} characters) of successful output omitted; full output saved to ${file}]`
  return [...lines.slice(0, head), note, ...lines.slice(tail)].join("\n")
}

// A block must span this many lines before it counts as repeated, so ordinary short repeats stay verbatim.
const REPEAT_WINDOW = 6
const REPEAT_MIN_CHARS = 200
const REPEAT_QUOTE_MAX = 80

/**
 * Replaces a block of lines repeated verbatim from earlier in the same output with a short note, as test runners
 * print each failure twice. Lines are compared exactly, so differing lines always remain.
 */
export function collapseRepeats(text: string) {
  if (text.length < REPEAT_MIN_CHARS * 2) return text
  const lines = text.split("\n")
  const first = new Map<string, number>()
  const kept: string[] = []
  let index = 0
  while (index < lines.length) {
    const key = index + REPEAT_WINDOW <= lines.length ? lines.slice(index, index + REPEAT_WINDOW).join("\n") : undefined
    const earlier = key === undefined ? undefined : first.get(key)

    if (earlier !== undefined && earlier + REPEAT_WINDOW <= index) {
      let count = REPEAT_WINDOW
      while (index + count < lines.length && earlier + count < index && lines[earlier + count] === lines[index + count])
        count++
      const repeated = lines.slice(index, index + count)
      const quote = Array.from(repeated[0] ?? "")
        .slice(0, REPEAT_QUOTE_MAX)
        .join("")
      const note = `[${count} lines repeated verbatim from earlier in this output, starting with: ${quote}]`
      if (repeated.join("\n").length >= REPEAT_MIN_CHARS + note.length) {
        kept.push(note)
        index += count
        continue
      }
    }

    if (key !== undefined && !first.has(key)) first.set(key, index)
    kept.push(lines[index]!)
    index++
  }
  return kept.length === lines.length ? text : kept.join("\n")
}

export function notification(input: {
  shellID: string
  jobID?: string
  command: string
  state: "completed" | "cancelled" | "error"
  text: string
  output?: Output
}) {
  return {
    text: `<shell id="${input.jobID ?? input.shellID}" state="${input.state}" command="${input.command}">\n${input.text}\n</shell>`,
    metadata: {
      source: "shell",
      shellID: input.shellID,
      ...(input.jobID !== undefined ? { jobID: input.jobID } : {}),
      state: input.state,
      ...(input.output ? metadata(input.output) : {}),
    },
  }
}

export function userNotification(result: Result) {
  const captured = output(result)
  const status =
    result.info.status === "killed"
      ? "Cancelled"
      : captured.exit === 0
        ? undefined
        : (notice(captured) ?? "Exited with code unknown")
  const message = notification({
    shellID: result.info.id,
    command: result.info.command,
    state: result.info.status === "killed" ? "cancelled" : "completed",
    text: [captured.output, status].filter((item) => item !== undefined && item !== "").join("\n\n"),
    output: captured,
  })
  return { ...message, text: `The following shell command was executed by the user:\n${message.text}` }
}
