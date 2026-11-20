import type { ToolCall } from "./protocol"

/**
 * One Codex realtime delegation at a time: Codex runs one agent turn per thread and steers new requests into it.
 * Its tool calls run serially, in the order Codex asked, so a call that opens a session moves the ones after it.
 */
export type CodexDelegationState =
  | { status: "idle"; seq: number }
  | {
      status: "delegating"
      seq: number
      id: string
      /** The tool call running now, by Codex call ID. */
      running?: string
      queue: readonly ToolCall[]
    }

export type CodexDelegationEvent =
  | { type: "delegation.started" }
  | { type: "tool.requested"; call: ToolCall }
  | { type: "tool.completed"; id: string; callID: string; output: string }
  | { type: "delegation.completed" }
  /** The call dropped or ended; nothing that was running can answer anymore. */
  | { type: "reset" }

export type CodexDelegationEffect =
  /** Reserve the transcript for the delegation and hold announcements while it runs. */
  | { type: "begin"; id: string }
  | { type: "run"; id: string; call: ToolCall }
  | { type: "answer"; callID: string; output: string }
  /** Cancel the delegation's running tool. */
  | { type: "abort"; id: string }
  /** `answered` is false when the delegation ended without Codex finishing it, so it read nothing aloud. */
  | { type: "finish"; id: string; answered: boolean }

export type CodexDelegationTransition = { state: CodexDelegationState; effects: CodexDelegationEffect[] }

export function createCodexDelegationState(): CodexDelegationState {
  return { status: "idle", seq: 0 }
}

export function transitionCodexDelegation(
  state: CodexDelegationState,
  event: CodexDelegationEvent,
): CodexDelegationTransition {
  if (event.type === "reset") {
    if (state.status === "idle") return unchanged(state)

    return end(state, false)
  }

  if (event.type === "delegation.started") {
    if (state.status === "delegating") return unchanged(state)

    return begin(state)
  }

  if (event.type === "tool.requested") {
    // Codex starts its turn before it calls tools; a call without one still belongs to a delegation.
    const started = state.status === "idle" ? begin(state) : { state, effects: [] }
    const current = started.state

    if (current.status !== "delegating") return started

    if (current.running !== undefined)
      return { state: { ...current, queue: [...current.queue, event.call] }, effects: started.effects }

    return {
      state: { ...current, running: event.call.call_id },
      effects: [...started.effects, { type: "run", id: current.id, call: event.call }],
    }
  }

  if (event.type === "tool.completed") {
    if (state.status !== "delegating" || state.id !== event.id || state.running !== event.callID)
      return unchanged(state)
    const answer: CodexDelegationEffect = { type: "answer", callID: event.callID, output: event.output }
    const [next, ...queue] = state.queue

    if (!next) return { state: { ...state, running: undefined, queue }, effects: [answer] }

    return {
      state: { ...state, running: next.call_id, queue },
      effects: [answer, { type: "run", id: state.id, call: next }],
    }
  }

  if (state.status === "idle") return unchanged(state)

  return end(state, true)
}

/** The delegation is running and Codex can still take answers. */
export function codexDelegating(state: CodexDelegationState) {
  return state.status === "delegating"
}

function begin(state: Extract<CodexDelegationState, { status: "idle" }>): CodexDelegationTransition {
  const seq = state.seq + 1
  const id = `codex-${seq}`

  return { state: { status: "delegating", seq, id, queue: [] }, effects: [{ type: "begin", id }] }
}

function end(state: Extract<CodexDelegationState, { status: "delegating" }>, answered: boolean) {
  return {
    state: { status: "idle" as const, seq: state.seq },
    effects: [
      ...(state.running === undefined ? [] : [{ type: "abort" as const, id: state.id }]),
      { type: "finish" as const, id: state.id, answered },
    ],
  }
}

function unchanged(state: CodexDelegationState): CodexDelegationTransition {
  return { state, effects: [] }
}
