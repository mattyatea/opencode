import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError, LocationNotFoundError, ServiceUnavailableError } from "../errors.js"

export const VoiceTransportType = Schema.Literals(["webrtc", "websocket"]).annotate({
  identifier: "VoiceTransportType",
})

export const VoiceModel = Schema.Struct({
  model: Schema.String,
  provider: Schema.String,
  transports: Schema.Array(VoiceTransportType),
  available: Schema.Boolean,
}).annotate({ identifier: "VoiceModel" })

export const VoiceWebRTCTransportInput = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
  dcid: Schema.optional(Schema.Number),
}).annotate({ identifier: "VoiceWebRTCTransportInput" })

export const VoiceWebSocketTransportInput = Schema.Struct({
  type: Schema.Literal("websocket"),
}).annotate({ identifier: "VoiceWebSocketTransportInput" })

export const VoiceTransportInput = Schema.Union([VoiceWebRTCTransportInput, VoiceWebSocketTransportInput]).annotate({
  identifier: "VoiceTransportInput",
})

export const VoiceWebRTCTransport = Schema.Struct({
  type: Schema.Literal("webrtc"),
  sdp: Schema.String,
}).annotate({ identifier: "VoiceWebRTCTransport" })

export const VoiceWebSocketTransport = Schema.Struct({
  type: Schema.Literal("websocket"),
  url: Schema.String,
  token: Schema.String,
  expiresAt: Schema.Number,
}).annotate({ identifier: "VoiceWebSocketTransport" })

export const VoiceTransport = Schema.Union([VoiceWebRTCTransport, VoiceWebSocketTransport]).annotate({
  identifier: "VoiceTransport",
})

const role = Schema.Literals(["user", "assistant"])

export const VoiceCallEvent = Schema.Union([
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("transcript"), role, delta: Schema.String }),
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("transcript.done"), role, text: Schema.String }),
  Schema.Struct({
    seq: Schema.Number,
    type: Schema.Literal("delegation"),
    id: Schema.String,
    status: Schema.Literals(["started", "completed"]),
  }),
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("open"), sessionID: Schema.String }),
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("closed"), reason: Schema.optional(Schema.String) }),
]).annotate({ identifier: "VoiceCallEvent" })

export const VoiceViewing = Schema.Struct({ id: Schema.String, title: Schema.optional(Schema.String) }).annotate({
  identifier: "VoiceViewing",
})

const call = { callID: Schema.String }

const callErrors = [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError]

export const VoiceGroup = HttpApiGroup.make("server.voice")
  .add(
    HttpApiEndpoint.get("voice.models", "/api/experimental/voice/models", {
      success: Schema.Struct({
        data: Schema.Struct({
          models: Schema.Array(VoiceModel),
          default: Schema.optional(Schema.String),
        }),
      }).annotate({ identifier: "VoiceModelsResponse" }),
      error: [ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.models",
        summary: "List voice models",
        description:
          "List supported voice models, their transports, and whether the server has a usable API key for each provider.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.session", "/api/experimental/voice/session", {
      payload: Schema.Struct({
        model: Schema.String,
        session: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        transport: VoiceTransportInput,
      }),
      success: Schema.Struct({
        data: Schema.Struct({
          transport: VoiceTransport,
        }),
      }).annotate({ identifier: "VoiceSessionResponse" }),
      error: [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.session",
        summary: "Create voice session",
        description:
          "Create a server-brokered voice session using the server's configured provider credentials and return the WebRTC SDP answer or WebSocket ephemeral token.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.call.start", "/api/experimental/voice/call", {
      payload: Schema.Struct({
        sdp: Schema.String,
        directory: Schema.String,
        viewing: Schema.optional(VoiceViewing),
      }),
      success: Schema.Struct({
        data: Schema.Struct({ call: Schema.String, sdp: Schema.String }),
      }).annotate({ identifier: "VoiceCallStartResponse" }),
      error: callErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.call.start",
        summary: "Start voice call on the ChatGPT plan",
        description:
          "Experimental: may change without compatibility guarantees. Start GPT-Live on the ChatGPT plan with the server's Codex sign-in and return its WebRTC SDP answer. OpenCode answers the voice's requests in a voice session in `directory`.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("voice.call.events", "/api/experimental/voice/call/:callID/events", {
      params: call,
      query: Schema.Struct({
        after: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
      }),
      success: Schema.Struct({
        data: Schema.Struct({ events: Schema.Array(VoiceCallEvent), closed: Schema.Boolean }),
      }).annotate({ identifier: "VoiceCallEventsResponse" }),
      error: callErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.call.events",
        summary: "Read voice call events",
        description:
          "Experimental: may change without compatibility guarantees. Return the call's events after `after`, waiting up to 20 seconds for one: transcripts, requests OpenCode works on, sessions to show, errors and close.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.call.speech", "/api/experimental/voice/call/:callID/speech", {
      params: call,
      payload: Schema.Struct({ text: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: callErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.call.speech",
        summary: "Speak on voice call",
        description: "Experimental: may change without compatibility guarantees. Have the call's voice say the text.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.call.view", "/api/experimental/voice/call/:callID/view", {
      params: call,
      payload: VoiceViewing,
      success: HttpApiSchema.NoContent,
      error: callErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.call.view",
        summary: "Update voice call view",
        description:
          "Experimental: may change without compatibility guarantees. Record which session Desktop shows, which the call's requests mean by this session.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("voice.call.stop", "/api/experimental/voice/call/:callID", {
      params: call,
      success: HttpApiSchema.NoContent,
      error: [LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.call.stop",
        summary: "Stop voice call",
        description: "Experimental: may change without compatibility guarantees. End the voice call.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "voice",
      description: "Experimental server-brokered voice session routes.",
    }),
  )
