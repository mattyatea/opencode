import { HoverCard } from "@kobalte/core/hover-card"
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

// A failed fetch, as when the window starts before its server answers, retries after 5 s, doubling up to the refresh.
const RETRY_FIRST = 5_000

/** The usage entry (`ProviderUsage.Provider.id`) behind a model provider; undefined for providers without one. */
function usageFor(providerID: string) {
  switch (providerID) {
    case "claude-agent":
    case "anthropic":
      return "claude"
    case "opencode-go":
      return "opencode"
    case "openai":
      return "openai"
    case "xai":
      return "xai"
    default:
      return undefined
  }
}

/**
 * Subscription usage of the composer's selected model beside its model and variant selects: a ring with the most-used
 * limit of that model's provider, and a popover with every limit, its reset time and a refresh. The server's provider usage
 * plugin reads the providers and caches them for five minutes.
 */
const setup: Plugin.Setup<typeof ProviderUsageDefinition> = (ctx) => {
  const [state, setState] = createStore<{
    snapshot?: ProviderUsage.Snapshot
    failed: boolean
    loading: boolean
  }>({ failed: false, loading: false })

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

  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let retryDelay = RETRY_FIRST

  onCleanup(() => clearTimeout(retryTimer))

  const load = (fresh: boolean) => {
    const ref = server()

    if (!ref?.connected || state.loading) return
    clearTimeout(retryTimer)
    setState("loading", true)
    void ref.client
      .rpc(ProviderUsage.Definition)
      .snapshot({ fresh }, { signal: ctx.signal })
      .then(
        (snapshot) => {
          if (ctx.signal.aborted) return
          retryDelay = RETRY_FIRST
          setState({ snapshot, failed: false, loading: false })
        },
        () => {
          if (ctx.signal.aborted) return
          setState({ failed: true, loading: false })
          retryTimer = setTimeout(() => load(false), retryDelay)
          retryDelay = Math.min(retryDelay * 2, REFRESH_EVERY)
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

  // The usage of the subscription behind the composer's selected model; none for providers without one.
  const routed = (providerID: string | undefined) => {
    const id = providerID === undefined ? undefined : usageFor(providerID)

    if (!id) return undefined

    return state.snapshot?.providers.find((provider) => provider.id === id && provider.state !== "signed-out")
  }

  const topMeter = (provider: ProviderUsage.Provider) =>
    provider.meters.toSorted((a, b) => b.usedPercent - a.usedPercent)[0]

  ctx.add(Style, css)
  ctx.add(BuiltinSlot, {
    at: "composer.controls",
    order: 10,
    render: (input) => (
      <Show when={routed(input.providerID)}>
        {(provider) => (
          // The card opens on hover or focus, like a tooltip, and stays open while the pointer is over it.
          <HoverCard
            placement="top-end"
            gutter={8}
            overflowPadding={16}
            openDelay={150}
            closeDelay={200}
            onOpenChange={(open) => {
              if (open) load(false)
            }}
          >
            <HoverCard.Trigger
              as="button"
              type="button"
              data-slot="provider-usage-trigger"
              aria-label={ctx.t("title")}
              onMouseDown={(event: MouseEvent) => event.preventDefault()}
            >
              <Show when={topMeter(provider())}>
                {(meter) => (
                  <span data-slot="provider-usage-ring" data-tone={tone(meter().usedPercent, mode())}>
                    <svg viewBox="0 0 20 20" aria-hidden="true">
                      <circle class="track" cx="10" cy="10" r="8" stroke-width="3" />
                      <circle
                        class="progress"
                        cx="10"
                        cy="10"
                        r="8"
                        stroke-width="3"
                        pathLength="100"
                        stroke-dasharray={`${shown(meter().usedPercent, mode())} 100`}
                      />
                    </svg>
                  </span>
                )}
              </Show>
            </HoverCard.Trigger>
            <HoverCard.Portal>
              <HoverCard.Content data-slot="provider-usage-panel" aria-label={ctx.t("title")}>
                <section>
                  <div class="head">
                    <span>
                      <strong>{ctx.t("title")}</strong>
                      <Show when={provider().state === "ready" && provider().detail}>
                        {(plan) => <span> · {capitalize(plan())}</span>}
                      </Show>
                    </span>
                    <Show when={provider().state === "unavailable"}>
                      <span class="muted">{provider().detail ?? ctx.t("unavailable")}</span>
                    </Show>
                  </div>
                  <For each={provider().meters}>
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
                <footer>
                  <span>
                    {state.failed
                      ? ctx.t("failed")
                      : ctx.t("checkedAt", { time: clock(state.snapshot?.checkedAt ?? Date.now()) })}
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
              </HoverCard.Content>
            </HoverCard.Portal>
          </HoverCard>
        )}
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
