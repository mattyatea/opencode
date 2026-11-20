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

export const VoiceCodexTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "VoiceCodexTool" })

export const VoiceCodexEvent = Schema.Union([
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("transcript"), role: Schema.String, delta: Schema.String }),
  Schema.Struct({
    seq: Schema.Number,
    type: Schema.Literal("transcript.done"),
    role: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({
    seq: Schema.Number,
    type: Schema.Literal("delegation"),
    status: Schema.Literals(["started", "completed"]),
  }),
  Schema.Struct({
    seq: Schema.Number,
    type: Schema.Literal("tool"),
    id: Schema.String,
    name: Schema.String,
    arguments: Schema.String,
  }),
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({ seq: Schema.Number, type: Schema.Literal("closed"), reason: Schema.optional(Schema.String) }),
]).annotate({ identifier: "VoiceCodexEvent" })

const codexCall = { callID: Schema.String }

const codexErrors = [InvalidRequestError, ServiceUnavailableError, LocationNotFoundError]

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
    HttpApiEndpoint.post("voice.codex.start", "/api/experimental/voice/codex", {
      payload: Schema.Struct({
        sdp: Schema.String,
        instructions: Schema.Struct({ voice: Schema.String, delegator: Schema.String }),
        tools: Schema.Array(VoiceCodexTool),
        context: Schema.optional(Schema.String),
      }),
      success: Schema.Struct({
        data: Schema.Struct({ call: Schema.String, sdp: Schema.String }),
      }).annotate({ identifier: "VoiceCodexStartResponse" }),
      error: codexErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.codex.start",
        summary: "Start Codex voice call",
        description:
          "Experimental: may change without compatibility guarantees. Start a Codex realtime call through the server's `codex app-server` and Codex sign-in, and return its WebRTC SDP answer. The Codex agent behind the call runs the given tools through this call's events.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("voice.codex.events", "/api/experimental/voice/codex/:callID/events", {
      params: codexCall,
      query: Schema.Struct({
        after: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional),
      }),
      success: Schema.Struct({
        data: Schema.Struct({ events: Schema.Array(VoiceCodexEvent), closed: Schema.Boolean }),
      }).annotate({ identifier: "VoiceCodexEventsResponse" }),
      error: codexErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.codex.events",
        summary: "Read Codex voice call events",
        description:
          "Experimental: may change without compatibility guarantees. Return the call's events after `after`, waiting up to 20 seconds for one: transcripts, delegations, tool calls to run, errors and close.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.codex.tool", "/api/experimental/voice/codex/:callID/tool", {
      params: codexCall,
      payload: Schema.Struct({ id: Schema.String, output: Schema.String, success: Schema.Boolean }),
      success: HttpApiSchema.NoContent,
      error: codexErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.codex.tool",
        summary: "Answer Codex voice tool call",
        description:
          "Experimental: may change without compatibility guarantees. Return a tool call's output to the Codex agent.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.codex.speech", "/api/experimental/voice/codex/:callID/speech", {
      params: codexCall,
      payload: Schema.Struct({ text: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: codexErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.codex.speech",
        summary: "Speak on Codex voice call",
        description: "Experimental: may change without compatibility guarantees. Have the call's voice say the text.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("voice.codex.context", "/api/experimental/voice/codex/:callID/context", {
      params: codexCall,
      payload: Schema.Struct({ text: Schema.String }),
      success: HttpApiSchema.NoContent,
      error: codexErrors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.codex.context",
        summary: "Update Codex voice context",
        description:
          "Experimental: may change without compatibility guarantees. Add developer context for the call's Codex agent, such as the session on screen.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("voice.codex.stop", "/api/experimental/voice/codex/:callID", {
      params: codexCall,
      success: HttpApiSchema.NoContent,
      error: [LocationNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.voice.codex.stop",
        summary: "Stop Codex voice call",
        description: "Experimental: may change without compatibility guarantees. End the Codex realtime call.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "voice",
      description: "Experimental server-brokered voice session routes.",
    }),
  )
