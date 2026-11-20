import { expect, test } from "bun:test"
import type { Socket } from "effect/socket"
import { Call } from "../src/voice/chatgpt"

// Stands in for the call's sideband: the test plays ChatGPT's events and reads what the server sent back.
class FakeSocket implements Socket.WebSocketLike {
  readyState = 1
  sent: Record<string, unknown>[] = []
  private listeners = new Map<string, ((event: Socket.WebSocketEvent) => void)[]>()

  addEventListener(type: string, listener: (event: Socket.WebSocketEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener() {}

  close() {
    this.readyState = 3
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    this.sent.push(JSON.parse(String(data)))
  }

  emit(type: string, event: Socket.WebSocketEvent) {
    this.listeners.get(type)?.forEach((listener) => listener(event))
  }

  message(value: unknown) {
    this.emit("message", { data: JSON.stringify(value) })
  }
}

const delegation = (id: string, text: string) => ({
  type: "delegation.created",
  item: { id, type: "delegation", target: "client", content: [{ type: "input_text", text }] },
})

test("a call relays transcripts and answers its delegations in order with what OpenCode said", async () => {
  const socket = new FakeSocket()
  const answers = [Promise.withResolvers<string>(), Promise.withResolvers<string>()]
  const asked: string[] = []
  const call = new Call(
    "rtc_1",
    socket,
    (request) => {
      asked.push(request.text)
      return answers[asked.length - 1]!.promise
    },
    () => {},
  )

  socket.message({ type: "input_transcript.added", item: { type: "input_transcript", text: "What's running" } })
  socket.message({ type: "turn.done", turn: { role: "user", transcript: "What's running?" } })
  socket.message(delegation("item_1", "What's running?"))
  socket.message(delegation("item_2", "Also open the docs session"))
  // A delegation for another target is not OpenCode's to answer.
  socket.message({ ...delegation("item_3", "ignored"), item: { ...delegation("item_3", "x").item, target: "server" } })
  await Promise.resolve()
  expect(asked).toEqual(["What's running?"])

  answers[0]!.resolve("Two sessions are running.")
  await Bun.sleep(0)
  answers[1]!.resolve("Opened the docs session.")
  await Bun.sleep(0)

  expect(asked).toEqual(["What's running?", "Also open the docs session"])
  expect(socket.sent).toEqual([
    {
      type: "delegation.context.append",
      delegation_item_id: "item_1",
      content: [{ type: "input_text", text: "Two sessions are running." }],
    },
    {
      type: "delegation.context.append",
      delegation_item_id: "item_2",
      content: [{ type: "input_text", text: "Opened the docs session." }],
    },
  ])
  const { events } = await call.events(0)
  expect(events.map((event) => [event.type, "role" in event ? event.role : "id" in event ? event.id : ""])).toEqual([
    ["transcript", "user"],
    ["transcript.done", "user"],
    ["delegation", "item_1"],
    ["delegation", "item_1"],
    ["delegation", "item_2"],
    ["delegation", "item_2"],
  ])
})

test("a closed sideband ends the call once, and a waiting events request sees why", async () => {
  const socket = new FakeSocket()
  const call = new Call(
    "rtc_1",
    socket,
    () => Promise.resolve(""),
    () => {},
  )
  const waiting = call.events(0)

  socket.readyState = 3
  socket.emit("close", { code: 1000, reason: "session_expired" })
  socket.emit("close", { code: 1000, reason: "again" })

  expect(await waiting).toEqual({ events: [{ seq: 1, type: "closed", reason: "session_expired" }], closed: true })
  expect(() => call.send({ type: "session.context.append" })).toThrow("The voice call is not connected")
})
