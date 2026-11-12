export * as PendingTools from "./pending.js"

import type { CallToolResult } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import type { ToolResult } from "./result.js"

interface Call {
  readonly id: string
  readonly name: string
  /** Canonical JSON of the call's input, so a parallel call can be matched to its own arguments. */
  readonly input: string
  readonly result: PromiseWithResolvers<ToolResult.Result>
  /** Set once a handler took this call, so a duplicate call is matched instead of the same one twice. */
  claimed: boolean
}

export interface Interface {
  readonly expect: (id: string, name: string, input: unknown) => void
  readonly before: (id: string, name: string, input: unknown) => void
  readonly call: (name: string, input: unknown) => Promise<CallToolResult>
  readonly resolve: (id: string, result: ToolResult.Result) => void
  readonly after: (id: string) => ToolResult.Result["replacement"]
  readonly clear: () => void
}

export function make(): Interface {
  const calls = new Map<string, Call>()
  const replacements = new Map<string, ToolResult.Result["replacement"]>()

  function expect(id: string, name: string, input: unknown) {
    const saved = calls.get(id)
    if (saved) {
      if (saved.name !== name) throw new Error(`Mismatched Claude tool call ${id}`)
      return saved
    }
    const call = {
      id,
      name,
      input: canonical(input ?? {}),
      result: Promise.withResolvers<ToolResult.Result>(),
      claimed: false,
    }
    calls.set(id, call)
    return call
  }

  // Claude may run read-only tools at the same time, so the handler cannot rely on the most recent call being its
  // own. Its name and input pick an unclaimed call; identical calls are interchangeable, so the oldest one is enough.
  function take(name: string, input: unknown) {
    const wanted = canonical(input ?? {})
    const open = calls
      .values()
      .filter((call) => !call.claimed && call.name === name)
      .toArray()
    const match = open.find((call) => call.input === wanted)
    if (match) {
      match.claimed = true
      return match
    }
    // Serial tools have only one open call, so it is theirs even if its input was serialized differently. Among
    // parallel calls a differing input cannot be attributed safely: answering the wrong one swaps their results.
    if (open.length !== 1) return undefined
    const call = open[0]!
    Effect.runFork(Effect.logWarning("Claude tool call input differs from its PreToolUse input", { id: call.id, name }))
    call.claimed = true
    return call
  }

  return {
    expect,
    before: expect,
    async call(name: string, input: unknown) {
      const call = take(name, input)
      if (!call) throw new Error(`Claude invoked ${name} without a PreToolUse call that matches its input`)
      const result = await call.result.promise
      if (result.replacement) replacements.set(call.id, result.replacement)
      calls.delete(call.id)
      return result.mcp
    },
    resolve(id: string, result: ToolResult.Result) {
      const call = calls.get(id)
      if (!call) throw new Error(`No waiting Claude tool call ${id}`)
      call.result.resolve(result)
    },
    after(id: string) {
      const replacement = replacements.get(id)
      replacements.delete(id)
      return replacement
    },
    // Call only after interrupt-and-drain; resolving these handlers earlier can start another model call.
    clear() {
      for (const call of calls.values()) {
        call.result.resolve({
          mcp: { isError: true, content: [{ type: "text", text: "Cancelled by user." }] },
          replacement: undefined,
        })
      }
      calls.clear()
      replacements.clear()
    },
  }
}

/** JSON with sorted object keys, so equal inputs compare equal whatever key order the provider used. */
function canonical(value: unknown): string {
  if (value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  const entries = Object.entries(value)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
  return `{${entries.join(",")}}`
}
