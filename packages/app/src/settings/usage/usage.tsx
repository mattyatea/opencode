import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { createMemo, createResource, For, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useUsageFormat } from "@/usage/format"
import { TokenUsage } from "@opencode/schema/token-usage"
import { Provider } from "@opencode/schema/provider"
import { Model } from "@opencode/schema/model"
import "./usage.css"

export function SettingsUsage(props: { active: boolean; headerAction?: JSX.Element }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const format = useUsageFormat()
  const [state, setState] = createStore({ days: 7, sessions: 10, provider: "", model: "" })
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
  const breakdowns = createMemo(() => {
    const rows = info()?.models ?? []
    return [
      {
        key: "providers" as const,
        rows: Array.from(
          Map.groupBy(rows, (row) => row.model.providerID),
          ([name, models]) => ({
            name,
            provider: "",
            steps: models.reduce((sum, row) => sum + row.steps, 0),
            cost: models.reduce((sum, row) => sum + row.cost, 0),
            tokens: {
              input: models.reduce((sum, row) => sum + row.tokens.input, 0),
              output: models.reduce((sum, row) => sum + row.tokens.output, 0),
              reasoning: models.reduce((sum, row) => sum + row.tokens.reasoning, 0),
              cache: {
                read: models.reduce((sum, row) => sum + row.tokens.cache.read, 0),
                write: models.reduce((sum, row) => sum + row.tokens.cache.write, 0),
              },
            },
          }),
        ).sort((a, b) => b.steps - a.steps),
      },
      {
        key: "models" as const,
        rows: rows.map((row) => ({
          ...row,
          name: `${row.model.id}${row.model.variant ? ` #${row.model.variant}` : ""}`,
          provider: row.model.providerID,
        })),
      },
    ]
  })
  const loading = () => (state.provider ? filtered.loading : stats.loading)
  const error = () => (state.provider ? filtered.error : stats.error)
  const number = (value: number) => new Intl.NumberFormat(language.intl()).format(value)
  const toolUsage = () => {
    const tools = info()?.tools
    return tools?.mode === "detail" ? tools.usage : []
  }
  const toolCalls = () => {
    const tools = info()?.tools
    return tools && tools.mode !== "none" ? tools.totals.calls : 0
  }
  const skillCalls = () => toolUsage().find((tool) => tool.name === "skill")?.calls ?? 0
  const activity = createMemo(() => {
    const end = new Date(info()?.range.to ?? Date.now())
    end.setHours(0, 0, 0, 0)
    return Array.from({ length: state.days }, (_, index) => {
      const day = new Date(end)
      day.setDate(day.getDate() - state.days + index + 1)
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`
      return {
        label: new Intl.DateTimeFormat(language.intl(), { month: "short", day: "numeric" }).format(day),
        steps: info()?.activity.find((row) => row.date === key)?.steps ?? 0,
      }
    })
  })
  const maximum = () => Math.max(1, ...activity().map((day) => day.steps))
  const refresh = () => {
    void actions.refetch()
    if (state.provider) void filteredActions.refetch()
  }
  const tokenRows = (tokens: TokenUsage.Info) =>
    [
      { key: "input", count: tokens.input },
      { key: "output", count: tokens.output },
      { key: "reasoning", count: tokens.reasoning },
      { key: "cacheRead", count: tokens.cache.read },
      { key: "cacheWrite", count: tokens.cache.write },
    ] as const

  function Section(section: { title: string; children: JSX.Element; note?: string }) {
    return (
      <section class="settings-section usage-section" aria-label={section.title}>
        <h3 class="settings-section-title">{section.title}</h3>
        <Show when={section.note}>
          <p class="usage-note">{section.note}</p>
        </Show>
        {section.children}
      </section>
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
          <div role="group" aria-label={language.t("settings.usage.title")}>
            <For each={[7, 30]}>
              {(days) => (
                <Button
                  variant={state.days === days ? "neutral" : "ghost"}
                  aria-pressed={state.days === days}
                  onClick={() => setState({ days, sessions: 10 })}
                >
                  {language.t(days === 7 ? "settings.usage.sevenDays" : "settings.usage.thirtyDays")}
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
              onSelect={(value) => value !== null && setState({ provider: value, model: "", sessions: 10 })}
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
              onSelect={(value) => value !== null && setState({ model: value, sessions: 10 })}
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
                    [language.t("settings.usage.tools"), number(toolCalls())],
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
              <p class="usage-note">
                {language.t(state.provider ? "settings.usage.filteredNote" : "settings.usage.note")}
              </p>
              <Section title={language.t("settings.usage.tokens")}>
                <div class="usage-card">
                  <div class="usage-token-stack" role="img" aria-label={language.t("settings.usage.tokenBreakdown")}>
                    <For each={tokenRows(value().tokens)}>
                      {(row) => (
                        <span
                          data-token={row.key}
                          style={{ width: `${(row.count / Math.max(1, TokenUsage.total(value().tokens))) * 100}%` }}
                        />
                      )}
                    </For>
                  </div>
                  <div class="usage-token-legend">
                    <For each={tokenRows(value().tokens)}>
                      {(row) => (
                        <span>
                          <i data-token={row.key} aria-hidden="true" />
                          {language.t(`settings.usage.${row.key}`)} <strong>{number(row.count)}</strong>
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </Section>
              <Section title={language.t("settings.usage.activity")}>
                <div class="usage-card">
                  <div class="usage-chart" role="img" aria-label={language.t("settings.usage.activity")} dir="ltr">
                    <For each={activity()}>
                      {(day) => (
                        <div class="usage-day" title={`${day.label}: ${number(day.steps)}`}>
                          <div class="usage-bar" style={{ height: `${(day.steps / maximum()) * 100}%` }} />
                        </div>
                      )}
                    </For>
                  </div>
                  <div class="usage-controls" dir="ltr">
                    <span>{activity()[0]?.label}</span>
                    <span>{activity().at(-1)?.label}</span>
                  </div>
                  <details>
                    <summary>{language.t("settings.usage.activity")}</summary>
                    <dl class="usage-days">
                      <For each={activity()}>
                        {(day) => (
                          <div>
                            <dt>{day.label}</dt>
                            <dd>{number(day.steps)}</dd>
                          </div>
                        )}
                      </For>
                    </dl>
                  </details>
                </div>
              </Section>
              <For each={breakdowns()}>
                {(breakdown) => (
                  <Section title={language.t(`settings.usage.${breakdown.key}`)}>
                    <div class="usage-table-wrap" data-scrollable>
                      <table class="usage-table" aria-label={language.t(`settings.usage.${breakdown.key}`)}>
                        <thead>
                          <tr>
                            <For
                              each={
                                [
                                  "name",
                                  "steps",
                                  "input",
                                  "output",
                                  "reasoning",
                                  "cacheRead",
                                  "cacheWrite",
                                  "cost",
                                ] as const
                              }
                            >
                              {(key) => <th>{language.t(`settings.usage.${key}`)}</th>}
                            </For>
                          </tr>
                        </thead>
                        <tbody>
                          <For each={breakdown.rows}>
                            {(row) => (
                              <tr>
                                <th>
                                  <bdi>{row.name}</bdi>
                                  <Show when={row.provider}>
                                    <small>
                                      <bdi>{row.provider}</bdi>
                                    </small>
                                  </Show>
                                </th>
                                <For
                                  each={[
                                    row.steps,
                                    row.tokens.input,
                                    row.tokens.output,
                                    row.tokens.reasoning,
                                    row.tokens.cache.read,
                                    row.tokens.cache.write,
                                  ]}
                                >
                                  {(count) => <td>{number(count)}</td>}
                                </For>
                                <td>{format.money(row.cost)}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                    <Show when={!breakdown.rows.length}>
                      <p class="usage-note">{language.t("settings.usage.empty")}</p>
                    </Show>
                  </Section>
                )}
              </For>
              <Section title={language.t("settings.usage.sessionBreakdown")}>
                <div class="usage-table-wrap" data-scrollable>
                  <table class="usage-table" aria-label={language.t("settings.usage.sessionBreakdown")}>
                    <thead>
                      <tr>
                        <For each={["name", "steps", "tokens", "cost"] as const}>
                          {(key) => <th>{language.t(`settings.usage.${key}`)}</th>}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={value().sessionUsage?.slice(0, state.sessions)}>
                        {(row) => (
                          <tr>
                            <th>
                              <bdi>{row.title || row.sessionID}</bdi>
                              <Show when={row.parentID}>
                                <small>{language.t("settings.usage.child")}</small>
                              </Show>
                            </th>
                            <td>{number(row.steps)}</td>
                            <td>{number(TokenUsage.total(row.tokens))}</td>
                            <td>{format.money(row.cost)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <Show when={!value().sessionUsage?.length}>
                  <p class="usage-note">
                    {language.t(value().sessionUsage ? "settings.usage.empty" : "settings.usage.detailUnavailable")}
                  </p>
                </Show>
                <Show when={(value().sessionUsage?.length ?? 0) > state.sessions}>
                  <Button variant="ghost" onClick={() => setState("sessions", (count) => count + 10)}>
                    {language.t("settings.usage.more")}
                  </Button>
                </Show>
              </Section>
              <Section
                title={language.t("settings.usage.skillBreakdown")}
                note={language.t("settings.usage.skillNote")}
              >
                <div class="usage-table-wrap" data-scrollable>
                  <table class="usage-table" aria-label={language.t("settings.usage.skillBreakdown")}>
                    <thead>
                      <tr>
                        <th>{language.t("settings.usage.name")}</th>
                        <th>{language.t("settings.usage.calls")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={value().skills}>
                        {(row) => (
                          <tr>
                            <th>
                              <bdi>{row.id}</bdi>
                            </th>
                            <td>{number(row.calls)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <Show when={!value().skills?.length}>
                  <p class="usage-note">
                    {language.t(value().skills ? "settings.usage.empty" : "settings.usage.detailUnavailable")}
                  </p>
                </Show>
              </Section>
              <Section title={language.t("settings.usage.toolBreakdown")}>
                <div class="usage-table-wrap" data-scrollable>
                  <table class="usage-table" aria-label={language.t("settings.usage.toolBreakdown")}>
                    <thead>
                      <tr>
                        <For each={["name", "calls", "failed", "unfinished"] as const}>
                          {(key) => <th>{language.t(`settings.usage.${key}`)}</th>}
                        </For>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={toolUsage()}>
                        {(row) => (
                          <tr>
                            <th>
                              <bdi>{row.name}</bdi>
                            </th>
                            <td>{number(row.calls)}</td>
                            <td>{number(row.failed)}</td>
                            <td>{number(row.unfinished)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <Show when={!toolUsage().length}>
                  <p class="usage-note">{language.t("settings.usage.empty")}</p>
                </Show>
              </Section>
            </>
          )}
        </Show>
      </div>
    </>
  )
}
