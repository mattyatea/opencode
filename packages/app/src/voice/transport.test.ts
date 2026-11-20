import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import type { OpenCodeClient, VoiceCodexEvent } from "@opencode/client/promise"
import { CLOSE_TIMEOUT, DISCONNECT_GRACE, JOIN_TIMEOUT } from "./transport-machine"
import { VoiceFailure, VoiceTransport } from "./transport"

// WebRTC and Web Audio do not exist outside a browser, so these stand in for the few calls the transport makes.
class FakeChannel {
  readyState: RTCDataChannelState = "open"
  sent: { type: string; event_id: string }[] = []
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  send(data: string) {
    if (this.readyState !== "open") throw new Error("InvalidStateError")
    this.sent.push(JSON.parse(data))
  }

  receive(event: { type: string; error?: { type: string; code: string; message: string } }) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

class FakePeer {
  static last: FakePeer
  channel = new FakeChannel()
  iceGatheringState: RTCIceGatheringState = "complete"
  connectionState: RTCPeerConnectionState = "new"
  localDescription: { type: string; sdp: string } | null = null
  closed = false
  onicegatheringstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((event: { track: object }) => void) | null = null

  constructor() {
    FakePeer.last = this
  }

  createDataChannel() {
    return this.channel
  }

  addTransceiver() {
    return { sender: { replaceTrack: () => Promise.resolve() } }
  }

  createOffer() {
    return Promise.resolve({ type: "offer", sdp: "v=0 offer" })
  }

  setLocalDescription(description: { type: string; sdp: string }) {
    this.localDescription = description

    return Promise.resolve()
  }

  setRemoteDescription() {
    return Promise.resolve()
  }

  close() {
    this.closed = true
  }

  state(next: RTCPeerConnectionState) {
    this.connectionState = next
    this.onconnectionstatechange?.()
  }
}

class FakeAudioContext {
  resume() {
    return Promise.resolve()
  }

  close() {
    return Promise.resolve()
  }

  createAnalyser() {
    return { fftSize: 0, getFloatTimeDomainData() {} }
  }

  createMediaStreamSource() {
    return { connect() {} }
  }
}

class FakeAudio {
  autoplay = false
  srcObject: FakeMediaStream | null = null

  play() {
    return Promise.resolve()
  }

  pause() {}
}

class FakeMediaStream {
  constructor(private tracks: object[] = []) {}

  getTracks() {
    return this.tracks
  }

  getAudioTracks() {
    return this.tracks
  }
}

const track = () => ({
  enabled: true,
  stopped: false,
  stop() {
    this.stopped = true
  },
})

let microphone: PromiseWithResolvers<FakeMediaStream>

const globals = ["RTCPeerConnection", "AudioContext", "Audio", "MediaStream"] as const

const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))

const savedMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")

beforeEach(() => {
  jest.useFakeTimers()
  microphone = Promise.withResolvers<FakeMediaStream>()
  const fakes = [FakePeer, FakeAudioContext, FakeAudio, FakeMediaStream]
  globals.forEach((name, index) =>
    Object.defineProperty(globalThis, name, { value: fakes[index], configurable: true, writable: true }),
  )
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => microphone.promise },
    configurable: true,
  })
})

afterEach(() => {
  jest.useRealTimers()
  const missing = { value: undefined, configurable: true, writable: true }
  globals.forEach((name, index) => Object.defineProperty(globalThis, name, saved[index] ?? missing))
  Object.defineProperty(navigator, "mediaDevices", savedMediaDevices ?? missing)
})

type Voice = OpenCodeClient["experimental"]["voice"]

const live = { model: "gpt-live-1", provider: "openai", available: true, transports: ["webrtc" as const] }

const unused = () => Promise.reject(new Error("unused"))

const noCodex: Voice["codex"] = {
  start: unused,
  events: unused,
  tool: unused,
  speech: unused,
  context: unused,
  stop: unused,
}

function open(models: Voice["models"] = () => Promise.resolve({ models: [live] }), codex = noCodex) {
  const voice: Voice = {
    models,
    session: () => Promise.resolve({ transport: { type: "webrtc", sdp: "v=0 answer" } }),
    codex,
  }

  const dropped = jest.fn()
  const received: VoiceCodexEvent[] = []

  const transport = new VoiceTransport({
    voice,
    event: () => {},
    codex: (event) => received.push(event),
    levels: () => {},
    dropped,
  })

  return { transport, dropped, received, peer: FakePeer.last }
}

// Lets the transport's awaited WebRTC calls settle; fake timers leave promise jobs alone.
async function settle() {
  for (const _ of Array.from({ length: 20 })) await Promise.resolve()
}

async function connected() {
  const result = open()
  const joined = result.transport.join({ id: "ses_1" }, "")
  await settle()
  result.peer.channel.receive({ type: "session.started" })
  microphone.resolve(new FakeMediaStream([track()]))
  await joined

  return result
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: VoiceFailure) => error.reason,
  )

test("a microphone granted after End is stopped at once, and the join fails as a connection failure", async () => {
  const result = open()
  const joined = failure(result.transport.join({ id: "ses_1" }, ""))
  await settle()
  result.peer.channel.receive({ type: "session.started" })
  await settle()

  const closed = result.transport.close()
  // The started session gets its goodbye, and the server answers it.
  await settle()
  expect(result.peer.channel.sent.map((event) => event.type)).toEqual(["session.close"])
  result.peer.channel.receive({ type: "session.closed" })
  await closed

  expect(await joined).toBe("connection")
  expect(result.dropped).not.toHaveBeenCalled()
  const late = track()
  microphone.resolve(new FakeMediaStream([late]))
  await settle()
  expect(late.stopped).toBe(true)
})

test("End settles as soon as the server closes the channel instead of waiting out the close handshake", async () => {
  const result = await connected()
  let settled = false
  void result.transport.close().then(() => (settled = true))
  await settle()

  result.peer.channel.readyState = "closed"
  result.peer.channel.onclose?.()
  await settle()

  expect(settled).toBe(true)
  expect(result.peer.closed).toBe(true)
  expect(result.dropped).not.toHaveBeenCalled()
})

test("the join timeout fails the join and releases the peer", async () => {
  const result = open(() => new Promise(() => {}))
  const joined = failure(result.transport.join({ id: "ses_1" }, ""))
  await settle()

  jest.advanceTimersByTime(JOIN_TIMEOUT)
  await settle()

  expect(await joined).toBe("connection")
  expect(result.peer.closed).toBe(true)
  expect(result.peer.onicegatheringstatechange).toBe(null)
  expect(result.transport.signal.aborted).toBe(true)
})

test("a peer that recovers from disconnected keeps the call, and one that stays disconnected drops it", async () => {
  const result = await connected()

  result.peer.state("disconnected")
  jest.advanceTimersByTime(DISCONNECT_GRACE - 1)
  result.peer.state("connected")
  jest.advanceTimersByTime(DISCONNECT_GRACE)
  expect(result.dropped).not.toHaveBeenCalled()
  expect(result.transport.canSend).toBe(true)

  result.peer.state("disconnected")
  jest.advanceTimersByTime(DISCONNECT_GRACE)
  expect(result.dropped).toHaveBeenCalledTimes(1)
  expect(result.transport.canSend).toBe(false)

  // The server never answers session.close on a dead link, so the close timer releases the peer.
  jest.advanceTimersByTime(CLOSE_TIMEOUT)
  await result.transport.close()
  expect(result.peer.closed).toBe(true)
})

test("a rejected session.update keeps the live call open", async () => {
  const result = await connected()

  result.peer.channel.receive({
    type: "error",
    error: { type: "invalid_request_error", code: "invalid_value", message: "Bad instructions" },
  })

  expect(result.dropped).not.toHaveBeenCalled()
  expect(result.transport.canSend).toBe(true)
  result.transport.instructions("Next")
  expect(result.peer.channel.sent.at(-1)?.type).toBe("session.update")
  // A request keeps its own ID, so a later rejection can name the delegation that sent it.
  result.transport.send({ type: "response.create", event_id: "del_1_4" })
  expect(result.peer.channel.sent.at(-1)).toEqual({ type: "response.create", event_id: "del_1_4" })
})

test("a Codex call joins on the server's answer, relays its events, and stops the call when it ends", async () => {
  const codex = { model: "codex", provider: "codex", available: true, transports: ["webrtc" as const] }
  const polls: PromiseWithResolvers<{ events: VoiceCodexEvent[]; closed: boolean }>[] = []
  const started: Parameters<Voice["codex"]["start"]>[0][] = []
  const stopped: string[] = []

  const result = open(() => Promise.resolve({ models: [codex, live], default: "codex" }), {
    ...noCodex,
    start: (input) => {
      started.push(input)

      return Promise.resolve({ call: "thread_1", sdp: "v=0 codex" })
    },
    events: (input) => {
      expect(input.after).toBe(polls.length === 0 ? 0 : 7)
      const poll = Promise.withResolvers<{ events: VoiceCodexEvent[]; closed: boolean }>()
      polls.push(poll)

      return poll.promise
    },
    stop: (input) => {
      stopped.push(input.callID)

      return Promise.resolve()
    },
  })

  const joined = result.transport.join({ id: "ses_1", title: "Desktop" }, "")
  await settle()
  // Codex's call never says session.started on the data channel; the server's answer means it started.
  microphone.resolve(new FakeMediaStream([track()]))
  await joined
  expect(result.transport.engine).toBe("codex")
  expect(started[0]?.sdp).toBe("v=0 offer")
  expect(started[0]?.context).toBe('Viewed session: {"id":"ses_1","title":"Desktop"}')
  expect(started[0]?.tools.map((tool) => tool.name)).toContain("send_message")

  const tool: VoiceCodexEvent = { seq: 7, type: "tool", id: "exec_1", name: "list_sessions", arguments: "{}" }
  polls[0]?.resolve({ events: [tool], closed: false })
  await settle()
  expect(result.received).toEqual([tool])
  // Muting only silences the track; Codex owns the session, so nothing goes over the data channel.
  result.transport.mute(true)
  expect(result.peer.channel.sent).toEqual([])

  polls[1]?.resolve({ events: [{ seq: 8, type: "closed", reason: "transport_closed" }], closed: true })
  await settle()
  expect(result.dropped).toHaveBeenCalledTimes(1)
  expect(result.received).toEqual([tool])
  expect(stopped).toEqual(["thread_1"])
  await result.transport.close()
  expect(result.peer.closed).toBe(true)
})
