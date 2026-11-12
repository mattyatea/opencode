export * as SessionContextUsage from "./context-usage.js"

import { createHash } from "crypto"
import type { LLMRequest } from "@opencode/ai/effect"
import type { ContextUsage } from "@opencode/schema/context-usage"
import { Option, Schema } from "effect"
import { Token } from "../util/token.js"
import { Instructions } from "../instructions/index.js"
import type { CodeModeCatalog } from "../codemode/catalog.js"
import type { Tool } from "../tool.js"

const decodeInstructions = Schema.decodeUnknownOption(
  Schema.Struct({ instructions: Schema.Array(Schema.Struct({ key: Instructions.Key, text: Schema.String })) }),
)
const skillPattern = /<skill_content name="[^"]*">[\s\S]*?<\/skill_content>/g
// Only cache-affinity headers belong in this hash, not credentials or per-request tracing IDs.
const affinityHeaders = [
  "session-id",
  "thread-id",
  "x-session-affinity",
  "x-session-id",
  "x-opencode-session-id",
  "x-opencode-parent-session-id",
  "x-parent-session-id",
  "x-opencode-session",
]

/** Count logical request text, not images, provider chat templates, or transport-hook rewrites. */
export function measure(request: LLMRequest, tools?: Tool.Snapshot, autoCompactLimit?: number): ContextUsage.Info {
  const estimates = { messages: 0, system: 0, tools: 0, mcp: 0, skills: 0, instructions: 0 }
  for (const part of request.system) {
    const sources = Option.getOrUndefined(decodeInstructions(part.metadata?.experimental))?.instructions
    if (!sources || Instructions.join(sources) !== part.text) {
      estimates.system += Token.estimate(part.text)
      continue
    }
    for (const source of sources) {
      const category =
        source.key === "core/skill-guidance"
          ? "skills"
          : source.key === "core/instructions"
            ? "instructions"
            : source.key === "core/mcp-guidance"
              ? "mcp"
              : source.key === "core/codemode"
                ? "tools"
                : "system"
      estimates[category] += Token.estimate(source.text)
    }
  }
  for (const definition of request.tools) {
    const category = tools?.mcpTools?.has(definition.name) ? "mcp" : "tools"
    estimates[category] += Token.estimate(JSON.stringify(definition))
  }
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type === "media") continue
      const text = part.type === "text" || part.type === "reasoning" ? part.text : JSON.stringify(part)
      // Only literal, complete skill bodies are attributed separately. Other tool results remain messages.
      const skills =
        part.type === "text"
          ? Array.from(text.matchAll(skillPattern), (match) => match[0])
          : part.type === "tool-result"
            ? skillText(part).flatMap((text) => Array.from(text.matchAll(skillPattern), (match) => match[0]))
            : []
      const tokens = skills.reduce((sum, text) => sum + Token.estimate(text), 0)
      estimates.skills += tokens
      estimates.messages += Math.max(0, Token.estimate(text) - tokens)
    }
  }
  const headers = new Map(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]))
  return {
    estimates,
    deferredTools: count(tools?.codeModeCatalog?.tools ?? []),
    autoCompactLimit,
    fingerprints: {
      system: hash(request.system.map((part) => part.text)),
      tools: hash(request.tools),
      history: hash(request.messages),
      routing: hash([
        request.model.route,
        request.model.id,
        request.promptCacheKey,
        request.providerOptions,
        request.toolChoice,
        affinityHeaders.map((name) => [name, headers.get(name) ?? null]),
      ]),
    },
  }
}

/** Suppress only a complete, identical body still present in the final model-visible request. */
export function reuseSkill(result: Tool.NormalizedResult, messages: LLMRequest["messages"]): Tool.NormalizedResult {
  if (result.content.length !== 1 || result.content[0]?.type !== "text") return result
  const text = result.content[0].text
  const notice =
    "This exact skill version is already loaded in the current context. Follow its instructions above; no content has changed."
  if (text.length <= notice.length) return result
  if (!text.startsWith('<skill_content name="') || !text.endsWith("</skill_content>")) return result
  const present = messages.some((message) =>
    message.content.some((part) =>
      part.type === "text"
        ? part.text.includes(text)
        : part.type === "tool-result" && skillText(part).some((value) => value.includes(text)),
    ),
  )
  if (!present) return result
  return {
    ...result,
    content: [{ type: "text", text: notice }],
    metadata: { ...result.metadata, reused: true },
  }
}

// Below this a pointer to the earlier result saves too little to be worth the indirection.
const REPEAT_MIN_CHARS = 1_000

/** Replace a large text result identical to an earlier tool result still in the model-visible request. */
export function reuseToolResult(
  name: string | undefined,
  result: Tool.NormalizedResult,
  messages: LLMRequest["messages"],
): Tool.NormalizedResult {
  if (name === "skill") return reuseSkill(result, messages)
  if (result.content.length !== 1 || result.content[0]?.type !== "text") return result
  const text = result.content[0].text
  if (text.length < REPEAT_MIN_CHARS) return result
  const earlier = messages
    .flatMap((message): ReadonlyArray<ToolResult> => message.content.filter(isToolResult))
    .findLast((part) => skillText(part).some((value) => value === text))
  if (!earlier) return name === "read" ? elideKnownLines(result, text, messages) : result
  return {
    ...result,
    content: [
      {
        type: "text",
        text: `[Output identical to the earlier ${earlier.name} result for call ${earlier.id}, which is still in this conversation; ${text.length} characters not repeated.]`,
      },
    ],
    metadata: { ...result.metadata, reused: true },
  }
}

const READ_HEADER = /^Read file (.+), lines \d+-\d+$/
const READ_LINE = /^(\d+): /
// Shorter unchanged runs stay inline, so small overlaps never send the model back through history.
const ELIDE_MIN_CHARS = 400

/**
 * Replaces runs of numbered lines that an earlier read of the same file, still in the request, returned
 * byte-for-byte at the same line numbers. Any edited line differs and therefore stays inline.
 */
function elideKnownLines(result: Tool.NormalizedResult, text: string, messages: LLMRequest["messages"]) {
  const lines = text.split("\n")
  const path = READ_HEADER.exec(lines[0] ?? "")?.[1]
  if (path === undefined) return result
  const known = new Map<number, { readonly line: string; readonly id: string }>()
  for (const part of messages.flatMap((message) => message.content.filter(isToolResult))) {
    if (part.name !== "read") continue
    for (const value of skillText(part)) {
      const earlier = value.split("\n")
      if (READ_HEADER.exec(earlier[0] ?? "")?.[1] !== path) continue
      for (const line of earlier.slice(1)) {
        const number = READ_LINE.exec(line)?.[1]
        if (number !== undefined) known.set(Number(number), { line, id: part.id })
      }
    }
  }
  if (known.size === 0) return result

  const kept: string[] = []
  let run: string[] = []
  let source: string | undefined
  let elided = 0
  const flush = () => {
    if (run.join("\n").length >= ELIDE_MIN_CHARS) {
      const first = READ_LINE.exec(run[0]!)![1]
      const last = READ_LINE.exec(run.at(-1)!)![1]
      kept.push(`[lines ${first}-${last} unchanged; identical to read call ${source} above]`)
      elided += run.length
    } else kept.push(...run)
    run = []
    source = undefined
  }
  for (const line of lines) {
    const number = READ_LINE.exec(line)?.[1]
    const match = number === undefined ? undefined : known.get(Number(number))
    if (match?.line === line && (source === undefined || source === match.id)) {
      run.push(line)
      source = match.id
      continue
    }
    flush()
    if (match?.line === line) {
      run.push(line)
      source = match.id
      continue
    }
    kept.push(line)
  }
  flush()
  if (elided === 0) return result
  return {
    ...result,
    content: [{ type: "text" as const, text: kept.join("\n") }],
    metadata: { ...result.metadata, elidedLines: elided },
  }
}

type ToolResult = Extract<LLMRequest["messages"][number]["content"][number], { type: "tool-result" }>

const isToolResult = (part: LLMRequest["messages"][number]["content"][number]): part is ToolResult =>
  part.type === "tool-result"

function skillText(part: ToolResult) {
  if (part.result.type === "text" && typeof part.result.value === "string") return [part.result.value]
  if (part.result.type === "content")
    return part.result.value.flatMap((item) => (item.type === "text" ? [item.text] : []))
  return []
}

function hash(values: ReadonlyArray<unknown>) {
  const hash = createHash("sha256")
  for (const value of values) hash.update(JSON.stringify(value) ?? "null").update("\n")
  return hash.digest("hex")
}

function count(tools: CodeModeCatalog.Inventory["tools"]): number {
  return tools.reduce((sum, tool) => sum + (tool.type === "tool" ? 1 : count(tool.tools)), 0)
}
