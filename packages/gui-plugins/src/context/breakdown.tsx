import { createMemo, createSignal, For, Show } from "solid-js"
import { createLatest, usePanel, usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { Icon } from "@opencode/ui/icon"
import { useI18n } from "@opencode/ui/context/i18n"

function color(id: string) {
  switch (id) {
    case "system-prompt":
      return "var(--v2-blue-500)"
    case "system-tools":
      return "var(--v2-orange-500)"
    case "mcp-tools":
      return "var(--v2-green-500)"
    case "mcp-instructions":
      return "var(--v2-cyan-500)"
    case "skills":
      return "var(--v2-yellow-500)"
    case "instructions":
      return "var(--v2-purple-500)"
    case "references":
      return "var(--v2-pink-500)"
    case "session":
      return "var(--v2-red-500)"
    case "messages":
      return "var(--v2-grey-500)"
    default:
      return "var(--v2-grey-600)"
  }
}

/**
 * What the next request spends the context window on, as the Context tab shows it. Refreshes after each step, when the
 * session's messages change, and on demand.
 */
export function ContextWindow(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const panel = usePanel()
  const i18n = useI18n()
  const [retry, setRetry] = createSignal(0)

  const messages = createMemo(() =>
    props.session.id ? props.session.server.data.session.message.list(props.session.id) : [],
  )

  // A cold location has no agents yet. Its agent list changing is the readiness signal, so a request made too early
  // refetches once plugins have registered them.
  const agents = createMemo(() => {
    const directory = props.session.directory

    return props.session.server.data.location.agent.list(directory ? { directory } : undefined)
  })

  // A step writes its usage and completion onto the last assistant message, so both belong to the key.
  const revision = createMemo(() => {
    const list = messages()
    const last = list.at(-1)

    return [
      props.session.key,
      props.session.directory,
      list.length,
      last?.id ?? "",
      last?.type === "assistant" ? (last.time.completed ?? last.time.created) : "",
      agents()?.length ?? 0,
      panel.visible(),
      retry(),
    ].join(":")
  })

  const breakdown = createLatest(revision, (_revision, signal) => {
    const sessionID = props.session.id

    if (!sessionID || !panel.visible()) return Promise.resolve(undefined)

    return props.session.server.client.experimental.session.contextBreakdown({ sessionID }, { signal })
  })

  const compact = createMemo(
    () => new Intl.NumberFormat(i18n.locale(), { notation: "compact", maximumFractionDigits: 1 }),
  )

  const exact = createMemo(() => new Intl.NumberFormat(i18n.locale()))

  const percentFormat = createMemo(
    () => new Intl.NumberFormat(i18n.locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  )

  const percent = (tokens: number, limit: number) => {
    if (limit <= 0) return undefined

    return percentFormat().format((tokens / limit) * 100)
  }

  const partLabels = createMemo(
    () =>
      new Map<string, string>([
        ["system-prompt", ctx.t("part.systemPrompt")],
        ["system-tools", ctx.t("part.systemTools")],
        ["mcp-tools", ctx.t("part.mcpTools")],
        ["mcp-instructions", ctx.t("part.mcpInstructions")],
        ["skills", ctx.t("part.skills")],
        ["instructions", ctx.t("part.instructions")],
        ["references", ctx.t("part.references")],
        ["session", ctx.t("part.session")],
        ["messages", ctx.t("part.messages")],
        ["other", ctx.t("part.other")],
      ]),
  )

  const entryLabels = createMemo(
    () =>
      new Map<string, string>([
        ["base", ctx.t("entry.base")],
        ["user", ctx.t("entry.user")],
        ["assistant", ctx.t("entry.assistant")],
        ["tool", ctx.t("entry.tool")],
        ["system", ctx.t("entry.system")],
        ["instructions", ctx.t("entry.instructions")],
        ["core/codemode", ctx.t("entry.codemode")],
        ["core/date", ctx.t("entry.date")],
        ["core/environment", ctx.t("entry.environment")],
        ["core/mcp-guidance", ctx.t("entry.mcpInstructions")],
        ["core/skill-guidance", ctx.t("entry.skills")],
        ["core/reference-guidance", ctx.t("entry.references")],
        ["core/instructions", ctx.t("entry.instructions")],
      ]),
  )

  const partLabel = (id: string) => partLabels().get(id) ?? id

  const entryLabel = (id: string) => entryLabels().get(id) ?? id

  return (
    <section
      data-slot="context-window"
      class="flex flex-col gap-3 rounded-lg border border-v2-border-border-base bg-v2-background-bg-layer-01 p-4"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-12-regular text-text-weak">{ctx.t("contextWindow.title")}</div>
          <Show
            when={breakdown.latest}
            fallback={<div class="text-12-regular text-text-weak">{ctx.t("contextWindow.loading")}</div>}
          >
            {(data) => (
              <div class="text-16-medium text-text-strong">
                <Show when={data().limit > 0} fallback={ctx.t("contextWindow.estimated")}>
                  {ctx.t("contextWindow.percent", {
                    percent: percent(data().used, data().limit) ?? "0",
                  })}
                </Show>
              </div>
            )}
          </Show>
        </div>
        <Show when={breakdown.latest}>
          {(data) => (
            <div class="shrink-0 text-end text-12-regular tabular-nums text-text-weak">
              {compact().format(data().used)}
              <Show when={data().limit > 0}>
                {" / "}
                {compact().format(data().limit)}
              </Show>
            </div>
          )}
        </Show>
      </div>

      <Show when={breakdown.error}>
        <div class="flex items-center justify-between gap-2">
          <div class="text-12-regular text-text-weak">{ctx.t("contextWindow.unavailable")}</div>
          <button
            type="button"
            class="shrink-0 text-12-medium text-text-strong underline decoration-v2-border-border-base underline-offset-2"
            onClick={() => setRetry((value) => value + 1)}
          >
            {ctx.t("contextWindow.retry")}
          </button>
        </div>
      </Show>

      <Show when={breakdown.latest}>
        {(data) => {
          const scale = () => (data().limit > 0 ? data().limit : data().used)
          const share = (tokens: number) => (scale() > 0 ? Math.max(0, (tokens / scale()) * 100) : 0)

          return (
            <>
              <div class="flex h-2 w-full gap-px overflow-hidden rounded-full bg-v2-background-bg-layer-04">
                <For each={data().parts}>
                  {(part) => (
                    <div
                      class="h-full shrink-0 first:rounded-s-full"
                      style={{
                        width: `${share(part.tokens)}%`,
                        "background-color": color(part.id),
                      }}
                    />
                  )}
                </For>
              </div>

              <div class="flex flex-col">
                <For each={data().parts}>
                  {(part) => (
                    <PartRow
                      id={part.id}
                      tokens={part.tokens}
                      entries={part.entries}
                      label={partLabel(part.id)}
                      entryLabel={entryLabel}
                      percentOf={(tokens) => percent(tokens, data().limit)}
                      compact={compact()}
                      exact={exact()}
                    />
                  )}
                </For>
                <Show when={data().limit > 0}>
                  <div class="flex h-7 items-center gap-2.5 text-[13px] font-[440] leading-[var(--line-height-compact)] tracking-[-0.04px]">
                    <span class="size-2 shrink-0 rounded-[2px] bg-v2-background-bg-layer-04" />
                    <span class="min-w-0 truncate text-v2-text-text-base">{ctx.t("contextWindow.free")}</span>
                    <span class="ms-auto shrink-0 tabular-nums text-v2-text-text-muted">
                      {compact().format(data().free)}
                    </span>
                    <span class="w-11 shrink-0 text-end tabular-nums text-v2-text-text-muted">
                      {percent(data().free, data().limit)}%
                    </span>
                  </div>
                </Show>
              </div>
            </>
          )
        }}
      </Show>
    </section>
  )
}

function PartRow(props: {
  id: string
  tokens: number
  entries: ReadonlyArray<{ readonly id: string; readonly tokens: number }>
  label: string
  entryLabel: (id: string) => string
  percentOf: (tokens: number) => string | undefined
  compact: Intl.NumberFormat
  exact: Intl.NumberFormat
}) {
  const [open, setOpen] = createSignal(false)
  const expandable = () => props.entries.length > 1

  return (
    <>
      <button
        type="button"
        class="flex h-7 min-w-0 items-center gap-2.5 text-start text-[13px] font-[440] leading-[var(--line-height-compact)] tracking-[-0.04px] hover:bg-v2-background-bg-layer-02 disabled:hover:bg-transparent"
        disabled={!expandable()}
        aria-expanded={expandable() ? open() : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="size-2 shrink-0 rounded-[2px]" style={{ "background-color": color(props.id) }} />
        <span class="min-w-0 truncate text-v2-text-text-base">{props.label}</span>
        <Show when={expandable()}>
          <Icon
            name={open() ? "chevron-down" : "outline-chevron-right"}
            size="small"
            class="shrink-0 text-v2-icon-icon-muted"
          />
        </Show>
        <span class="ms-auto shrink-0 tabular-nums text-v2-text-text-muted">{props.compact.format(props.tokens)}</span>
        <span class="w-11 shrink-0 text-end tabular-nums text-v2-text-text-muted">
          {props.percentOf(props.tokens) === undefined ? "—" : `${props.percentOf(props.tokens)}%`}
        </span>
      </button>
      <Show when={expandable() && open()}>
        <For each={props.entries}>
          {(entry) => (
            <div class="flex h-6 min-w-0 items-center gap-2.5 ps-6 text-12-regular text-text-weak">
              <span class="min-w-0 truncate" title={entry.id}>
                {props.entryLabel(entry.id)}
              </span>
              <span class="ms-auto shrink-0 tabular-nums">{props.exact.format(entry.tokens)}</span>
              <span class="w-11 shrink-0 text-end tabular-nums">
                {props.percentOf(entry.tokens) === undefined ? "—" : `${props.percentOf(entry.tokens)}%`}
              </span>
            </div>
          )}
        </For>
      </Show>
    </>
  )
}
