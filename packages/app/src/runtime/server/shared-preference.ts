import { createEffect, createMemo, onCleanup, untrack, type Accessor } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import { Option, Schema } from "effect"
import type { ExperimentalPreferenceGetInput } from "@opencode/client/promise"
import { Persistence } from "@/runtime/persistence/schema"
import type { ServerApi } from "./api"

const PUSH_DELAY = 500

// What this page knows about each key outlives the component that shares it: a remount must neither forget an edit
// not yet sent nor mistake the server's older copy for a first contact. `active` serializes the requests of one key.
type Target = { api: ServerApi; synced: string | undefined; active: Promise<void> }

const targets = new Map<PreferenceKey, Target>()

function targetFor(key: PreferenceKey, api: ServerApi) {
  const current = targets.get(key)

  if (current?.api === api) return current
  const next: Target = { api, synced: undefined, active: Promise.resolve() }
  targets.set(key, next)

  return next
}

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
 * wins on first contact; after that the latest edit wins. Failures keep the local copy and retry on the next focus or
 * reconnect.
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

  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const local = createMemo(() => (input.ready() ? serialize(input.store) : undefined))

  // Runs after the key's earlier requests, so a slow request can never land after a newer one.
  const enqueue = (target: Target, run: () => Promise<void>) => {
    target.active = target.active.then(run, run).catch(() => undefined)

    return target.active
  }

  // Sends the latest local value, read when its turn comes, so edits made while a request ran go out as one.
  const send = (target: Target) =>
    enqueue(target, async () => {
      const value = input.ready() ? serialize(input.store) : undefined

      if (value === undefined || target.synced === undefined || value === target.synced) return
      await target.api.experimental.preference.set({ key: input.key, value: JSON.parse(value) })
      target.synced = value
    }).then(() => schedule(target))

  const schedule = (target: Target) => {
    clearTimeout(timer)
    const value = untrack(local)

    if (value === undefined || target.synced === undefined || value === target.synced) return
    timer = setTimeout(() => void send(target), PUSH_DELAY)
  }

  const pull = (target: Target, current: number) =>
    enqueue(target, async () => {
      const data = await target.api.experimental.preference.get({ key: input.key })

      if (current !== attempt) return
      const value = untrack(local)

      if (value === undefined) return
      const remote = data === null ? undefined : Option.getOrUndefined(decode(JSON.stringify(data)))
      const normalized = remote === undefined ? undefined : serialize(remote)
      const decision = decideSharedPreference({ local: value, remote: normalized, synced: target.synced, initial })

      if (decision === "adopt" && remote !== undefined) {
        replace(reconcile(remote))
        target.synced = normalized

        return
      }

      if (decision === "push") {
        await target.api.experimental.preference.set({ key: input.key, value: JSON.parse(value) })
        target.synced = value

        return
      }

      target.synced = value
    }).then(() => schedule(target))

  createEffect(() => {
    const api = input.api()

    if (!api || !input.ready()) return
    const target = targetFor(input.key, api)
    const current = ++attempt
    void pull(target, current)

    const refresh = () => {
      if (document.visibilityState === "visible") void pull(target, current)
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
    local()
    const api = input.api()

    if (api) schedule(targetFor(input.key, api))
  })

  // An edit still waiting for its timer goes out now: this owner may be the last to see it.
  onCleanup(() => {
    clearTimeout(timer)
    const api = untrack(input.api)

    if (api) void send(targetFor(input.key, api))
  })
}
