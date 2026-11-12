import { Dictation } from "@opencode/core/dictation"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { locationErrors } from "../location"
import { generateError } from "./generate"

export const DictationHandler = HttpApiBuilder.group(Api, "server.dictation", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const locations = yield* LocationServiceMap.Service
    // One speech model serves every project, so dictation runs in the global Location.
    const services = locations.get(Location.Ref.make({ directory: AbsolutePath.make(global.config) }))
    const unavailable = (error: Dictation.UnavailableError) =>
      new ServiceUnavailableError({ message: error.message, service: "dictation" })
    return handlers
      .handle(
        "dictation.status",
        Effect.fn("server.dictation.status")(
          function* () {
            const dictation = yield* Dictation.Service
            return { data: yield* dictation.status() }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "dictation.languages",
        Effect.fn("server.dictation.languages")(
          function* () {
            const dictation = yield* Dictation.Service
            return { data: { languages: yield* dictation.languages().pipe(Effect.mapError(unavailable)) } }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "dictation.prepare",
        Effect.fn("server.dictation.prepare")(
          function* () {
            const dictation = yield* Dictation.Service
            return { data: yield* dictation.prepare().pipe(Effect.mapError(unavailable)) }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "dictation.transcribe",
        Effect.fn("server.dictation.transcribe")(
          function* (request) {
            const dictation = yield* Dictation.Service
            return { data: { text: yield* dictation.transcribe(request.payload).pipe(Effect.mapError(unavailable)) } }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "dictation.cancel",
        Effect.fn("server.dictation.cancel")(
          function* (request) {
            const dictation = yield* Dictation.Service
            yield* dictation.cancel(request.payload.session)
            return { data: {} }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
      .handle(
        "dictation.cleanup",
        Effect.fn("server.dictation.cleanup")(
          function* (request) {
            const dictation = yield* Dictation.Service
            return { data: { text: yield* dictation.cleanup(request.payload).pipe(Effect.mapError(generateError)) } }
          },
          Effect.provide(services),
          locationErrors,
        ),
      )
  }),
)
