import { expect, test } from "bun:test"
import {
  createCodexDelegationState,
  transitionCodexDelegation,
  type CodexDelegationEffect,
  type CodexDelegationEvent,
} from "./codex-machine"

const call = (id: string, name = "read_session") => ({ call_id: id, name, arguments: "{}" })

function replay(events: CodexDelegationEvent[]) {
  const effects: CodexDelegationEffect[] = []

  const state = events.reduce((current, event) => {
    const next = transitionCodexDelegation(current, event)
    effects.push(...next.effects)

    return next.state
  }, createCodexDelegationState())

  return { state, effects }
}

test("Codex tool calls run one at a time in order, and the delegation finishes when Codex ends its turn", () => {
  const result = replay([
    { type: "delegation.started" },
    { type: "tool.requested", call: call("a", "open_session") },
    { type: "tool.requested", call: call("b", "send_message") },
    { type: "tool.completed", id: "codex-1", callID: "a", output: "opened" },
    { type: "tool.completed", id: "codex-1", callID: "b", output: "sent" },
    { type: "delegation.completed" },
  ])

  expect(result.effects).toEqual([
    { type: "begin", id: "codex-1" },
    { type: "run", id: "codex-1", call: call("a", "open_session") },
    { type: "answer", callID: "a", output: "opened" },
    { type: "run", id: "codex-1", call: call("b", "send_message") },
    { type: "answer", callID: "b", output: "sent" },
    { type: "finish", id: "codex-1", answered: true },
  ])
  expect(result.state).toEqual({ status: "idle", seq: 1 })
})

test("a dropped call aborts the running tool, answers nothing late, and leaves its replies unheard", () => {
  const result = replay([
    { type: "tool.requested", call: call("a") },
    { type: "reset" },
    { type: "tool.completed", id: "codex-1", callID: "a", output: "late" },
    { type: "tool.requested", call: call("b") },
  ])

  expect(result.effects).toEqual([
    { type: "begin", id: "codex-1" },
    { type: "run", id: "codex-1", call: call("a") },
    { type: "abort", id: "codex-1" },
    { type: "finish", id: "codex-1", answered: false },
    { type: "begin", id: "codex-2" },
    { type: "run", id: "codex-2", call: call("b") },
  ])
})
