import { createEffect, createMemo, createResource, createUniqueId, For, on, onCleanup, Show } from "solid-js"
import { createStore } from "solid-js/store"
import type { SessionInfo } from "@opencode/client/promise"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Button } from "@opencode/ui/button"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import type { SessionModel } from "./model"
import { useOpenSessionRoute } from "./session-identity-header"

/** Persistent tasks remain ordinary interactive sessions; this tree never includes subagents. */
export function TaskTreePanel(props: { session: SessionModel }) {
  const language = useLanguage()
  const server = useServer()
  const openSession = useOpenSessionRoute()
  const treeID = createUniqueId()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const id = () => props.session.identity.sessionID()
  const [state, setState] = createStore({
    open: !!props.session.data.info()?.experimental?.taskParentID,
    collapsed: {} as Record<string, boolean>,
    focus: "",
    creating: false,
    title: "",
    prompt: "",
    createID: "",
    promptID: "",
    target: "",
    text: "",
    sendID: "",
    busy: false,
    notice: "",
  })
  createEffect(
    on(
      () => props.session.data.info()?.experimental?.taskParentID,
      (parent) => {
        if (parent) setState("open", true)
      },
    ),
  )
  const [tree, controls] = createResource(
    () => (state.open ? id() : undefined),
    async (sessionID) => ({
      sessionID,
      tasks: await server.ctx.sdk.api.experimental.session.tasks.tree({ sessionID }),
    }),
  )
  const [mail, mailbox] = createResource(
    () => (state.open ? id() : undefined),
    async (sessionID) => ({
      sessionID,
      messages: await server.ctx.sdk.api.experimental.session.tasks.messages({ sessionID }),
    }),
  )
  const correspondence = createMemo(() => {
    if (mail.state !== "ready" && mail.state !== "refreshing") return []
    return mail.latest?.sessionID === id() ? mail.latest.messages : []
  })
  // Never enter Suspense or reuse a previous session's result during a tab/route change.
  const tasks = createMemo(() => {
    if (tree.state !== "ready" && tree.state !== "refreshing") return []
    const loaded = tree.latest
    if (loaded?.sessionID !== id()) return []
    return loaded.tasks.map((task) => server.ctx.data.session.get(task.id) ?? task)
  })
  const rows = createMemo(() => {
    const children = Map.groupBy(tasks(), (task) => task.experimental?.taskParentID)
    const known = new Set(tasks().map((task) => task.id))
    const walk = (
      items: SessionInfo[],
      depth: number,
    ): Array<{ task: SessionInfo; depth: number; children: boolean }> =>
      items.flatMap((task) => {
        const nested = children.get(task.id) ?? []
        return [
          { task, depth, children: nested.length > 0 },
          ...(state.collapsed[task.id] ? [] : walk(nested, depth + 1)),
        ]
      })
    return walk(
      tasks().filter((task) => !task.experimental?.taskParentID || !known.has(task.experimental.taskParentID)),
      1,
    )
  })
  const relatives = createMemo(() =>
    tasks().filter(
      (task) =>
        task.id === props.session.data.info()?.experimental?.taskParentID || task.experimental?.taskParentID === id(),
    ),
  )
  const status = (task: SessionInfo) => {
    if (task.time.archived) return language.t("tasks.archived")
    if (server.ctx.data.session.status(task.id) === "running") return language.t("tasks.running")
    if (task.outcome === "failed") return language.t("tasks.failed")
    if (task.outcome === "interrupted") return language.t("tasks.interrupted")
    return language.t("tasks.idle")
  }
  createEffect(() => {
    const current = id()
    if (!current) return
    setState({
      focus: current,
      creating: false,
      title: "",
      prompt: "",
      createID: "",
      promptID: "",
      target: "",
      text: "",
      sendID: "",
      notice: "",
    })
  })
  onCleanup(
    server.ctx.sdk.event.listen((event) => {
      if (state.open && (event.type === "session.created" || event.type === "session.deleted")) void controls.refetch()
      if (
        state.open &&
        (event.type === "session.inbox.enqueued" || event.type === "session.inbox.delivered") &&
        tasks().some((task) => task.id === event.data.sessionID)
      )
        void mailbox.refetch()
    }),
  )

  const create = async () => {
    const parent = id()
    if (!parent || state.busy || !state.title.trim() || !state.prompt.trim()) return
    const childID = state.createID || Session.ID.create()
    const promptID = state.promptID || SessionMessage.ID.create()
    const prompt = state.prompt
    setState({ busy: true, createID: childID, promptID, notice: "" })
    try {
      const task = await server.ctx.sdk.api.experimental.session.tasks.create({
        sessionID: parent,
        id: childID,
        title: state.title,
      })
      await server.ctx.sdk.api.session.prompt({ sessionID: task.id, id: promptID, text: prompt })
      if (disposed || id() !== parent) return
      await controls.refetch()
      setState({
        creating: false,
        title: "",
        prompt: "",
        createID: "",
        promptID: "",
        notice: language.t("tasks.created"),
      })
      await server.ctx.data.session.sync(task.id)
      if (disposed || id() !== parent) return
      openSession(parent, task.id)
    } catch {
      if (!disposed && id() === parent) setState("notice", language.t("tasks.createFailed", { id: childID }))
    } finally {
      setState("busy", false)
    }
  }
  const send = async () => {
    const source = id()
    const target = state.target || relatives()[0]?.id
    if (!source || !target || state.busy || !state.text.trim()) return
    const messageID = state.sendID || SessionMessage.ID.create()
    setState({ busy: true, sendID: messageID, notice: "" })
    try {
      await server.ctx.sdk.api.experimental.session.tasks.send({
        sessionID: source,
        targetID: target,
        id: messageID,
        text: state.text,
      })
      await mailbox.refetch()
      if (disposed || id() !== source) return
      setState({ text: "", sendID: "", notice: language.t("tasks.sent") })
    } catch {
      if (!disposed && id() === source) setState("notice", language.t("tasks.actionError"))
    } finally {
      setState("busy", false)
    }
  }
  const focus = (target?: string) => {
    if (!target) return
    setState("focus", target)
    document.getElementById(`${treeID}-${target}`)?.focus()
  }
  const field = "w-full rounded-md border border-border-base bg-background-base px-2 py-1 text-13 text-text-base"

  return (
    <aside
      aria-label={language.t("tasks.tree")}
      class="shrink-0 rounded-lg border border-border-base bg-background-base flex flex-col min-h-0"
      style={{ width: state.open ? "260px" : "auto" }}
    >
      <Button
        variant="ghost"
        aria-label={language.t("tasks.toggle")}
        aria-expanded={state.open}
        onClick={() => setState("open", !state.open)}
      >
        {language.t("tasks.tree")}
      </Button>
      <Show when={state.open}>
        <div data-scrollable class="min-h-0 overflow-y-auto p-2 flex flex-col gap-3">
          <Show when={tree.loading && tasks().length === 0}>
            <p>{language.t("tasks.loading")}</p>
          </Show>
          <Show when={tree.error}>
            <p role="alert">{language.t("tasks.error")}</p>
          </Show>
          <Show when={mail.error}>
            <p role="alert">{language.t("tasks.mailError")}</p>
          </Show>
          <Button
            variant="ghost"
            onClick={() => {
              void controls.refetch()
              void mailbox.refetch()
            }}
          >
            {language.t("tasks.refresh")}
          </Button>
          <div role="tree" aria-label={language.t("tasks.tree")}>
            <For each={rows()}>
              {(row) => (
                <div
                  id={`${treeID}-${row.task.id}`}
                  role="treeitem"
                  aria-level={row.depth}
                  aria-selected={row.task.id === id()}
                  aria-expanded={row.children ? !state.collapsed[row.task.id] : undefined}
                  tabIndex={
                    state.focus === row.task.id ||
                    (!rows().some((item) => item.task.id === state.focus) && row.depth === 1)
                      ? 0
                      : -1
                  }
                  class="flex items-center rounded-md gap-1 min-h-8 text-13 hover:bg-background-strong focus-visible:outline"
                  classList={{ "bg-background-strong": row.task.id === id() }}
                  style={{ "padding-inline-start": `${(row.depth - 1) * 16}px` }}
                  onFocus={() => setState("focus", row.task.id)}
                  onKeyDown={(event) => {
                    const rtl = getComputedStyle(event.currentTarget).direction === "rtl"
                    const index = rows().findIndex((item) => item.task.id === row.task.id)
                    if (event.key === "ArrowDown") focus(rows()[index + 1]?.task.id)
                    else if (event.key === "ArrowUp") focus(rows()[index - 1]?.task.id)
                    else if (event.key === "Home") focus(rows()[0]?.task.id)
                    else if (event.key === "End") focus(rows().at(-1)?.task.id)
                    else if (event.key === (rtl ? "ArrowRight" : "ArrowLeft")) {
                      if (row.children && !state.collapsed[row.task.id]) setState("collapsed", row.task.id, true)
                      else focus(row.task.experimental?.taskParentID)
                    } else if (event.key === (rtl ? "ArrowLeft" : "ArrowRight")) {
                      if (row.children && state.collapsed[row.task.id]) setState("collapsed", row.task.id, false)
                      else if (row.children) focus(rows()[index + 1]?.task.id)
                    } else if (event.key === "Enter") openSession(id() ?? "", row.task.id)
                    else return
                    event.preventDefault()
                  }}
                >
                  <button
                    tabIndex={-1}
                    disabled={!row.children}
                    class="w-5 shrink-0"
                    aria-label={language.t(state.collapsed[row.task.id] ? "tasks.expand" : "tasks.collapse", {
                      title: row.task.title ?? language.t("tasks.untitled"),
                    })}
                    onClick={() => setState("collapsed", row.task.id, !state.collapsed[row.task.id])}
                  >
                    <span class="inline-block rtl:-scale-x-100">
                      {row.children ? (state.collapsed[row.task.id] ? "▸" : "▾") : "·"}
                    </span>
                  </button>
                  <button
                    tabIndex={-1}
                    class="min-w-0 flex-1 text-start py-1"
                    onClick={() => openSession(id() ?? "", row.task.id)}
                  >
                    <span dir="auto" class="block truncate">
                      {row.task.title ?? language.t("tasks.untitled")}
                    </span>
                    <span class="block text-11 text-text-weak">{status(row.task)}</span>
                  </button>
                </div>
              )}
            </For>
          </div>
          <Button variant="outline" disabled={state.busy} onClick={() => setState("creating", !state.creating)}>
            {language.t("tasks.new")}
          </Button>
          <Show when={state.creating}>
            <form
              class="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <label>
                {language.t("tasks.title")}
                <input
                  class={field}
                  value={state.title}
                  required
                  disabled={state.busy}
                  onInput={(event) => setState("title", event.currentTarget.value)}
                />
              </label>
              <label>
                {language.t("tasks.prompt")}
                <textarea
                  class={field}
                  rows={4}
                  value={state.prompt}
                  required
                  disabled={state.busy}
                  onInput={(event) => setState("prompt", event.currentTarget.value)}
                />
              </label>
              <Button type="submit" disabled={state.busy}>
                {language.t("tasks.create")}
              </Button>
              <Show when={state.createID}>
                <Button variant="ghost" type="button" onClick={() => openSession(id() ?? "", state.createID)}>
                  {language.t("tasks.openCreated")}
                </Button>
              </Show>
            </form>
          </Show>
          <Show when={relatives().length > 0}>
            <form
              class="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                void send()
              }}
            >
              <p class="text-12 text-text-weak">{language.t("tasks.correspondenceHint")}</p>
              <label>
                {language.t("tasks.recipient")}
                <select
                  class={field}
                  value={state.target || relatives()[0]?.id}
                  disabled={state.busy}
                  onChange={(event) => setState({ target: event.currentTarget.value, sendID: "" })}
                >
                  <For each={relatives()}>
                    {(task) => <option value={task.id}>{task.title ?? language.t("tasks.untitled")}</option>}
                  </For>
                </select>
              </label>
              <label>
                {language.t("tasks.message")}
                <textarea
                  class={field}
                  rows={4}
                  value={state.text}
                  required
                  disabled={state.busy}
                  onInput={(event) => setState({ text: event.currentTarget.value, sendID: "" })}
                />
              </label>
              <Button type="submit" disabled={state.busy}>
                {language.t("tasks.send")}
              </Button>
            </form>
          </Show>
          <Show when={correspondence().length > 0}>
            <section aria-label={language.t("tasks.correspondence")} class="flex flex-col gap-2">
              <h3 class="text-13 font-medium">{language.t("tasks.correspondence")}</h3>
              <For each={correspondence()}>
                {(message) => (
                  <div class="border border-border-base rounded-md p-2 text-12">
                    <p class="text-text-weak">
                      {language.t(message.from === id() ? "tasks.to" : "tasks.from", {
                        title:
                          tasks().find((task) => task.id === (message.from === id() ? message.to : message.from))
                            ?.title ?? (message.from === id() ? message.to : message.from),
                      })}
                    </p>
                    <p dir="auto" class="whitespace-pre-wrap break-words">
                      {message.text}
                    </p>
                    <span class="text-text-weak">
                      {language.t(message.state === "pending" ? "tasks.pending" : "tasks.delivered")}
                    </span>
                  </div>
                )}
              </For>
            </section>
          </Show>
          <Show when={state.notice}>
            <p role="status" class="text-12 text-text-weak whitespace-pre-wrap">
              {state.notice}
            </p>
          </Show>
        </div>
      </Show>
    </aside>
  )
}
