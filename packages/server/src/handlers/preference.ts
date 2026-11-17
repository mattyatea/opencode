import { KV } from "@opencode/core/kv"
import type { PreferenceKey } from "@opencode/protocol/groups/preference"
import { Effect } from "effect"
import type { Schema } from "effect"
import { HttpApiSchema } from "effect/http-api"

/** `preference.*` in the `server.experimental` group; client settings stored in the server's KV. */
export const makePreference = Effect.gen(function* () {
  const kv = yield* KV.Service

  return {
    get: (key: PreferenceKey) => kv.get(storageKey(key)).pipe(Effect.map((value) => ({ data: value ?? null }))),
    set: (key: PreferenceKey, value: Schema.Json) =>
      kv.set(storageKey(key), value).pipe(Effect.as(HttpApiSchema.NoContent.make())),
  }
})

const storageKey = (key: PreferenceKey) => `preference:${key}`
