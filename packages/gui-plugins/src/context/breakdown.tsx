import { createMemo, For, Show } from "solid-js"
import type { SessionMessageAssistant } from "@opencode/client/promise"
import { usePlugin } from "@opencode/plugin/gui"
import { useI18n } from "@opencode/ui/context/i18n"

export function ContextBreakdown(props: {
  message?: SessionMessageAssistant
  previous?: SessionMessageAssistant
  limit?: number
}) {
  const ctx = usePlugin()
  const i18n = useI18n()

  const number = (value: number) => value.toLocaleString(i18n.locale())
  const context = () => props.message?.experimental?.context

  const input = () => {
    const tokens = props.message?.tokens

    return tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0
  }

  const total = () => input() + (props.message?.tokens?.output ?? 0) + (props.message?.tokens?.reasoning ?? 0)

  const reserve = () =>
    Math.max(
      0,
      Math.min((props.limit ?? 0) - total(), (props.limit ?? 0) - (context()?.autoCompactLimit ?? props.limit ?? 0)),
    )

  const free = () => Math.max(0, (props.limit ?? 0) - total() - reserve())
  const width = (value: number) => `${Math.min(100, Math.max(0, (value / (props.limit || 1)) * 100))}%`

  const estimates = createMemo(() => {
    const values = context()?.estimates

    return values ? Object.entries(values).map(([key, value]) => ({ key, value })) : []
  })

  const estimated = () => estimates().reduce((sum, item) => sum + item.value, 0)

  const changes = createMemo(() => {
    const current = context()?.fingerprints
    const previous = props.previous?.experimental?.context?.fingerprints

    if (!current || !previous) return

    return (["system", "tools", "history", "routing"] as const).filter((key) => current[key] !== previous[key])
  })

  return (
    <section class="flex flex-col gap-3 text-12-regular text-text-base" aria-label={ctx.t("breakdown.title")}>
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <span class="text-12-medium text-text-strong">{ctx.t("breakdown.title")}</span>
        <bdi dir="ltr" class="tabular-nums">
          {number(total())} / {props.limit ? number(props.limit) : "—"}
        </bdi>
      </div>
      <Show when={props.limit}>
        <div
          role="meter"
          aria-label={ctx.t("breakdown.measured")}
          aria-valuemin={0}
          aria-valuemax={props.limit}
          aria-valuenow={total()}
          class="h-2 flex overflow-hidden rounded-full bg-surface-raised-base"
        >
          <div class="h-full bg-icon-base shrink-0" style={{ width: width(total()) }} />
          <div class="h-full bg-icon-base opacity-25 shrink-0" style={{ width: width(reserve()) }} />
        </div>
        <div class="flex flex-wrap justify-between gap-2 text-text-weak">
          <span>{ctx.t("breakdown.free", { tokens: number(free()) })}</span>
          <Show when={context()?.autoCompactLimit !== undefined}>
            <span>{ctx.t("breakdown.reserve", { tokens: number(reserve()) })}</span>
          </Show>
        </div>
      </Show>
      <div class="border-t border-border-base pt-3 flex flex-col gap-2">
        <div class="flex justify-between gap-2">
          <span>{ctx.t("breakdown.input")}</span>
          <bdi class="tabular-nums">{number(input())}</bdi>
        </div>
        <div class="flex justify-between gap-2">
          <span>{ctx.t("breakdown.cache")}</span>
          <bdi class="tabular-nums">
            {number(props.message?.tokens?.cache.read ?? 0)} (
            {input() ? Math.round(((props.message?.tokens?.cache.read ?? 0) / input()) * 100) : 0}%)
          </bdi>
        </div>
      </div>
      <Show when={context()} fallback={<p class="text-text-weak">{ctx.t("breakdown.unavailable")}</p>}>
        <div class="border-t border-border-base pt-3 flex flex-col gap-2">
          <span class="text-12-medium text-text-strong">{ctx.t("breakdown.estimated")}</span>
          <For each={estimates()}>
            {(item) => (
              <div class="flex flex-col gap-1">
                <div class="flex justify-between gap-3">
                  <span>{ctx.t(`breakdown.${item.key}`)}</span>
                  <bdi class="tabular-nums">≈ {number(item.value)}</bdi>
                </div>
                <div class="h-1 rounded-full overflow-hidden bg-surface-raised-base">
                  <div
                    class="h-full bg-icon-base opacity-50"
                    style={{ width: `${(item.value / (estimated() || 1)) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </For>
          <div class="flex justify-between gap-3 pt-1">
            <span>{ctx.t("breakdown.deferred")}</span>
            <bdi class="tabular-nums">{number(context()?.deferredTools ?? 0)}</bdi>
          </div>
          <p class="text-text-weak">{ctx.t("breakdown.note")}</p>
        </div>
        <div class="border-t border-border-base pt-3 flex flex-col gap-2">
          <span class="text-12-medium text-text-strong">{ctx.t("breakdown.changes")}</span>
          <Show when={changes()} fallback={<span class="text-text-weak">{ctx.t("breakdown.noBaseline")}</span>}>
            {(keys) => (
              <Show when={keys().length} fallback={<span>{ctx.t("breakdown.unchanged")}</span>}>
                <For each={keys()}>{(key) => <span>{ctx.t(`breakdown.changed.${key}`)}</span>}</For>
              </Show>
            )}
          </Show>
          <p class="text-text-weak">{ctx.t("breakdown.cacheNote")}</p>
        </div>
      </Show>
    </section>
  )
}
