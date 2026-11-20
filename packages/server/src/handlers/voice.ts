import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Voice } from "@opencode/core/voice"
import { InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { awaitPlugins, locationErrors } from "../location"

export const VoiceHandler = HttpApiBuilder.group(Api, "server.voice", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    const voiceErrors = (error: Voice.Error) =>
      error._tag === "Voice.InvalidRequestError"
        ? new InvalidRequestError({ message: error.message })
        : new ServiceUnavailableError({ message: error.message, service: error.service })
    return handlers
      .handle(
        "voice.models",
        Effect.fn("server.voice.models")(
          function* () {
            yield* awaitPlugins
            const voice = yield* Voice.Service
            return { data: yield* voice.models() }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.session",
        Effect.fn("server.voice.session")(
          function* (request) {
            yield* awaitPlugins
            const voice = yield* Voice.Service
            const transport = yield* voice.session(request.payload).pipe(Effect.mapError(voiceErrors))
            return { data: { transport } }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.codex.start",
        Effect.fn("server.voice.codex.start")(
          function* (request) {
            const voice = yield* Voice.Service
            return { data: yield* voice.codex.start(request.payload).pipe(Effect.mapError(voiceErrors)) }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.codex.events",
        Effect.fn("server.voice.codex.events")(
          function* (request) {
            const voice = yield* Voice.Service
            return {
              data: yield* voice.codex
                .events(request.params.callID, request.query.after ?? 0)
                .pipe(Effect.mapError(voiceErrors)),
            }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.codex.tool",
        Effect.fn("server.voice.codex.tool")(
          function* (request) {
            const voice = yield* Voice.Service
            yield* voice.codex
              .tool(request.params.callID, request.payload.id, request.payload.output, request.payload.success)
              .pipe(Effect.mapError(voiceErrors))
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.codex.speech",
        Effect.fn("server.voice.codex.speech")(
          function* (request) {
            const voice = yield* Voice.Service
            yield* voice.codex.speech(request.params.callID, request.payload.text).pipe(Effect.mapError(voiceErrors))
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.codex.context",
        Effect.fn("server.voice.codex.context")(
          function* (request) {
            const voice = yield* Voice.Service
            yield* voice.codex.context(request.params.callID, request.payload.text).pipe(Effect.mapError(voiceErrors))
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.codex.stop",
        Effect.fn("server.voice.codex.stop")(
          function* (request) {
            const voice = yield* Voice.Service
            yield* voice.codex.stop(request.params.callID)
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
  }),
)
