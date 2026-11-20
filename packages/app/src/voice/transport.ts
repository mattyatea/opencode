import type { OpenCodeClient, VoiceCodexEvent } from "@opencode/client/promise"
import { uuid } from "@opencode/util/uuid"
import { decodeEvent, type VoiceEvent } from "./protocol"
import {
  codexDelegatorInstructions,
  codexLiveInstructions,
  codexTools,
  delegatorInstructions,
  liveInstructions,
  tools,
  viewedSession,
} from "./spec"
import {
  canJoinVoiceTransport,
  canSendVoiceTransport,
  createVoiceTransportState,
  isAcquiringMicVoiceTransport,
  transitionVoiceTransport,
  type VoiceJoinFailure,
  type VoiceJoinTarget,
  type VoiceTransportEffect,
  type VoiceTransportEvent,
} from "./transport-machine"

export class VoiceFailure extends Error {
  constructor(readonly reason: VoiceJoinFailure | "dropped") {
    super(reason)
  }
}

/** A client event sent over the Live data channel; the transport adds `event_id`. */
export type VoiceClientEvent =
  | { type: "session.input_audio.mute" | "session.input_audio.unmute" }
  /** `event_id` names the request, so Live's rejection of it can be routed back. */
  | { type: "response.create"; event_id: string }
  | { type: "session.update"; session: { delegation: { type: "responses"; responses: { instructions: string } } } }
  | { type: "response.item.create"; item: { type: "function_call_output"; call_id: string; output: string } }
  | { type: "session.commentary.append"; delegation_id: null; content: string }

/**
 * Who runs the call. `live` is GPT-Live on the server's key, whose delegations reach the app over the data channel.
 * `codex` is Codex realtime through the server's `codex app-server`: Codex owns delegations, and its agent's tool calls
 * and the transcript arrive as server events instead.
 */
export type VoiceEngine = "live" | "codex"

/** Polls a failing events request at most this often, so a restarting server isn't hammered. */
const CODEX_RETRY_MS = 1_000

/** One join of a WebRTC Live session; `transport-machine.ts` owns its lifecycle. */
export class VoiceTransport {
  private readonly abort = new AbortController()
  private peer = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" })
  private channel = this.peer.createDataChannel("oai-events", { negotiated: true, id: 4, ordered: true })
  private sender = this.peer.addTransceiver("audio", { direction: "sendrecv" }).sender
  private audio = new Audio()
  private context = new AudioContext()
  private state = createVoiceTransportState()
  private joined = Promise.withResolvers<void>()
  private released = Promise.withResolvers<void>()
  private stream?: MediaStream
  private remoteTrack?: MediaStreamTrack
  private input?: AnalyserNode
  private output?: AnalyserNode
  private samples = new Float32Array(256)
  private joinTimer?: ReturnType<typeof setTimeout>
  private disconnectTimer?: ReturnType<typeof setTimeout>
  private closeTimer?: ReturnType<typeof setTimeout>
  private levelTimer?: ReturnType<typeof setInterval>
  /** Chosen from `voice.models` before the offer; fixed for this join. */
  engine: VoiceEngine = "live"
  /** The Codex call this transport started, once the server answered. */
  private codexCall?: string
  /** Settles once the server stopped the Codex call; every close stops it, with or without a handshake. */
  private codexStopped?: Promise<unknown>

  constructor(
    private readonly inputOptions: {
      voice: OpenCodeClient["experimental"]["voice"]
      event: (event: VoiceEvent) => void
      /** A Codex call's server event: transcript, delegation or tool call. */
      codex: (event: VoiceCodexEvent) => void
      levels: (input: number, output: number) => void
      dropped: () => void
    },
  ) {
    // A media element pulls the remote track in Chromium. A Web Audio-only
    // sink can report silence even while RTP is arriving.
    this.audio.autoplay = true
    this.channel.onmessage = (message: MessageEvent<string>) => {
      const event = decodeEvent(message.data)

      if (event) this.dispatch({ type: "channel.message", event })
    }

    this.channel.onclose = () => this.dispatch({ type: "channel.closed" })
    this.peer.onicegatheringstatechange = () => {
      if (this.peer.iceGatheringState === "complete") this.dispatch({ type: "ice.complete" })
    }

    this.peer.onconnectionstatechange = () => this.dispatch({ type: "peer.state", state: this.peer.connectionState })
    this.peer.ontrack = (event) => {
      this.remoteTrack = event.track
      this.dispatch({ type: "track.received" })
    }
  }

  /** Aborts once the transport starts closing. */
  get signal() {
    return this.abort.signal
  }

  get canSend() {
    return canSendVoiceTransport(this.state)
  }

  join(viewing: VoiceJoinTarget, tail: string) {
    if (!canJoinVoiceTransport(this.state)) return Promise.reject(new VoiceFailure("connection"))
    this.dispatch({ type: "join", viewing, tail })

    return this.joined.promise
  }

  send(event: VoiceClientEvent) {
    if (!this.canSend || this.channel.readyState !== "open") throw new VoiceFailure("dropped")
    this.channel.send(JSON.stringify({ event_id: uuid(), ...event }))
  }

  mute(muted: boolean) {
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })

    // Codex owns the session, so a muted track is all the app controls; silence reads as nobody speaking.
    if (this.engine === "codex") return
    this.send({ type: muted ? "session.input_audio.mute" : "session.input_audio.unmute" })
  }

  /** The call runs on the server's own OpenAI key, so its data channel can update the backend's instructions. */
  instructions(instructions: string) {
    this.send({ type: "session.update", session: { delegation: { type: "responses", responses: { instructions } } } })
  }

  /** Tells a Codex call's agent which session is on screen. */
  view(viewing: VoiceJoinTarget) {
    return this.codex((voice, callID) =>
      voice.context({ callID, text: viewedSession(viewing) }, { signal: this.signal }),
    )
  }

  /** Has a Codex call's voice say text. */
  speak(text: string) {
    return this.codex((voice, callID) => voice.speech({ callID, text }, { signal: this.signal }))
  }

  /** Returns a tool call's output to a Codex call's agent. */
  answer(id: string, output: string, success: boolean) {
    return this.codex((voice, callID) => voice.tool({ callID, id, output, success }, { signal: this.signal }))
  }

  private codex<A>(run: (voice: OpenCodeClient["experimental"]["voice"]["codex"], callID: string) => Promise<A>) {
    const callID = this.codexCall

    if (this.engine !== "codex" || !callID || !this.canSend) return Promise.reject(new VoiceFailure("dropped"))

    return run(this.inputOptions.voice.codex, callID)
  }

  /** Settles once the peer connection and audio are released. */
  close() {
    this.dispatch({ type: "close" })

    return this.released.promise
  }

  private dispatch(event: VoiceTransportEvent) {
    const next = transitionVoiceTransport(this.state, event)
    // Set first: an effect's callback may close this transport again.
    this.state = next.state
    next.effects.forEach((effect) => this.perform(effect))
  }

  private perform(effect: VoiceTransportEffect) {
    if (effect.type === "join.timer.start") {
      this.joinTimer = setTimeout(() => this.dispatch({ type: "join.timeout" }), effect.ms)

      return
    }

    if (effect.type === "join.timer.clear") return clearTimeout(this.joinTimer)

    if (effect.type === "disconnect.timer.start") {
      clearTimeout(this.disconnectTimer)
      this.disconnectTimer = setTimeout(
        () => this.dispatch({ type: "disconnect.timeout", attempt: effect.attempt }),
        effect.ms,
      )

      return
    }

    if (effect.type === "disconnect.timer.clear") return clearTimeout(this.disconnectTimer)

    if (effect.type === "prepare.offer") {
      void this.prepareOffer().catch(() => this.dispatch({ type: "step.failed", step: "offer", reason: "connection" }))

      return
    }

    if (effect.type === "negotiate") {
      void this.negotiate(effect.viewing, effect.tail).catch(() =>
        this.dispatch({ type: "step.failed", step: "negotiating", reason: "connection" }),
      )

      return
    }

    if (effect.type === "acquire.mic") {
      void this.acquireMic().catch(() => this.dispatch({ type: "step.failed", step: "mic", reason: "connection" }))

      return
    }

    if (effect.type === "attach.remote.track") {
      if (!this.remoteTrack) return
      const stream = new MediaStream([this.remoteTrack])
      this.audio.srcObject = stream
      this.output = this.analyser(stream)
      void this.audio.play().catch(() => this.dispatch({ type: "audio.play.failed" }))

      return
    }

    if (effect.type === "meter.start") {
      this.levelTimer = setInterval(
        () => this.inputOptions.levels(this.level(this.input), this.level(this.output)),
        effect.ms,
      )

      return
    }

    if (effect.type === "stop.media") {
      const callID = this.codexCall

      if (callID) this.codexStopped = this.inputOptions.voice.codex.stop({ callID }).catch(() => undefined)
      this.stream?.getTracks().forEach((track) => track.stop())
      this.audio.pause()
      this.audio.srcObject = null
      clearInterval(this.levelTimer)
      this.peer.onicegatheringstatechange = null
      this.abort.abort()

      return
    }

    if (effect.type === "close.handshake.start") {
      this.closeTimer = setTimeout(() => this.dispatch({ type: "close.timeout" }), effect.ms)

      if (this.engine === "codex") {
        // Codex says goodbye to OpenAI itself; the handshake ends once the server stopped the call.
        void Promise.resolve(this.codexStopped).then(() => this.dispatch({ type: "channel.closed" }))

        return
      }

      // A channel that is already closing throws; its close event is on the way, so settle now.
      void Promise.resolve()
        .then(() => this.channel.send(JSON.stringify({ type: "session.close", event_id: uuid() })))
        .catch(() => this.dispatch({ type: "channel.closed" }))

      return
    }

    if (effect.type === "close.timer.clear") return clearTimeout(this.closeTimer)

    if (effect.type === "release.peer") {
      this.channel.onmessage = null
      this.channel.onclose = null
      this.peer.onconnectionstatechange = null
      this.peer.ontrack = null
      this.peer.close()
      void this.context
        .close()
        .catch(() => undefined)
        .then(() => this.dispatch({ type: "peer.released" }))

      return
    }

    if (effect.type === "forward.event") return this.inputOptions.event(effect.event)

    if (effect.type === "join.resolve") return this.joined.resolve()

    if (effect.type === "join.reject") return this.joined.reject(new VoiceFailure(effect.reason))

    if (effect.type === "notify.dropped") return this.inputOptions.dropped()

    this.released.resolve()
  }

  private async prepareOffer() {
    await this.context.resume()
    const offered = await this.inputOptions.voice.models({ signal: this.abort.signal })

    const usable = (name: string) =>
      offered.models.some((model) => model.model === name && model.available && model.transports.includes("webrtc"))

    // The server picks Codex when voice.codex is configured; otherwise the call needs GPT-Live.
    this.engine = offered.default === "codex" && usable("codex") ? "codex" : "live"

    if (this.engine === "live" && !usable("gpt-live-1"))
      return this.dispatch({ type: "step.failed", step: "offer", reason: "unavailable" })

    await this.peer.setLocalDescription(await this.peer.createOffer())
    this.dispatch({ type: "offer.ready", iceComplete: this.peer.iceGatheringState === "complete" })
  }

  private async negotiate(viewing: VoiceJoinTarget, tail: string) {
    if (this.engine === "codex") return this.negotiateCodex(viewing)

    const response = await this.inputOptions.voice.session(
      {
        model: "gpt-live-1",
        session: {
          model: "gpt-live-1",
          instructions: liveInstructions,
          audio: { output: { voice: "marin" } },
          delegation: {
            type: "responses",
            responses: {
              model: "gpt-6.1-sol",
              instructions: delegatorInstructions(viewing, tail),
              tools,
              reasoning: { effort: "low" },
            },
          },
        },
        transport: { type: "webrtc", sdp: this.peer.localDescription!.sdp, dcid: 4 },
      },
      { signal: this.abort.signal },
    )

    if (response.transport.type !== "webrtc")
      return this.dispatch({ type: "step.failed", step: "negotiating", reason: "connection" })
    await this.peer.setRemoteDescription({ type: "answer", sdp: response.transport.sdp })
    this.dispatch({ type: "answer.applied" })
  }

  private async negotiateCodex(viewing: VoiceJoinTarget) {
    const started = await this.inputOptions.voice.codex.start(
      {
        sdp: this.peer.localDescription!.sdp,
        instructions: { voice: codexLiveInstructions, delegator: codexDelegatorInstructions },
        tools: codexTools,
        context: viewedSession(viewing),
      },
      { signal: this.abort.signal },
    )

    this.codexCall = started.call

    // A call that ended while Codex started it must not stay open on OpenAI.
    if (this.abort.signal.aborted)
      return void this.inputOptions.voice.codex.stop({ callID: started.call }).catch(() => undefined)
    await this.peer.setRemoteDescription({ type: "answer", sdp: started.sdp })
    this.dispatch({ type: "answer.applied" })
    // Codex answered only after its realtime session started, which Live reports with `session.started`.
    this.dispatch({ type: "channel.message", event: { type: "session.started" } })
    void this.pollCodex(started.call)
  }

  /** Reads the Codex call's events until it closes or this transport does; a closed call drops the join. */
  private async pollCodex(callID: string) {
    const signal = this.abort.signal
    let after = 0

    while (!signal.aborted) {
      const result = await this.inputOptions.voice.codex.events({ callID, after }, { signal }).catch(() => undefined)

      if (signal.aborted) return

      if (!result) {
        await new Promise((resolve) => setTimeout(resolve, CODEX_RETRY_MS))
        continue
      }

      for (const event of result.events) {
        after = Math.max(after, event.seq)

        if (event.type !== "closed") this.inputOptions.codex(event)
      }

      if (result.closed) return this.dispatch({ type: "channel.closed" })
    }
  }

  private async acquireMic() {
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      .catch(() => undefined)

    if (!stream) return this.dispatch({ type: "step.failed", step: "mic", reason: "microphone" })

    // A permission granted after End or the join timeout must not keep the microphone on.
    if (!isAcquiringMicVoiceTransport(this.state)) return stream.getTracks().forEach((track) => track.stop())

    this.stream = stream
    this.input = this.analyser(stream)
    await this.sender.replaceTrack(stream.getAudioTracks()[0])
    this.dispatch({ type: "mic.ready" })
  }

  private analyser(stream: MediaStream) {
    const node = this.context.createAnalyser()
    node.fftSize = 256
    this.context.createMediaStreamSource(stream).connect(node)

    return node
  }

  private level(node?: AnalyserNode) {
    if (!node) return 0
    node.getFloatTimeDomainData(this.samples)

    return Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length)
  }
}
