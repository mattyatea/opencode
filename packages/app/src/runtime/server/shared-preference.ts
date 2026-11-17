import { createEffect, createMemo, onCleanup, untrack, type Accessor } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { Option, Schema } from "effect"
import type { ExperimentalPreferenceGetInput } from "@opencode/client/promise"
import { Persistence } from "@/runtime/persistence/schema"
import type { ServerApi } from "./api"

const PUSH_DELAY = 500

type PreferenceKey = ExperimentalPreferenceGetInput["key"]

type Decision = "adopt" | "push" | "none"

/**
 * What to do with a setting this client keeps beside the server's copy. `synced` is the value both sides last agreed
 * on, absent until the first contact, so an edit made here since then always wins over a copy that changed elsewhere.
 */
export function decideSharedPreference(input: {
  local: string
  remote: string | undefined
  synced: string | undefined
  initial: string
}): Decision {
  if (input.remote === undefined) return input.local === input.initial ? "none" : "push"

  if (input.synced === undefined) return input.local === input.remote ? "none" : "adopt"

  if (input.local !== input.synced) return input.local === input.remote ? "none" : "push"

  return input.remote === input.synced ? "none" : "adopt"
}

/**
 * Keeps a persisted store in step with the server's copy, so every client of that server shares it. The server's copy
 * wins on first contact; after that the latest edit wins. Failures leave the local copy in place and retry on the next
 * focus or reconnect.
 */
export function createSharedPreference<S extends Schema.ConstraintCodec<object, unknown>>(input: {
  api: Accessor<ServerApi | undefined>
  key: PreferenceKey
  schema: S | Persistence.Migrated<S>
  initial: NoInfer<S["Type"]>
  store: Store<S["Type"]>
  setStore: SetStoreFunction<S["Type"]>
  ready: Accessor<boolean>
}) {
  const json = Schema.fromJsonString(Persistence.withInitial(input.schema, input.initial))
  const decode = Schema.decodeUnknownOption(json)
  const serialize = Schema.encodeSync(json)
  const initial = serialize(input.initial)

  // SAFETY: Solid's setter overloads are too deep to name; reconcile only replaces the whole store value.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- see SAFETY above
  const replace = input.setStore as unknown as (value: ReturnType<typeof reconcile>) => void

  let synced: string | undefined
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const local = createMemo(() => (input.ready() ? serialize(input.store) : undefined))

  const push = (api: ServerApi, value: string, current: number) =>
    api.experimental.preference
      .set({ key: input.key, value: JSON.parse(value) })
      .then(() => {
        if (current === attempt) synced = value
      })
      .catch(() => undefined)

  const pull = (api: ServerApi, current: number) =>
    api.experimental.preference
      .get({ key: input.key })
      .then((data) => {
        if (current !== attempt) return
        const value = untrack(local)

        if (value === undefined) return
        const remote = data === null ? undefined : Option.getOrUndefined(decode(JSON.stringify(data)))
        const normalized = remote === undefined ? undefined : serialize(remote)
        const decision = decideSharedPreference({ local: value, remote: normalized, synced, initial })

        if (decision === "adopt" && remote !== undefined) {
          replace(reconcile(remote))
          synced = normalized

          return
        }

        if (decision === "push") return push(api, value, current)

        synced = value
      })
      .catch(() => undefined)

  createEffect(() => {
    const api = input.api()

    if (!api || !input.ready()) return
    const current = ++attempt
    synced = undefined
    void pull(api, current)

    const refresh = () => {
      if (document.visibilityState === "visible") void pull(api, current)
    }

    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    onCleanup(() => {
      attempt++
      window.removeEventListener("focus", refresh)
      document.removeEventListener("visibilitychange", refresh)
    })
  })

  createEffect(() => {
    const value = local()
    const api = input.api()

    clearTimeout(timer)

    if (!api || value === undefined || synced === undefined || value === synced) return
    const current = attempt
    timer = setTimeout(() => void push(api, value, current), PUSH_DELAY)
  })

  onCleanup(() => clearTimeout(timer))
}
