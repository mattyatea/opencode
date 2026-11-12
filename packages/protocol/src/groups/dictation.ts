import { Model } from "@opencode/schema/model"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import {
  InvalidRequestError,
  LocationNotFoundError,
  ModelNotFoundError,
  ProviderNotFoundError,
  ProviderRequestError,
  ServiceUnavailableError,
  UnsupportedModelError,
} from "../errors.js"

const description = "Experimental: may change without compatibility guarantees."

const errors = [ServiceUnavailableError, LocationNotFoundError]

export const DictationStatus = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.optional(Schema.Literals(["disabled", "unsupported"])),
}).annotate({ identifier: "DictationStatus" })

export const DictationGroup = HttpApiGroup.make("server.dictation")
  .add(
    HttpApiEndpoint.get("dictation.status", "/api/experimental/dictation/status", {
      success: Schema.Struct({ data: DictationStatus }).annotate({ identifier: "DictationStatusResponse" }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.dictation.status",
        summary: "Dictation status",
        description: `Whether this server can transcribe speech locally. ${description}`,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("dictation.languages", "/api/experimental/dictation/languages", {
      success: Schema.Struct({ data: Schema.Struct({ languages: Schema.Array(Schema.String) }) }).annotate({
        identifier: "DictationLanguagesResponse",
      }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.dictation.languages",
        summary: "Dictation languages",
        description: `The speech model's supported languages, read without downloading its weights. ${description}`,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("dictation.prepare", "/api/experimental/dictation/prepare", {
      success: Schema.Struct({ data: Schema.Struct({ model: Schema.String }) }).annotate({
        identifier: "DictationPrepareResponse",
      }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.dictation.prepare",
        summary: "Prepare dictation",
        description: `Start the transcription worker and load the speech model, downloading it on first use. ${description}`,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("dictation.transcribe", "/api/experimental/dictation/transcribe", {
      payload: Schema.Struct({
        session: Schema.String,
        audio: Schema.String.annotate({ description: "Base64 little-endian 16-bit mono PCM at 16 kHz." }),
        final: Schema.Boolean,
        language: Schema.optional(Schema.String),
      }),
      success: Schema.Struct({ data: Schema.Struct({ text: Schema.String }) }).annotate({
        identifier: "DictationTranscribeResponse",
      }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.dictation.transcribe",
        summary: "Transcribe dictation",
        description: `Append audio to a recording and return its transcript so far; \`final\` ends the recording. ${description}`,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("dictation.cancel", "/api/experimental/dictation/cancel", {
      payload: Schema.Struct({ session: Schema.String }),
      success: Schema.Struct({ data: Schema.Struct({}) }).annotate({ identifier: "DictationCancelResponse" }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.dictation.cancel",
        summary: "Cancel dictation",
        description: `Drop a recording's audio. ${description}`,
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("dictation.cleanup", "/api/experimental/dictation/cleanup", {
      payload: Schema.Struct({ text: Schema.String, model: Model.Ref.pipe(Schema.optional) }),
      success: Schema.Struct({ data: Schema.Struct({ text: Schema.String }) }).annotate({
        identifier: "DictationCleanupResponse",
      }),
      error: [
        InvalidRequestError,
        ProviderNotFoundError,
        ModelNotFoundError,
        UnsupportedModelError,
        ProviderRequestError,
        ServiceUnavailableError,
        LocationNotFoundError,
      ],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "experimental.dictation.cleanup",
        summary: "Clean up dictation",
        description: `Remove fillers from dictated text and structure it with a model. The text is sent to the model's provider. ${description}`,
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "dictation",
      description: "Experimental local speech-to-text for the composer.",
    }),
  )
