import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Voice } from "@opencode/core/voice"
import { InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { locationErrors } from "../location"

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
            const voice = yield* Voice.Service
            const transport = yield* voice.session(request.payload).pipe(Effect.mapError(voiceErrors))
            return { data: { transport } }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.call.start",
        Effect.fn("server.voice.call.start")(
          function* (request) {
            const voice = yield* Voice.Service
            return { data: yield* voice.call.start(request.payload).pipe(Effect.mapError(voiceErrors)) }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.call.events",
        Effect.fn("server.voice.call.events")(
          function* (request) {
            const voice = yield* Voice.Service
            return {
              data: yield* voice.call
                .events(request.params.callID, request.query.after ?? 0)
                .pipe(Effect.mapError(voiceErrors)),
            }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.call.speech",
        Effect.fn("server.voice.call.speech")(
          function* (request) {
            const voice = yield* Voice.Service
            yield* voice.call.speech(request.params.callID, request.payload.text).pipe(Effect.mapError(voiceErrors))
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.call.view",
        Effect.fn("server.voice.call.view")(
          function* (request) {
            const voice = yield* Voice.Service
            yield* voice.call.view(request.params.callID, request.payload).pipe(Effect.mapError(voiceErrors))
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "voice.call.stop",
        Effect.fn("server.voice.call.stop")(
          function* (request) {
            const voice = yield* Voice.Service
            yield* voice.call.stop(request.params.callID)
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
  }),
)
