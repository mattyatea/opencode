import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { ConfigVoice } from "@opencode/schema/config/voice"
import { createCodexVoice } from "../src/voice/codex"
import { tmpdir } from "./fixture/tmpdir"

// Stands in for `codex app-server`: it answers the requests a call makes, asks for one dynamic tool, and echoes the
// tool's answer back as an assistant transcript so the test can see what Codex received.
const fakeAppServer = `
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n")
const thread = "thread_1"
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, index))
    buffer = buffer.slice(index + 1)
    if (message.id === 99) {
      write({ method: "thread/realtime/transcript/delta", params: { threadId: thread, role: "assistant", delta: JSON.stringify(message.result) } })
      continue
    }
    if (message.method === "thread/start") {
      write({ id: message.id, result: { thread: { id: thread } } })
      write({ method: "thread/started", params: { thread: { id: thread, tools: message.params.dynamicTools.map((tool) => tool.name), base: message.params.baseInstructions, config: message.params.config } } })
      continue
    }
    if (message.method === "thread/realtime/start") {
      write({ id: message.id, result: {} })
      write({ method: "thread/realtime/started", params: { threadId: thread, realtimeSessionId: thread, version: message.params.version } })
      write({ method: "thread/realtime/sdp", params: { threadId: thread, sdp: "answer:" + message.params.transport.sdp + ":" + message.params.prompt } })
      write({ method: "turn/started", params: { threadId: thread, turn: { id: "turn_1" } } })
      write({ id: 99, method: "item/tool/call", params: { threadId: thread, turnId: "turn_1", callId: "exec_1", tool: "list_sessions", arguments: { limit: 2 } } })
      continue
    }
    if (message.method === "thread/realtime/stop") {
      write({ id: message.id, result: {} })
      write({ method: "thread/realtime/closed", params: { threadId: thread, reason: "requested" } })
      continue
    }
    if (message.id !== undefined) write({ id: message.id, result: {} })
  }
})
`

test.skipIf(process.platform === "win32")(
  // A shebang script stands in for the codex executable, and Windows can't run one directly.
  "a Codex call answers the client's offer, relays the agent's tool calls, and closes when stopped",
  async () => {
    await using tmp = await tmpdir()
    const command = path.join(tmp.path, "codex")
    await fs.writeFile(command, `#!${process.execPath}\n${fakeAppServer}`, { mode: 0o755 })
    const codex = createCodexVoice()
    // An events request returns as soon as anything happened, so gather until the call has said `count` things.
    const gather = async (call: string, after: number, count: number) => {
      const events: Awaited<ReturnType<typeof codex.events>>["events"] = []
      while (events.length < count) {
        const next = await codex.events(call, events.at(-1)?.seq ?? after)
        events.push(...next.events)
        if (next.closed) break
      }
      return events
    }

    try {
      const started = await codex.start(
        new ConfigVoice.Codex({
          command,
          instructions: new ConfigVoice.CodexInstructions({ voice: "Speak like a pirate." }),
        }),
        {
          sdp: "offer",
          instructions: { voice: "default voice", delegator: "default delegator" },
          tools: [{ name: "list_sessions", description: "List sessions", parameters: { type: "object" } }],
        },
      )
      // voice.codex.instructions.voice replaces OpenCode's voice prompt.
      expect(started).toEqual({ call: "thread_1", sdp: "answer:offer:Speak like a pirate." })

      expect(await gather(started.call, 0, 2)).toEqual([
        { seq: 1, type: "delegation", status: "started" },
        { seq: 2, type: "tool", id: "exec_1", name: "list_sessions", arguments: '{"limit":2}' },
      ])

      codex.tool(started.call, "exec_1", "[]", true)
      expect(await gather(started.call, 2, 1)).toEqual([
        {
          seq: 3,
          type: "transcript",
          role: "assistant",
          delta: JSON.stringify({ success: true, contentItems: [{ type: "inputText", text: "[]" }] }),
        },
      ])

      await codex.stop(started.call)
      const closed = await codex.events(started.call, 3)
      // Codex's own closed notification and the stop's reply race; either one closes the call once.
      expect(closed.closed).toBe(true)
      expect(closed.events).toHaveLength(1)
      expect(closed.events[0]).toMatchObject({ seq: 4, type: "closed" })
      expect(() => codex.tool("missing", "exec_1", "[]", true)).toThrow("Unknown voice call: missing")
    } finally {
      codex.close()
    }
  },
)
