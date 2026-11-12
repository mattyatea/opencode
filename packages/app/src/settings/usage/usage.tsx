import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { Tabs } from "@opencode/ui/tabs"
import { TextField } from "@opencode/ui/text-field"
import { createMemo, createResource, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useUsageFormat } from "@/usage/format"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Provider } from "@opencode/schema/provider"
import { Model } from "@opencode/schema/model"
import "./usage.css"

const periods = [
  { days: 1, key: "today" },
  { days: 7, key: "sevenDays" },
  { days: 30, key: "thirtyDays" },
  { days: 90, key: "ninetyDays" },
] as const
const views = ["providers", "models", "sessionBreakdown", "toolBreakdown", "skillBreakdown"] as const
const metrics = ["steps", "tokens", "cost"] as const
const tokenKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const
const tokenColumns = ["steps", ...tokenKeys, "tokens", "cost"] as const
const columns = {
  providers: tokenColumns,
  models: tokenColumns,
  sessionBreakdown: tokenColumns,
  toolBreakdown: ["calls", "successRate", "failed", "unfinished", "duration"],
  skillBreakdown: ["calls"],
} as const
// Rates and medians cannot be summed, so their share falls back to the view's volume column.
const additive = new Set<Column>(["steps", ...tokenKeys, "tokens", "cost", "calls", "failed", "unfinished"])
const pageSize = 20

type View = (typeof views)[number]
type Metric = (typeof metrics)[number]
type Column = (typeof columns)[View][number]
type Row = {
  id: string
  name: string
  detail?: string
  filter?: { provider: string; model: string }
  values: Partial<Record<Column, number>>
}

export function SettingsUsage(props: { active: boolean; headerAction?: JSX.Element }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const format = useUsageFormat()
  const [state, setState] = createStore({
    days: 7 as number,
    limit: pageSize,
    provider: "",
    model: "",
    metric: "steps" as Metric,
    view: "models" as View,
    query: "",
    sort: { column: "cost" as Column, descending: true },
  })
  const load = async (query: { days: number; provider?: string; model?: string }) => {
    const to = Date.now()
    const from = new Date(to)
    from.setHours(0, 0, 0, 0)
    from.setDate(from.getDate() - query.days + 1)
    const result = await sdk.api.experimental.session.stats({
      from: from.getTime(),
      to,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      tools: "detail",
      provider: query.provider ? Provider.ID.make(query.provider) : undefined,
      model: query.model ? Model.ID.make(query.model) : undefined,
    })
    return { ...query, value: result }
  }
  const [stats, actions] = createResource(
    () => props.active && state.days,
    (days) => load({ days }),
  )
  const [filtered, filteredActions] = createResource(
    () => (props.active && state.provider ? { days: state.days, provider: state.provider, model: state.model } : false),
    load,
  )
  // A settings read must not suspend the whole route or display the previous period as the new one.
  const info = () => {
    const resource = state.provider ? filtered : stats
    if (resource.state !== "ready" && resource.state !== "refreshing") return
    const latest = resource.latest
    if (
      latest?.days !== state.days ||
      (latest.provider ?? "") !== state.provider ||
      (latest.model ?? "") !== state.model
    )
      return
    return latest.value
  }
  const catalogue = () =>
    (stats.state === "ready" || stats.state === "refreshing") && stats.latest?.days === state.days
      ? stats.latest.value.models
      : []
  const providers = createMemo(() => ["", ...new Set(catalogue().map((row) => row.model.providerID))].sort())
  const models = createMemo(() =>
    [
      "",
      ...new Set(
        catalogue()
          .filter((row) => row.model.providerID === state.provider)
          .map((row) => row.model.id),
      ),
    ].sort(),
  )
  const loading = () => (state.provider ? filtered.loading : stats.loading)
  const error = () => (state.provider ? filtered.error : stats.error)
  const intl = (options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(language.intl(), options)
  const number = (value: number) => intl().format(value)
  const percent = (value: number) => intl({ style: "percent", maximumFractionDigits: 1 }).format(value)
  // Per-request costs are often fractions of a cent, which two-decimal currency would show as zero.
  const smallMoney = (value: number) =>
    intl({ style: "currency", currency: "USD", maximumSignificantDigits: 3 }).format(value)
  const duration = (ms: number) =>
    ms < 1_000
      ? intl({ style: "unit", unit: "millisecond", maximumFractionDigits: 0 }).format(ms)
      : intl({ style: "unit", unit: "second", maximumFractionDigits: 1 }).format(ms / 1_000)
  const cell = (column: Column, value: number) => {
    if (column === "cost") return format.money(value)
    if (column === "successRate") return percent(value)
    if (column === "duration") return duration(value)
    return number(value)
  }
  const toolUsage = () => {
    const tools = info()?.tools
    return tools?.mode === "detail" ? tools.usage : []
  }
  const toolTotals = () => {
    const tools = info()?.tools
    return tools && tools.mode !== "none" ? tools.totals : undefined
  }
  const skillCalls = () => toolUsage().find((tool) => tool.name === "skill")?.calls ?? 0
  const tokenValues = (row: { steps: number; tokens: TokenUsage.Info; cost: number }) => ({
    steps: row.steps,
    input: row.tokens.input,
    output: row.tokens.output,
    reasoning: row.tokens.reasoning,
    cacheRead: row.tokens.cache.read,
    cacheWrite: row.tokens.cache.write,
    tokens: TokenUsage.total(row.tokens),
    cost: row.cost,
  })
  const rows = createMemo((): Row[] => {
    const value = info()
    if (!value) return []
    if (state.view === "providers")
      return Array.from(
        Map.groupBy(value.models, (row) => row.model.providerID),
        ([name, models]) => ({
          id: name,
          name,
          filter: state.provider ? undefined : { provider: name, model: "" },
          values: Object.fromEntries(
            tokenColumns.map((column) => [column, models.reduce((sum, row) => sum + tokenValues(row)[column], 0)]),
          ),
        }),
      )
    if (state.view === "models")
      return value.models.map((row) => ({
        id: `${row.model.providerID}/${row.model.id}#${row.model.variant ?? ""}`,
        name: `${row.model.id}${row.model.variant ? ` #${row.model.variant}` : ""}`,
        detail: row.model.providerID,
        filter: state.model ? undefined : { provider: row.model.providerID, model: row.model.id },
        values: tokenValues(row),
      }))
    if (state.view === "sessionBreakdown")
      return (value.sessionUsage ?? []).map((row) => ({
        id: row.sessionID,
        name: row.title || row.sessionID,
        detail: row.parentID ? language.t("settings.usage.child") : undefined,
        values: tokenValues(row),
      }))
    if (state.view === "toolBreakdown")
      return toolUsage().map((row) => ({
        id: row.name,
        name: row.name,
        values: {
          calls: row.calls,
          successRate: row.calls ? row.succeeded / row.calls : 0,
          failed: row.failed,
          unfinished: row.unfinished,
          duration: row.durationP50,
        },
      }))
    return (value.skills ?? []).map((row) => ({ id: row.id, name: row.id, values: { calls: row.calls } }))
  })
  const available = () => {
    const value = info()
    if (state.view === "sessionBreakdown") return value?.sessionUsage !== undefined
    if (state.view === "skillBreakdown") return value?.skills !== undefined
    return true
  }
  const shareColumn = (): Column => (additive.has(state.sort.column) ? state.sort.column : columns[state.view][0])
  const shareTotal = () => rows().reduce((sum, row) => sum + (row.values[shareColumn()] ?? 0), 0)
  const visible = createMemo(() => {
    const query = state.query.trim().toLocaleLowerCase()
    const direction = state.sort.descending ? -1 : 1
    return rows()
      .filter((row) => !query || `${row.name} ${row.detail ?? ""}`.toLocaleLowerCase().includes(query))
      .toSorted(
        (a, b) =>
          direction * ((a.values[state.sort.column] ?? -1) - (b.values[state.sort.column] ?? -1)) ||
          a.name.localeCompare(b.name),
      )
  })
  const activity = createMemo(() => {
    const end = new Date(info()?.range.to ?? Date.now())
    end.setHours(0, 0, 0, 0)
    return Array.from({ length: state.days }, (_, index) => {
      const day = new Date(end)
      day.setDate(day.getDate() - state.days + index + 1)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
      const row = info()?.activity.find((item) => item.date === key)
      const tokens = row?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
      return {
        label: new Intl.DateTimeFormat(language.intl(), { month: "short", day: "numeric", weekday: "short" }).format(
          day,
        ),
        steps: row?.steps ?? 0,
        tokens,
        total: TokenUsage.total(tokens),
        cost: row?.cost ?? 0,
      }
    })
  })
  // Servers before daily token and cost totals only report steps per day.
  const daily = () => info()?.activity.every((row) => row.tokens !== undefined && row.cost !== undefined) ?? false
  const metric = () => (daily() ? state.metric : "steps")
  const dayValue = (day: ReturnType<typeof activity>[number]) =>
    metric() === "steps" ? day.steps : metric() === "tokens" ? day.total : day.cost
  const dayText = (day: ReturnType<typeof activity>[number]) =>
    metric() === "cost" ? format.money(day.cost) : number(dayValue(day))
  const maximum = () => Math.max(...activity().map(dayValue))
  const peak = () => activity().find((day) => dayValue(day) === maximum() && maximum() > 0)
  const refresh = () => {
    void actions.refetch()
    if (state.provider) void filteredActions.refetch()
  }
  const sortBy = (column: Column) =>
    setState("sort", (sort) => ({
      column,
      descending: sort.column === column ? !sort.descending : column !== "successRate" && column !== "duration",
    }))
  const showView = (view: View) =>
    setState({
      view,
      limit: pageSize,
      query: "",
      sort: { column: view === "toolBreakdown" || view === "skillBreakdown" ? "calls" : "cost", descending: true },
    })
  const insights = () => {
    const value = info()
    if (!value) return []
    const tokens = value.tokens
    const prompt = tokens.input + tokens.cache.read + tokens.cache.write
    const tools = toolTotals()
    return [
      [language.t("settings.usage.cacheRate"), prompt ? percent(tokens.cache.read / prompt) : "-"],
      [language.t("settings.usage.costPerRequest"), value.steps ? smallMoney(value.cost / value.steps) : "-"],
      [language.t("settings.usage.costPerDay"), format.money(value.cost / state.days)],
      [language.t("settings.usage.prompts"), number(value.prompts)],
      [
        language.t("settings.usage.activeDays"),
        language.t("settings.usage.activeDaysValue", {
          active: number(value.activeDays),
          days: number(state.days),
          streak: number(value.streak),
        }),
      ],
      [language.t("settings.usage.toolSuccess"), tools?.calls ? percent(tools.succeeded / tools.calls) : "-"],
    ] as const
  }

  function Section(section: { title: string; children: JSX.Element; note?: string; action?: JSX.Element }) {
    return (
      <section class="settings-section usage-section" aria-label={section.title}>
        <div class="usage-section-header">
          <h3 class="settings-section-title">{section.title}</h3>
          {section.action}
        </div>
        <Show when={section.note}>
          <p class="usage-note">{section.note}</p>
        </Show>
        {section.children}
      </section>
    )
  }

  function Table() {
    const label = () => language.t(`settings.usage.${state.view}`)
    return (
      <>
        <div class="usage-table-wrap" data-scrollable>
          <table class="usage-table" aria-label={label()}>
            <thead>
              <tr>
                <th scope="col">{language.t("settings.usage.name")}</th>
                <For each={columns[state.view]}>
                  {(column) => (
                    <th
                      scope="col"
                      aria-sort={
                        state.sort.column === column ? (state.sort.descending ? "descending" : "ascending") : undefined
                      }
                    >
                      <button type="button" class="usage-sort" onClick={() => sortBy(column)}>
                        {language.t(`settings.usage.${column}`)}
                        <span aria-hidden="true">
                          {state.sort.column === column ? (state.sort.descending ? "↓" : "↑") : ""}
                        </span>
                      </button>
                    </th>
                  )}
                </For>
                <th scope="col">
                  {language.t("settings.usage.share", { column: language.t(`settings.usage.${shareColumn()}`) })}
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={visible().slice(0, state.limit)}>
                {(row) => {
                  const share = () => (shareTotal() ? (row.values[shareColumn()] ?? 0) / shareTotal() : 0)
                  return (
                    <tr>
                      <th scope="row">
                        <Show when={row.filter} fallback={<bdi>{row.name}</bdi>}>
                          {(filter) => (
                            <button
                              type="button"
                              class="usage-drill"
                              title={language.t("settings.usage.drill")}
                              onClick={() => setState({ ...filter(), limit: pageSize, query: "" })}
                            >
                              <bdi>{row.name}</bdi>
                            </button>
                          )}
                        </Show>
                        <Show when={row.detail}>
                          <small>
                            <bdi>{row.detail}</bdi>
                          </small>
                        </Show>
                      </th>
                      <For each={columns[state.view]}>
                        {(column) => (
                          <td>{row.values[column] === undefined ? "" : cell(column, row.values[column])}</td>
                        )}
                      </For>
                      <td>
                        <span class="usage-share">
                          <span class="usage-share-bar" aria-hidden="true">
                            <span style={{ width: `${share() * 100}%` }} />
                          </span>
                          {percent(share())}
                        </span>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </div>
        <Show when={!visible().length}>
          <p class="usage-note">
            {language.t(
              !available()
                ? "settings.usage.detailUnavailable"
                : state.query
                  ? "settings.usage.noMatches"
                  : "settings.usage.empty",
            )}
          </p>
        </Show>
        <Show when={visible().length > state.limit}>
          <Button variant="ghost" onClick={() => setState("limit", (count) => count + pageSize)}>
            {language.t("settings.usage.more")}
          </Button>
        </Show>
      </>
    )
  }

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex min-w-0 flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.usage.title")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.usage.description")}</span>
          </div>
          <div class="settings-tab-header-actions">{props.headerAction}</div>
        </div>
      </div>
      <div class="settings-tab-body settings-tab-body--sectioned settings-usage">
        <div class="usage-controls">
          <div role="group" aria-label={language.t("settings.usage.period")}>
            <For each={periods}>
              {(period) => (
                <Button
                  variant={state.days === period.days ? "neutral" : "ghost"}
                  aria-pressed={state.days === period.days}
                  onClick={() => setState({ days: period.days, limit: pageSize })}
                >
                  {language.t(`settings.usage.${period.key}`)}
                </Button>
              )}
            </For>
          </div>
          <Button variant="ghost" disabled={loading()} onClick={refresh}>
            {language.t("settings.usage.refresh")}
          </Button>
        </div>
        <div class="usage-filters">
          <label>
            <span>{language.t("settings.usage.provider")}</span>
            <Select
              aria-label={language.t("settings.usage.provider")}
              placeholder={language.t("settings.usage.allProviders")}
              appearance="base"
              options={providers()}
              current={state.provider}
              label={(value) => value || language.t("settings.usage.allProviders")}
              onSelect={(value) => value !== null && setState({ provider: value, model: "", limit: pageSize })}
            />
          </label>
          <label>
            <span>{language.t("settings.usage.model")}</span>
            <Select
              aria-label={language.t("settings.usage.model")}
              placeholder={language.t("settings.usage.allModels")}
              appearance="base"
              disabled={!state.provider}
              options={models()}
              current={state.model}
              label={(value) => value || language.t("settings.usage.allModels")}
              onSelect={(value) => value !== null && setState({ model: value, limit: pageSize })}
            />
          </label>
        </div>
        <Show when={loading() && !info()}>
          <div role="status">
            <Loader />
          </div>
        </Show>
        <Show when={error()}>
          <div role="alert" class="usage-controls">
            <span>{language.t("settings.usage.error")}</span>
            <Button onClick={refresh}>{language.t("usage.retry")}</Button>
          </div>
        </Show>
        <Show when={info()}>
          {(value) => (
            <>
              <div class="usage-summary">
                <For
                  each={[
                    [language.t("settings.usage.steps"), number(value().steps)],
                    [language.t("settings.usage.sessions"), number(value().sessions + value().subagents)],
                    [language.t("settings.usage.tokens"), number(TokenUsage.total(value().tokens))],
                    [language.t("settings.usage.cost"), format.money(value().cost)],
                    [language.t("settings.usage.tools"), number(toolTotals()?.calls ?? 0)],
                    [language.t("settings.usage.skills"), number(skillCalls())],
                  ]}
                >
                  {([label, count]) => (
                    <div class="usage-card">
                      <span class="usage-note">{label}</span>
                      <strong class="usage-total">{count}</strong>
                    </div>
                  )}
                </For>
              </div>
              <dl class="usage-insights" aria-label={language.t("settings.usage.insights")}>
                <For each={insights()}>
                  {([label, text]) => (
                    <div>
                      <dt>{label}</dt>
                      <dd>{text}</dd>
                    </div>
                  )}
                </For>
              </dl>
              <details class="usage-about">
                <summary>{language.t("settings.usage.about")}</summary>
                <p class="usage-note">
                  {language.t(state.provider ? "settings.usage.filteredNote" : "settings.usage.note")}
                </p>
              </details>
              <Section title={language.t("settings.usage.tokens")}>
                <div class="usage-card">
                  <div class="usage-token-stack" role="img" aria-label={language.t("settings.usage.tokenBreakdown")}>
                    <For each={tokenKeys}>
                      {(key) => (
                        <span
                          data-token={key}
                          style={{
                            width: `${(tokenValues(value())[key] / Math.max(1, TokenUsage.total(value().tokens))) * 100}%`,
                          }}
                        />
                      )}
                    </For>
                  </div>
                  <div class="usage-token-legend">
                    <For each={tokenKeys}>
                      {(key) => (
                        <span>
                          <i data-token={key} aria-hidden="true" />
                          {language.t(`settings.usage.${key}`)} <strong>{number(tokenValues(value())[key])}</strong>
                          <small class="usage-note">
                            {percent(tokenValues(value())[key] / Math.max(1, TokenUsage.total(value().tokens)))}
                          </small>
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </Section>
              <Show when={state.days > 1}>
                <Section
                  title={language.t(`settings.usage.daily.${metric()}`)}
                  action={
                    <Show when={daily()}>
                      <div role="group" aria-label={language.t("settings.usage.chartMetric")}>
                        <For each={metrics}>
                          {(item) => (
                            <Button
                              size="small"
                              variant={metric() === item ? "neutral" : "ghost"}
                              aria-pressed={metric() === item}
                              onClick={() => setState("metric", item)}
                            >
                              {language.t(`settings.usage.metric.${item}`)}
                            </Button>
                          )}
                        </For>
                      </div>
                    </Show>
                  }
                >
                  <div class="usage-card">
                    <Show when={peak()}>
                      {(day) => (
                        <span class="usage-note">
                          {language.t("settings.usage.peak", { day: day().label, value: dayText(day()) })}
                        </span>
                      )}
                    </Show>
                    <div
                      class="usage-chart"
                      role="img"
                      aria-label={language.t(`settings.usage.daily.${metric()}`)}
                      dir="ltr"
                    >
                      <For each={activity()}>
                        {(day) => (
                          <div
                            class="usage-day"
                            title={
                              daily()
                                ? language.t("settings.usage.dayDetail", {
                                    day: day.label,
                                    steps: number(day.steps),
                                    tokens: number(day.total),
                                    cost: format.money(day.cost),
                                  })
                                : language.t("settings.usage.daySteps", { day: day.label, steps: number(day.steps) })
                            }
                          >
                            <div
                              class="usage-bar"
                              data-metric={metric()}
                              style={{ height: `${maximum() ? (dayValue(day) / maximum()) * 100 : 0}%` }}
                            >
                              <Show when={metric() === "tokens"}>
                                <For each={tokenKeys.toReversed()}>
                                  {(key) => (
                                    <span
                                      data-token={key}
                                      style={{
                                        height: `${day.total ? (tokenValues(day)[key] / day.total) * 100 : 0}%`,
                                      }}
                                    />
                                  )}
                                </For>
                              </Show>
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                    <div class="usage-controls" dir="ltr">
                      <span>{activity()[0]?.label}</span>
                      <span>{activity().at(-1)?.label}</span>
                    </div>
                    <details>
                      <summary>{language.t("settings.usage.dailyTable")}</summary>
                      <dl class="usage-days">
                        <For each={activity()}>
                          {(day) => (
                            <div>
                              <dt>{day.label}</dt>
                              <dd>{dayText(day)}</dd>
                            </div>
                          )}
                        </For>
                      </dl>
                    </details>
                  </div>
                </Section>
              </Show>
              <section class="settings-section usage-section" aria-label={language.t("settings.usage.breakdown")}>
                <div class="usage-section-header">
                  <h3 class="settings-section-title">{language.t("settings.usage.breakdown")}</h3>
                  <div class="usage-search">
                    <TextField
                      type="search"
                      label={language.t("settings.usage.search")}
                      hideLabel
                      placeholder={language.t("settings.usage.search")}
                      value={state.query}
                      onChange={(query) => setState({ query, limit: pageSize })}
                    />
                  </div>
                </div>
                <Tabs
                  variant="pill"
                  value={state.view}
                  onChange={(value) => {
                    const view = views.find((item) => item === value)
                    if (view) showView(view)
                  }}
                  class="settings-subtabs"
                >
                  <Tabs.List>
                    <For each={views}>
                      {(view) => <Tabs.Trigger value={view}>{language.t(`settings.usage.${view}`)}</Tabs.Trigger>}
                    </For>
                  </Tabs.List>
                </Tabs>
                <Show when={state.view === "skillBreakdown"}>
                  <p class="usage-note">{language.t("settings.usage.skillNote")}</p>
                </Show>
                <Show when={state.view === "providers" || state.view === "models"}>
                  <p class="usage-note">
                    {language.t(state.model ? "settings.usage.drillDone" : "settings.usage.drillHint")}
                  </p>
                </Show>
                <Table />
              </section>
            </>
          )}
        </Show>
      </div>
    </>
  )
}
