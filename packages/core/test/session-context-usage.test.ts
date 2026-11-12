import { describe, expect, test } from "bun:test"
import { ai, Message, SystemPart, ToolDefinition, ToolResultPart } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { ContextUsage } from "@opencode/schema/context-usage"
import { Schema } from "effect"
import { SessionContextUsage } from "@opencode/core/session/context-usage"
import { Instructions } from "@opencode/core/instructions/index"
import { ShellResult } from "@opencode/core/shell/result"

const model = OpenAIChat.route.model({ id: "test-model", provider: "test" })
const body = '<skill_content name="demo">\n' + "Follow the demo instructions.\n".repeat(20) + "</skill_content>"
const result = { content: [{ type: "text" as const, text: body }], metadata: { name: "demo" } }
const tool = (text: string) =>
  Message.tool(ToolResultPart.make({ id: "call_1", name: "skill", result: { type: "text", value: text } }))

describe("SessionContextUsage", () => {
  test("reuses only the identical complete skill still present in the visible context", () => {
    expect(SessionContextUsage.reuseSkill(result, [tool(body)])).toMatchObject({
      metadata: { reused: true, name: "demo" },
    })
    expect(SessionContextUsage.reuseSkill(result, [Message.user(body)])).toMatchObject({ metadata: { reused: true } })
    expect(SessionContextUsage.reuseSkill(result, [])).toBe(result)
    expect(SessionContextUsage.reuseSkill(result, [tool(body.replace("demo instructions", "old instructions"))])).toBe(
      result,
    )
    expect(SessionContextUsage.reuseSkill(result, [tool(body.slice(0, 30) + "[truncated]")])).toBe(result)
    expect(SessionContextUsage.reuseSkill(result, [Message.user("Skill demo was loaded before compaction.")])).toBe(
      result,
    )
    const repeated = SessionContextUsage.reuseSkill(result, [tool(body)])
    const text = repeated.content[0]
    expect(text?.type === "text" && text.text.length).toBeLessThan(180)
    expect(SessionContextUsage.reuseSkill(result, text?.type === "text" ? [tool(text.text)] : [])).toBe(result)
  })

  test("points a large repeated tool result at the identical earlier result still in context", () => {
    const output = "line of file content\n".repeat(100)
    const read = { content: [{ type: "text" as const, text: output }], metadata: { truncated: false } }
    const earlier = Message.tool(
      ToolResultPart.make({ id: "call_read_1", name: "read", result: { type: "text", value: output } }),
    )
    const reused = SessionContextUsage.reuseToolResult("read", read, [earlier])
    const notice = reused.content[0]

    expect(reused.metadata).toEqual({ truncated: false, reused: true })
    expect(notice?.type === "text" && notice.text).toContain("call_read_1")
    expect(notice?.type === "text" && notice.text.length).toBeLessThan(200)
    // Not present, changed, small, or multi-part results are returned unchanged.
    expect(SessionContextUsage.reuseToolResult("read", read, [])).toBe(read)
    expect(SessionContextUsage.reuseToolResult("read", read, [Message.user(output)])).toBe(read)
    const changed = { content: [{ type: "text" as const, text: output + "edited\n" }] }
    expect(SessionContextUsage.reuseToolResult("read", changed, [earlier])).toBe(changed)
    const small = { content: [{ type: "text" as const, text: "same" }] }
    const smallEarlier = Message.tool(
      ToolResultPart.make({ id: "call_small", name: "read", result: { type: "text", value: "same" } }),
    )
    expect(SessionContextUsage.reuseToolResult("read", small, [smallEarlier])).toBe(small)
    const media = {
      content: [
        { type: "text" as const, text: output },
        { type: "file" as const, uri: "data:image/png;base64,AA==", mime: "image/png" },
      ],
    }
    expect(SessionContextUsage.reuseToolResult("read", media, [earlier])).toBe(media)
    // The pointer itself never matches again, so a third identical call still points at the original.
    const third = SessionContextUsage.reuseToolResult("read", read, [
      earlier,
      Message.tool(
        ToolResultPart.make({
          id: "call_read_2",
          name: "read",
          result: { type: "text", value: notice?.type === "text" ? notice.text : "" },
        }),
      ),
    ])
    expect(third.content[0]?.type === "text" && third.content[0].text).toContain("call_read_1")
  })

  test("shortens only long commands in completion notices without splitting code points", () => {
    expect(ShellResult.commandLabel("bun test")).toBe("bun test")
    const command = "🙂".repeat(199) + "x".repeat(500)
    const label = ShellResult.commandLabel(command)

    expect(label.startsWith("🙂".repeat(199) + "x…")).toBe(true)
    expect(label).toContain("499 more characters")
    expect(label).not.toContain("�")
    expect(label.length).toBeLessThan(command.length)
  })

  test("elides only unchanged line runs a still-present earlier read of the same file returned", () => {
    const file = (start: number, end: number, edit?: number) =>
      [
        `Read file /repo/src/a.ts, lines ${start}-${end}`,
        ...Array.from({ length: end - start + 1 }, (_, index) => {
          const line = start + index
          return `${line}: ${line === edit ? "const changed = true" : `const value${line} = compute(${line}) // stable line`}`
        }),
      ].join("\n")
    const earlier = Message.tool(
      ToolResultPart.make({ id: "call_first", name: "read", result: { type: "text", value: file(1, 60) } }),
    )
    const reread = { content: [{ type: "text" as const, text: file(30, 90, 45) }] }
    const result = SessionContextUsage.reuseToolResult("read", reread, [earlier])
    const text = result.content[0]?.type === "text" ? result.content[0].text : ""

    expect(text).toContain("[lines 30-44 unchanged; identical to read call call_first above]")
    expect(text).toContain("45: const changed = true")
    expect(text).toContain("[lines 46-60 unchanged; identical to read call call_first above]")
    expect(text).toContain("61: const value61")
    expect(text).toContain("90: const value90")
    expect(text.startsWith("Read file /repo/src/a.ts, lines 30-90")).toBe(true)
    expect(result.metadata?.elidedLines).toBe(30)
    // A different file, or a history without the earlier read, keeps every line.
    const other = {
      content: [{ type: "text" as const, text: file(30, 90).replace("/repo/src/a.ts", "/repo/src/b.ts") }],
    }
    expect(SessionContextUsage.reuseToolResult("read", other, [earlier])).toBe(other)
    expect(SessionContextUsage.reuseToolResult("read", reread, [])).toBe(reread)
    // Other tools are never line-elided.
    expect(SessionContextUsage.reuseToolResult("grep", reread, [earlier])).toBe(reread)
  })

  test("bounds long successful output by whole lines, keeping more of the end", () => {
    const output =
      Array.from({ length: 3000 }, (_, index) => `warning ${index}: something long enough to matter`).join("\n") +
      "\nTasks: 35 successful"
    const bounded = ShellResult.boundSuccess(output, "/tmp/full.log")

    expect(bounded.length).toBeLessThanOrEqual(15_200)
    expect(bounded.startsWith("warning 0:")).toBe(true)
    expect(bounded.endsWith("Tasks: 35 successful")).toBe(true)
    expect(bounded).toContain("of successful output omitted; full output saved to /tmp/full.log]")
    expect(ShellResult.boundSuccess("short", "/tmp/full.log")).toBe("short")
    const single = "x".repeat(40_000)
    expect(ShellResult.boundSuccess(single, "/tmp/full.log")).toBe(single)
  })

  test.each([30_000, 15_000, 8_000, 4_000, 2_000])("bounds successful output at %i characters plus its note", (max) => {
    const lines = Array.from({ length: 2000 }, (_, index) => `line ${index}: ${"x".repeat(30)}`)
    const bounded = ShellResult.boundSuccess(lines.join("\n"), "/tmp/full.log", max)
    expect(bounded.length).toBeLessThanOrEqual(max + 200)
    expect(bounded.startsWith(`${lines[0]}\n`)).toBe(true)
    expect(bounded.endsWith(lines.at(-1)!)).toBe(true)
    expect(
      bounded
        .split("\n")
        .filter((line) => !line.startsWith("["))
        .every((line) => lines.includes(line)),
    ).toBe(true)
    const exact = "x".repeat(max - 2) + "\ny"
    expect(ShellResult.boundSuccess(exact, "/tmp/full.log", max)).toBe(exact)
  })

  test("collapses only long blocks repeated verbatim within one shell output", () => {
    const stack = Array.from({ length: 8 }, (_, index) => `    at frame${index} (/repo/src/file.ts:${index + 10}:4)`)
    const output = [
      "error: expected 1 to be 2",
      ...stack,
      "",
      "(fail) case one",
      "error: expected 1 to be 2",
      ...stack,
      "done",
    ].join("\n")
    const collapsed = ShellResult.collapseRepeats(output)
    const lines = collapsed.split("\n")

    expect(collapsed.length).toBeLessThan(output.length)
    expect(lines.filter((line) => line.includes("at frame3"))).toHaveLength(1)
    expect(lines).toContain("(fail) case one")
    expect(lines.at(-1)).toBe("done")
    expect(collapsed).toContain(
      "lines repeated verbatim from earlier in this output, starting with: error: expected 1 to be 2",
    )
    // A changed line in the second copy breaks the repeat, so the differing detail stays visible.
    const differing = output.replace(
      /frame5 \(\/repo\/src\/file\.ts:15:4\)(?![\s\S]*frame5)/,
      "frame5 (/repo/src/other.ts:99:1)",
    )
    expect(ShellResult.collapseRepeats(differing)).toContain("/repo/src/other.ts:99:1")
    // Short outputs and short repeats are returned unchanged.
    expect(ShellResult.collapseRepeats("ok\nok\nok")).toBe("ok\nok\nok")
    const shortRepeat = Array.from({ length: 30 }, () => "a\nb\nc\nd\ne\nf").join("\n")
    expect(ShellResult.collapseRepeats(shortRepeat)).toBe(shortRepeat)
  })

  test("separates instructions, skill bodies, native MCP and deferred definitions", () => {
    const sources = [
      { key: Instructions.Key.make("core/skill-guidance"), text: "s".repeat(400) },
      { key: Instructions.Key.make("core/instructions"), text: "i".repeat(800) },
      { key: Instructions.Key.make("core/codemode"), text: "t".repeat(40) },
    ]
    const tools = {
      definitions: [new ToolDefinition({ name: "mcp_lookup", description: "Lookup", inputSchema: { type: "object" } })],
      mcpTools: new Set(["mcp_lookup"]),
      codeModeCatalog: {
        tools: [
          { type: "tool" as const, name: "deferred", description: "x".repeat(10000), signature: "large definition" },
        ],
      },
      execute: () => {
        throw new Error("unused")
      },
    }
    const request = ai.request({
      model,
      system: [
        { ...SystemPart.make(Instructions.join(sources)), metadata: { experimental: { instructions: sources } } },
      ],
      messages: [tool(body), Message.user("m".repeat(40))],
      tools: tools.definitions,
    })
    const measured = SessionContextUsage.measure(request, tools, 80000)
    expect(measured.estimates.instructions).toBe(200)
    expect(measured.estimates.skills).toBeGreaterThan(100)
    expect(measured.estimates.tools).toBe(10)
    expect(measured.estimates.mcp).toBeGreaterThan(0)
    expect(measured.estimates.messages).toBeGreaterThanOrEqual(10)
    expect(measured.deferredTools).toBe(1)
    expect(measured.autoCompactLimit).toBe(80000)
    expect(JSON.stringify(measured)).not.toContain("large definition")
    expect(JSON.stringify(measured)).not.toContain("Follow the demo")
    expect(Schema.encodeSync(ContextUsage.Info)(measured)).toEqual(measured)
  })

  test("fingerprints distinguish changed tools, instructions, history and routing", () => {
    const request = ai.request({ model, system: [SystemPart.make("fixed")], messages: [Message.user("hi")] })
    const original = SessionContextUsage.measure(request)
    expect(SessionContextUsage.measure(request)).toEqual(original)
    const system = SessionContextUsage.measure({ ...request, system: [SystemPart.make("updated")] })
    expect(system.fingerprints.system).not.toBe(original.fingerprints.system)
    expect(system.fingerprints.history).toBe(original.fingerprints.history)
    const history = SessionContextUsage.measure({
      ...request,
      messages: [...request.messages, Message.assistant("reply")],
    })
    expect(history.fingerprints.system).toBe(original.fingerprints.system)
    expect(history.fingerprints.history).not.toBe(original.fingerprints.history)
    expect(SessionContextUsage.measure({ ...request, promptCacheKey: "different" }).fingerprints.routing).not.toBe(
      original.fingerprints.routing,
    )
    expect(
      SessionContextUsage.measure({
        ...request,
        tools: [new ToolDefinition({ name: "new", description: "New tool", inputSchema: {} })],
      }).fingerprints.tools,
    ).not.toBe(original.fingerprints.tools)
    expect(Schema.encodeSync(ContextUsage.Info)(original)).not.toHaveProperty("autoCompactLimit")
  })

  test.each([
    "session-id",
    "thread-id",
    "x-session-affinity",
    "x-session-id",
    "x-opencode-session-id",
    "x-opencode-parent-session-id",
    "x-parent-session-id",
    "x-opencode-session",
  ])("detects changes to cache-affinity header %s", (header) => {
    const request = ai.request({ model, prompt: "fixed", headers: { [header]: "affinity-original" } })
    const original = SessionContextUsage.measure(request)
    const changed = SessionContextUsage.measure({ ...request, headers: { [header]: "affinity-changed" } })
    const removed = SessionContextUsage.measure({ ...request, headers: {} })

    expect(changed.fingerprints.routing).not.toBe(original.fingerprints.routing)
    expect(removed.fingerprints.routing).not.toBe(original.fingerprints.routing)
    expect(changed.fingerprints.system).toBe(original.fingerprints.system)
    expect(changed.fingerprints.tools).toBe(original.fingerprints.tools)
    expect(changed.fingerprints.history).toBe(original.fingerprints.history)
    expect(JSON.stringify(original)).not.toContain("affinity-original")
    expect(JSON.stringify(changed)).not.toContain("affinity-changed")
  })

  test("normalizes affinity header case and order without hashing credentials or request IDs", () => {
    const request = ai.request({ model, prompt: "fixed" })
    const headers = {
      "Session-Id": "stable-session",
      "Thread-Id": "stable-thread",
      authorization: "Bearer secret-one",
      "x-api-key": "private-one",
      "x-client-request-id": "request-one",
    }
    const original = SessionContextUsage.measure({ ...request, headers })
    const changed = SessionContextUsage.measure({
      ...request,
      headers: {
        "x-client-request-id": "request-two",
        "x-api-key": "private-two",
        authorization: "Bearer secret-two",
        "thread-id": "stable-thread",
        "session-id": "stable-session",
      },
    })

    expect(changed).toEqual(original)
    expect(headers).toEqual({
      "Session-Id": "stable-session",
      "Thread-Id": "stable-thread",
      authorization: "Bearer secret-one",
      "x-api-key": "private-one",
      "x-client-request-id": "request-one",
    })
    for (const value of Object.values(headers)) expect(JSON.stringify(original)).not.toContain(value)
    expect(SessionContextUsage.measure({ ...request, headers: {} })).toEqual(SessionContextUsage.measure(request))
  })
})
