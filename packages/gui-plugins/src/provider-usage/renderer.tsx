import { Popover } from "@kobalte/core/popover"
import { createKeyed, Style, type Plugin } from "@opencode/plugin/gui"
import { BuiltinSlot } from "@opencode/plugin/gui/builtin"
import { ProviderUsage } from "@opencode/schema/provider-usage"
import { For, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import css from "./provider-usage.css?inline"
import type ProviderUsageDefinition from "./index"

type Mode = "used" | "remaining"

type Tone = "warn" | "hot" | "full" | undefined

const REFRESH_EVERY = 300_000

/**
 * Subscription usage of the signed-in providers beside the composer's model and variant selects: a ring per provider
 * with its most-used limit, and a popover with every limit, its reset time and a refresh. The server's provider usage
 * plugin reads the providers and caches them for five minutes.
 */
const setup: Plugin.Setup<typeof ProviderUsageDefinition> = (ctx) => {
  const [state, setState] = createStore<{
    snapshot?: ProviderUsage.Snapshot
    failed: boolean
    loading: boolean
    open: boolean
  }>({ failed: false, loading: false, open: false })

  const mode = (): Mode => ctx.stores.display.value.mode

  // The routed session's server, else the app's own server on Home and drafts.
  const server = () => {
    const session = ctx.sessions.current()

    if (session) return session.server

    return ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((ref) => ref?.builtin)
  }

  const load = (fresh: boolean) => {
    const ref = server()

    if (!ref?.connected || state.loading) return
    setState("loading", true)
    void ref.client
      .rpc(ProviderUsage.Definition)
      .snapshot({ fresh }, { signal: ctx.signal })
      .then(
        (snapshot) => {
          if (ctx.signal.aborted) return
          setState({ snapshot, failed: false, loading: false })
        },
        () => {
          if (ctx.signal.aborted) return
          setState({ failed: true, loading: false })
        },
      )
  }

  // Fetches from the server in use whenever it changes or reconnects, then every five minutes while it stays.
  createKeyed(
    () => {
      const ref = server()

      return ref?.connected ? ref.id : undefined
    },
    () => {
      load(false)
      const timer = setInterval(() => load(false), REFRESH_EVERY)
      onCleanup(() => clearInterval(timer))
    },
  )

  const toggleMode = () =>
    void ctx.stores.display.update((draft) => {
      draft.mode = draft.mode === "used" ? "remaining" : "used"
    })

  const rings = () =>
    (state.snapshot?.providers ?? []).flatMap((provider) => {
      const top = provider.meters.toSorted((a, b) => b.usedPercent - a.usedPercent)[0]

      return top ? [{ provider, meter: top }] : []
    })

  ctx.add(Style, css)
  ctx.add(BuiltinSlot, {
    at: "composer.controls",
    order: 10,
    render: () => (
      <Show when={rings().length > 0 || state.loading || state.failed}>
        <Popover
          placement="top-end"
          gutter={8}
          overflowPadding={16}
          open={state.open}
          onOpenChange={(open) => {
            setState("open", open)

            if (open) load(false)
          }}
        >
          <Popover.Trigger
            as="button"
            type="button"
            data-slot="provider-usage-trigger"
            aria-label={ctx.t("title")}
            title={rings()
              .map((row) => `${row.provider.name}・${row.meter.label} ${percentText(row.meter.usedPercent, mode())}`)
              .join("\n")}
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
          >
            <Show when={rings().length > 0} fallback={<span>{ctx.t("empty")}</span>}>
              <For each={rings()}>
                {(row) => (
                  <span data-slot="provider-usage-ring" data-tone={tone(row.meter.usedPercent, mode())}>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <circle class="track" cx="10" cy="10" r="8" stroke-width="3" />
                      <circle
                        class="progress"
                        cx="10"
                        cy="10"
                        r="8"
                        stroke-width="3"
                        pathLength="100"
                        stroke-dasharray={`${shown(row.meter.usedPercent, mode())} 100`}
                      />
                    </svg>
                    {shortName(row.provider)}
                  </span>
                )}
              </For>
            </Show>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content data-slot="provider-usage-panel" aria-label={ctx.t("title")}>
              <Show
                when={state.snapshot}
                fallback={<div class="muted">{ctx.t(state.failed ? "failed" : "loading")}</div>}
              >
                {(snapshot) => (
                  <>
                    <For each={snapshot().providers.filter((provider) => provider.state !== "signed-out")}>
                      {(provider) => (
                        <section>
                          <div class="head">
                            <span>
                              <strong>{provider.name}</strong>
                              <Show when={provider.state === "ready" && provider.detail}>
                                {(plan) => <span> · {capitalize(plan())}</span>}
                              </Show>
                            </span>
                            <Show when={provider.state === "unavailable"}>
                              <span class="muted">{provider.detail ?? ctx.t("unavailable")}</span>
                            </Show>
                          </div>
                          <For each={provider.meters}>
                            {(meter) => (
                              <div class="row" data-tone={tone(meter.usedPercent, mode())}>
                                <div class="line">
                                  <span>{meter.label}</span>
                                  <span class="meta">
                                    <Show when={meter.resetsAt}>{(at) => <span>{resetText(at())}</span>}</Show>
                                    <span class="value">{percentText(meter.usedPercent, mode())}</span>
                                  </span>
                                </div>
                                <div class="bar">
                                  <div class="fill" style={{ width: `${shown(meter.usedPercent, mode())}%` }} />
                                </div>
                              </div>
                            )}
                          </For>
                        </section>
                      )}
                    </For>
                    <footer>
                      <span>
                        {ctx.t(state.failed ? "failed" : "checkedAt", { time: clock(snapshot().checkedAt) })}
                      </span>
                      <span class="actions">
                        <button type="button" title={ctx.t("mode.toggle")} onClick={toggleMode}>
                          {ctx.t(mode() === "used" ? "mode.used" : "mode.remaining")}
                        </button>
                        <button type="button" disabled={state.loading} onClick={() => load(true)}>
                          {ctx.t("refresh")}
                        </button>
                      </span>
                    </footer>
                  </>
                )}
              </Show>
            </Popover.Content>
          </Popover.Portal>
        </Popover>
      </Show>
    ),
  })

  function resetText(at: number) {
    if (at <= Date.now()) return ctx.t("reset")

    return ctx.t("resetsAt", { time: when(at) })
  }

  function when(at: number) {
    const date = new Date(at)
    const now = new Date()
    const sameDay = date.toDateString() === now.toDateString()
    const locale = ctx.locale.locale()
    const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)

    if (sameDay) return time

    const day =
      at - now.getTime() < 6 * 86_400_000
        ? new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)
        : new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date)

    return `${day} ${time}`
  }

  function clock(at: number) {
    return new Intl.DateTimeFormat(ctx.locale.locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(at))
  }
}

export default setup

function shortName(provider: ProviderUsage.Provider) {
  if (provider.id === "opencode") return "Go"

  return provider.name
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function shown(usedPercent: number, mode: Mode) {
  return mode === "used" ? usedPercent : Math.min(100, Math.max(0, 100 - usedPercent))
}

function percentText(usedPercent: number, mode: Mode) {
  return `${Math.round(shown(usedPercent, mode))}%`
}

function tone(usedPercent: number, mode: Mode): Tone {
  if (usedPercent >= 95) return "hot"

  if (usedPercent >= 80) return "warn"

  if (mode === "remaining" && Math.round(shown(usedPercent, mode)) === 100) return "full"

  return undefined
}
