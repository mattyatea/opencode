import { createMemo, createResource, For, onCleanup, Show, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueries, useQueryClient } from "@tanstack/solid-query"
import type { SessionInfo } from "@opencode/client/promise"
import { writeClipboard } from "@opencode/ui/clipboard"
import { Button } from "@opencode/ui/button"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Loader } from "@opencode/ui/loader"
import { Menu } from "@opencode/ui/menu"
import { displayName } from "@opencode/ui/project-avatar"
import { TextInput } from "@opencode/ui/text-input"
import { uuid } from "@opencode/util/uuid"
import { homeSessionsQuery } from "@/home/sessions/queries"
import { mergeHomeSessionIndex } from "@/home/sessions/index"
import { useLanguage } from "@/runtime/i18n/language"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { useLayout } from "@/shell/state/layout"
import { type DraftTab, tabKey, useTabs } from "@/shell/tabs/tabs"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { ActivityRing } from "@opencode/ui/activity-ring"
import { sessionTitle } from "@/session/title"
import { sessionTreeIDs } from "@/session/requests/session-request-tree"
import { showToast } from "@/shell/notifications/toast"
import { usePlatform } from "@/runtime/platform/platform"
import { notifySessionTabsRemoved } from "./session-events"
import { ProjectSectionsState, projectSection, sidebarProjectKey } from "./project-sections"

export function ProjectSidebar() {
  const language = useLanguage()
  const dialog = useDialog()
  const global = useGlobal()
  const servers = useServers()
  const tabs = useTabs()
  const layout = useLayout()
  const queryClient = useQueryClient()
  const platform = usePlatform()

  const [state, setState, , ready] = persisted(Persist.global("sidebar.project-sections"), ProjectSectionsState, {
    sections: [],
    order: [],
    assignments: {},
    collapsed: {},
    sessions: {},
  })

  const [visible, setVisible] = createStore<Record<string, number>>({})
  const [projectLimits, setProjectLimits] = createStore<Record<string, number>>({})
  const [drag, setDrag] = createStore({
    project: "",
    session: "",
    sessionProject: "",
    section: undefined as string | undefined,
    target: undefined as string | undefined,
  })
  const connections = createMemo(() =>
    servers.visible.flatMap((conn) => {
      const ctx = global.serverCtx(ServerConnection.key(conn))
      return ctx ? [{ conn, ctx }] : []
    }),
  )

  const queries = useQueries(() => ({
    queries: connections().map(({ conn, ctx }) => ({
      ...homeSessionsQuery(conn, ctx),
      enabled: ctx.sdk.connection.status() === "connected",
    })),
  }))

  const projects = createMemo(() =>
    connections()
      .flatMap((connection, index) => {
        const server = ServerConnection.key(connection.conn)

        const sessions = connection.ctx.data.session
          .apply(mergeHomeSessionIndex(queries[index]?.data?.() ?? [], connection.ctx.data.session.list()))
          // Persistent tasks render nested under their root session, never as rows of their own.
          .filter((session) => !session.parentID && !session.experimental?.taskParentID && !session.time.archived)

        return connection.ctx.projects.unique().map((project) => ({
          ...connection,
          server,
          project,
          key: sidebarProjectKey(server, project.worktree),
          sessions: sessions
            .filter(
              (session) =>
                sidebarProjectKey(
                  server,
                  connection.ctx.projects.forSession(session)?.worktree ?? session.location.directory,
                ) === sidebarProjectKey(server, project.worktree),
            )
            .toSorted((a, b) => b.time.updated - a.time.updated),
        }))
      })
      .toSorted((a, b) => {
        // Project activity also advances on viewing; rank by conversation updates instead.
        const updated = (b.sessions[0]?.time.updated ?? 0) - (a.sessions[0]?.time.updated ?? 0)
        return updated || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      }),
  )

  const byKey = createMemo(() => new Map(projects().map((project) => [project.key, project])))
  const drafts = createMemo(() =>
    tabs.store
      .filter((tab) => tab.type === "draft")
      .map((tab) => {
        const connection = connections().find((item) => ServerConnection.key(item.conn) === tab.server)
        const directory = connection?.ctx.projects.forDirectory(tab.directory)?.worktree ?? tab.directory
        return { tab, key: sidebarProjectKey(tab.server, directory) }
      }),
  )
  const sections = createMemo(() => {
    const items = [{ id: "", name: language.t("sidebar.sections.unassigned") }, ...state.sections]
    const order = new Map(state.order.map((id, index) => [id, index]))
    return items.toSorted((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size))
  })
  const toggle = (key: string) => setState("collapsed", key, !state.collapsed[key])

  const copySessionID = async (id: string) => {
    const written = await (platform.writeClipboardText
      ? platform.writeClipboardText(id).then(
          () => true,
          () => false,
        )
      : writeClipboard(id))
    showToast({
      variant: written ? "success" : "error",
      title: language.t(written ? "common.copied" : "toast.session.copyID.failed.title"),
      description: written ? id : language.t("toast.session.copyID.failed.description"),
    })
  }

  function deleteSession(key: string, session: SessionInfo) {
    const item = byKey().get(key)
    if (!item) return
    const remove = () => {
      dialog.close()
      const ids = sessionTreeIDs(item.ctx.data.session.list(), session.id)
      queryClient.setQueryData<SessionInfo[]>(["home-sessions", item.conn], (current) =>
        current?.filter((value) => !ids.includes(value.id)),
      )
      void item.ctx.data.session
        .remove(session.id)
        .then(() =>
          notifySessionTabsRemoved({
            server: item.server,
            directory: session.location.directory,
            sessionIDs: ids,
          }),
        )
        .catch((cause: unknown) =>
          showToast({
            variant: "error",
            title: language.t("session.delete.failed.title"),
            description: cause instanceof Error ? cause.message : language.t("session.delete.failed.title"),
          }),
        )
        .finally(() => void queryClient.invalidateQueries({ queryKey: ["home-sessions", item.conn], exact: true }))
    }
    dialog.show(() => (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", {
              name: sessionTitle(session.title) ?? language.t("command.session.new"),
            })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autofocus onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={remove}>
            {language.t("session.delete.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    ))
  }

  function DraftRow(props: { tab: DraftTab; nested?: boolean }) {
    const selected = () => {
      const route = layout.route()
      return route.type === "draft" && route.draftID === props.tab.draftID
    }

    return (
      <div class="group/draft flex items-center" classList={{ "ps-6": props.nested }}>
        <button
          type="button"
          aria-current={selected() ? "page" : undefined}
          class="h-7 min-w-0 flex-1 truncate rounded-[6px] px-2 text-start text-[13px] hover:bg-v2-overlay-simple-overlay-hover"
          classList={{ "bg-v2-overlay-simple-overlay-hover": selected() }}
          onClick={() => tabs.select(props.tab)}
        >
          {language.t("session.tab.session")}
        </button>
        <IconButton
          variant="ghost-muted"
          size="small"
          icon={<Icon name="trash" />}
          class="hover-reveal group-hover/draft:opacity-100 group-focus-within/draft:opacity-100"
          aria-label={language.t("common.delete")}
          onClick={() => tabs.closeTab(tabs.store.findIndex((item) => tabKey(item) === tabKey(props.tab)))}
        />
      </div>
    )
  }

  function editSection(section?: { id: string; name: string }) {
    dialog.show(() => {
      const [form, setForm] = createStore({ name: section?.name ?? "" })

      const save = () => {
        const name = form.name.trim()

        if (!name) return
        setState("sections", (items) =>
          section
            ? items.map((item) => (item.id === section.id ? { ...item, name } : item))
            : [...items, { id: uuid(), name }],
        )
        dialog.close()
      }

      return (
        <Dialog fit>
          <form
            class="contents"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
          >
            <DialogHeader>
              <DialogTitleGroup title={language.t(section ? "sidebar.sections.rename" : "sidebar.sections.create")} />
            </DialogHeader>
            <DialogBody class="px-4">
              <TextInput
                class="!w-full self-stretch"
                autofocus
                value={form.name}
                aria-label={language.t("sidebar.sections.name")}
                onInput={(event) => setForm("name", event.currentTarget.value)}
              />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => dialog.close()}>
                {language.t("common.cancel")}
              </Button>
              <Button type="submit" disabled={!form.name.trim()}>
                {language.t("common.save")}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )
    })
  }

  return (
    <nav
      aria-label={language.t("sidebar.sections.navigation")}
      data-scrollable
      class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden [app-region:no-drag]"
    >
      <Show when={ready()} fallback={<Loader />}>
        <For each={drafts().filter((draft) => !byKey().has(draft.key))}>{(draft) => <DraftRow tab={draft.tab} />}</For>
        <For each={sections()}>
          {(section) => {
            const id = section.id
            const items = createMemo(() => projects().filter((project) => projectSection(state, project.key) === id))
            const projectLimit = () => projectLimits[id] ?? 5
            const collapsed = () => !!state.collapsed[`section:${id}`]

            return (
              <section
                class="mb-5 rounded-[6px]"
                classList={{
                  "bg-v2-overlay-simple-overlay-hover": drag.target === id,
                }}
                aria-label={section.name}
                onDragOver={(event) => {
                  if (!drag.project && !(drag.section !== undefined && drag.section !== id)) return
                  event.preventDefault()
                  if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                  setDrag("target", id)
                }}
                onDragLeave={(event) => {
                  if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
                  setDrag("target", undefined)
                }}
                onDrop={(event) => {
                  if (drag.section !== undefined && drag.section !== id) {
                    event.preventDefault()
                    const order = sections().map((item) => item.id)
                    const source = order.indexOf(drag.section)
                    const target = order.indexOf(id)
                    setState("order", order.toSpliced(source, 1).toSpliced(target, 0, drag.section))
                    setDrag({ section: undefined, target: undefined })
                    return
                  }
                  if (!drag.project) return
                  event.preventDefault()
                  setState("assignments", drag.project, id)
                  setState("collapsed", `section:${id}`, false)
                  setDrag({ project: "", target: undefined })
                }}
              >
                <div class="group/section flex h-7 items-center">
                  <button
                    type="button"
                    draggable="true"
                    onDragStart={(event) => {
                      if (!event.dataTransfer) return
                      event.dataTransfer.effectAllowed = "move"
                      event.dataTransfer.setData("text/plain", id)
                      setDrag("section", id)
                    }}
                    onDragEnd={() => setDrag({ section: undefined, target: undefined })}
                    aria-expanded={!collapsed()}
                    onClick={() => toggle(`section:${id}`)}
                    class="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-[6px] px-2 text-start text-[13px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover"
                  >
                    <bdi class="truncate">{section.name}</bdi>
                    <Icon
                      name={collapsed() ? "chevron-right" : "chevron-down"}
                      size="small"
                      classList={{ "rtl:rotate-180": collapsed() }}
                    />
                  </button>
                  <Menu placement="bottom-end">
                    <Menu.Trigger
                      as={IconButton}
                      class="hover-reveal group-hover/section:opacity-100 group-focus-within/section:opacity-100"
                      variant="ghost-muted"
                      size="small"
                      icon={<Icon name="outline-dots" />}
                      aria-label={language.t("sidebar.sections.options", {
                        name: section.name,
                      })}
                    />
                    <Menu.Portal>
                      <Menu.Content>
                        <Menu.Item onSelect={() => editSection()}>{language.t("sidebar.sections.create")}</Menu.Item>
                        <Show when={id}>
                          <Menu.Item onSelect={() => editSection(section)}>
                            {language.t("sidebar.sections.rename")}
                          </Menu.Item>
                          <Menu.Item
                            onSelect={() => setState("sections", (items) => items.filter((item) => item.id !== id))}
                          >
                            {language.t("sidebar.sections.remove")}
                          </Menu.Item>
                        </Show>
                      </Menu.Content>
                    </Menu.Portal>
                  </Menu>
                </div>
                <Show when={!collapsed()}>
                  <For
                    each={items()
                      .slice(0, projectLimit())
                      .map((project) => project.key)}
                  >
                    {(key) => {
                      const item = () => byKey().get(key)!
                      const expanded = () => !state.collapsed[`project:${key}`]
                      const limit = () => visible[key] ?? 5
                      const newDraft = () => {
                        setState("collapsed", `project:${key}`, false)
                        void tabs.newDraft({
                          server: item().server,
                          directory: item().project.worktree,
                        })
                      }

                      const ordered = createMemo(() => {
                        const saved = new Map(
                          (state.sessions[key] ?? []).map((entry, index) => [entry.id, { ...entry, index }]),
                        )
                        return item().sessions.toSorted((a, b) => {
                          const left = saved.get(a.id)
                          const right = saved.get(b.id)
                          const freshA = !left || a.time.updated > left.updated
                          const freshB = !right || b.time.updated > right.updated
                          if (freshA && freshB) return b.time.updated - a.time.updated
                          if (freshA !== freshB) return freshA ? -1 : 1
                          return left!.index - right!.index
                        })
                      })
                      const sessions = () => {
                        const list = ordered()
                        const route = layout.route()

                        const current = route.type === "session" && route.server === item().server ? route.sessionId : undefined
                        let root = current
                        while (root) {
                          const parent = item().ctx.data.session.get(root)?.experimental?.taskParentID
                          if (!parent) break
                          root = parent
                        }
                        const selected = list.find((session) => session.id === root)

                        return selected && !list.slice(0, limit()).includes(selected)
                          ? [...list.slice(0, limit()), selected]
                          : list.slice(0, limit())
                      }

                      return (
                        <div role="group" aria-label={displayName(item().project)}>
                          <div class="group/project flex h-7 items-center">
                            <button
                              type="button"
                              draggable="true"
                              onDragStart={(event) => {
                                if (!event.dataTransfer) return
                                event.dataTransfer.effectAllowed = "move"
                                event.dataTransfer.setData("text/plain", key)
                                setDrag("project", key)
                              }}
                              onDragEnd={() => setDrag({ project: "", target: undefined })}
                              aria-expanded={expanded()}
                              title={item().project.worktree}
                              class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-start text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                              onClick={() => toggle(`project:${key}`)}
                            >
                              <Icon name="folder" size="small" class="shrink-0" />
                              <bdi class="truncate">{displayName(item().project)}</bdi>
                              <Show when={!item().ctx.isLocal}>
                                <bdi class="min-w-0 truncate text-v2-text-text-subtle">
                                  {servers.label(item().conn)}
                                </bdi>
                              </Show>
                              <Icon
                                name={expanded() ? "chevron-down" : "chevron-right"}
                                size="small"
                                class="shrink-0"
                                classList={{ "rtl:rotate-180": !expanded() }}
                              />
                            </button>
                            <Menu placement="bottom-end">
                              <Menu.Trigger
                                as={IconButton}
                                class="hover-reveal group-hover/project:opacity-100 group-focus-within/project:opacity-100"
                                variant="ghost-muted"
                                size="small"
                                icon={<Icon name="outline-dots" />}
                                aria-label={language.t("common.moreOptions")}
                              />
                              <Menu.Portal>
                                <Menu.Content>
                                  <Menu.Item onSelect={newDraft}>{language.t("command.session.new")}</Menu.Item>
                                  <Menu.Separator />
                                  <For each={sections()}>
                                    {(target) => (
                                      <Menu.Item
                                        disabled={target.id === projectSection(state, key)}
                                        onSelect={() => setState("assignments", key, target.id)}
                                      >
                                        {language.t("sidebar.sections.move", {
                                          name: target.name,
                                        })}
                                      </Menu.Item>
                                    )}
                                  </For>
                                </Menu.Content>
                              </Menu.Portal>
                            </Menu>
                            <IconButton
                              variant="ghost-muted"
                              size="small"
                              class="shrink-0 hover-reveal group-hover/project:opacity-100 group-focus-within/project:opacity-100"
                              icon={<Icon name="edit" />}
                              aria-label={language.t("command.session.new")}
                              onClick={newDraft}
                            />
                          </div>
                          <Show when={expanded()}>
                            <For each={drafts().filter((draft) => draft.key === key)}>
                              {(draft) => <DraftRow tab={draft.tab} nested />}
                            </For>
                            <For each={sessions().map((session) => session.id)}>
                              {(sessionID) => {
                                const session = () => item().sessions.find((session) => session.id === sessionID)
                                const [tree, controls] = createResource(
                                  () => sessionID,
                                  async (id) => ({
                                    id,
                                    tasks: await item().ctx.sdk.api.experimental.session.tasks.tree({ sessionID: id }),
                                  }),
                                )
                                const tasks = () => {
                                  if (tree.state !== "ready" && tree.state !== "refreshing") return []
                                  if (tree.latest?.id !== sessionID) return []
                                  return tree.latest.tasks.filter((task) => !task.time.archived)
                                }
                                const children = (id: string) =>
                                  tasks().filter((task) => task.experimental?.taskParentID === id)
                                const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({})
                                onCleanup(
                                  item().ctx.sdk.event.listen((event) => {
                                    if (
                                      event.type === "session.created" ||
                                      event.type === "session.deleted" ||
                                      event.type === "session.renamed" ||
                                      event.type === "session.archived" ||
                                      event.type === "session.unarchived"
                                    )
                                      void controls.refetch()
                                  }),
                                )
                                const rows = createMemo(() => {
                                  const walk = (
                                    id: string,
                                    depth: number,
                                  ): Array<{ task: SessionInfo; depth: number }> =>
                                    collapsed[id]
                                      ? []
                                      : children(id).flatMap((task) => [{ task, depth }, ...walk(task.id, depth + 1)])
                                  return walk(sessionID, 1)
                                })

                                const status = useSessionTabAvatarState(
                                  () => item().server,
                                  () => sessionID,
                                  () => true,
                                )

                                const selected = () => {
                                  const route = layout.route()

                                  return (
                                    route.type === "session" &&
                                    route.server === item().server &&
                                    route.sessionId === sessionID
                                  )
                                }

                                return (
                                  <>
                                    <div class="relative">
                                      <Show when={children(sessionID).length > 0}>
                                        <button
                                          type="button"
                                          class="absolute start-3 top-0 z-10 flex h-7 w-5 items-center justify-center"
                                          aria-expanded={!collapsed[sessionID]}
                                          aria-label={language.t(
                                            collapsed[sessionID] ? "tasks.expand" : "tasks.collapse",
                                            {
                                              title: session()?.title ?? language.t("tasks.untitled"),
                                            },
                                          )}
                                          onClick={() => setCollapsed(sessionID, !collapsed[sessionID])}
                                        >
                                          <Icon
                                            name={collapsed[sessionID] ? "chevron-right" : "chevron-down"}
                                            size="small"
                                            classList={{ "rtl:rotate-180": collapsed[sessionID] }}
                                          />
                                        </button>
                                      </Show>
                                      <Menu.Context>
                                        <Menu.Context.Trigger
                                          as="button"
                                          type="button"
                                          draggable="true"
                                          onDragStart={(event) => {
                                            if (!event.dataTransfer) return
                                            event.stopPropagation()
                                            event.dataTransfer.effectAllowed = "move"
                                            event.dataTransfer.setData("text/plain", sessionID)
                                            setDrag({ session: sessionID, sessionProject: key })
                                          }}
                                          onDragEnd={() => setDrag({ session: "", sessionProject: "" })}
                                          onDragOver={(event) => {
                                            if (drag.sessionProject !== key || drag.session === sessionID) return
                                            event.preventDefault()
                                            event.stopPropagation()
                                            if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                                          }}
                                          onDrop={(event) => {
                                            if (drag.sessionProject !== key || drag.session === sessionID) return
                                            event.preventDefault()
                                            event.stopPropagation()
                                            const list = ordered().map((value) => ({
                                              id: value.id,
                                              updated: value.time.updated,
                                            }))
                                            const source = list.findIndex((value) => value.id === drag.session)
                                            const target = list.findIndex((value) => value.id === sessionID)
                                            if (source < 0 || target < 0) return
                                            setState(
                                              "sessions",
                                              key,
                                              list.toSpliced(source, 1).toSpliced(target, 0, list[source]!),
                                            )
                                            setDrag({ session: "", sessionProject: "" })
                                          }}
                                          aria-current={selected() ? "page" : undefined}
                                          title={session()?.title}
                                          class="flex h-7 w-full items-center gap-1 rounded-[6px] ps-8 pe-2 text-start text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                                          classList={{
                                            "bg-v2-overlay-simple-overlay-hover": selected(),
                                          }}
                                          onClick={() => {
                                            const value = session()

                                            if (!value) return
                                            item().ctx.data.session.remember(value)
                                            void startTransition(() =>
                                              tabs.select(
                                                tabs.addSessionTab({
                                                  server: item().server,
                                                  sessionId: sessionID,
                                                }),
                                              ),
                                            )
                                          }}
                                        >
                                          <bdi class="min-w-0 flex-1 truncate">
                                            {sessionTitle(session()?.title) ?? language.t("command.session.new")}
                                          </bdi>
                                          <Show
                                            when={status.loading()}
                                            fallback={
                                              <Show when={status.unread()}>
                                                <span class="size-1.5 shrink-0 rounded-full bg-current" />
                                              </Show>
                                            }
                                          >
                                            <ActivityRing class="size-3.5 shrink-0" />
                                          </Show>
                                        </Menu.Context.Trigger>
                                        <Menu.Context.Portal>
                                          <Menu.Context.Content>
                                            <Menu.Item onSelect={() => void copySessionID(sessionID)}>
                                              {language.t("command.session.copyID")}
                                            </Menu.Item>
                                            <Menu.Separator />
                                            <Menu.Item
                                              onSelect={() => {
                                                const value = session()
                                                if (value) deleteSession(key, value)
                                              }}
                                            >
                                              {language.t("common.delete")}
                                            </Menu.Item>
                                          </Menu.Context.Content>
                                        </Menu.Context.Portal>
                                      </Menu.Context>
                                    </div>
                                    <Show when={tree.error}>
                                      <p class="ps-8 pe-2 text-12 text-text-weak">{language.t("tasks.error")}</p>
                                      <button
                                        type="button"
                                        class="w-full ps-8 pe-2 text-start text-12 text-text-weak"
                                        onClick={() => void controls.refetch()}
                                      >
                                        {language.t("tasks.refresh")}
                                      </button>
                                    </Show>
                                    <For each={rows()}>
                                      {(row) => {
                                        const childStatus = useSessionTabAvatarState(
                                          () => item().server,
                                          () => row.task.id,
                                          () => true,
                                        )
                                        const active = () => {
                                          const route = layout.route()
                                          return (
                                            route.type === "session" &&
                                            route.server === item().server &&
                                            route.sessionId === row.task.id
                                          )
                                        }
                                        return (
                                          <div
                                            class="relative"
                                            style={{ "padding-inline-start": `${row.depth * 16}px` }}
                                          >
                                            <Show when={children(row.task.id).length > 0}>
                                              <button
                                                type="button"
                                                class="absolute top-0 z-10 flex h-7 w-5 items-center justify-center"
                                                style={{ "inset-inline-start": `${12 + row.depth * 16}px` }}
                                                aria-expanded={!collapsed[row.task.id]}
                                                aria-label={language.t(
                                                  collapsed[row.task.id] ? "tasks.expand" : "tasks.collapse",
                                                  {
                                                    title: row.task.title ?? language.t("tasks.untitled"),
                                                  },
                                                )}
                                                onClick={() => setCollapsed(row.task.id, !collapsed[row.task.id])}
                                              >
                                                <Icon
                                                  name={collapsed[row.task.id] ? "chevron-right" : "chevron-down"}
                                                  size="small"
                                                  classList={{ "rtl:rotate-180": collapsed[row.task.id] }}
                                                />
                                              </button>
                                            </Show>
                                            <Menu.Context>
                                              <Menu.Context.Trigger
                                                as="button"
                                                type="button"
                                                aria-current={active() ? "page" : undefined}
                                                class="flex h-7 w-full items-center gap-1 rounded-[6px] ps-8 pe-2 text-start text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
                                                classList={{ "bg-v2-overlay-simple-overlay-hover": active() }}
                                                onClick={() => {
                                                  item().ctx.data.session.remember(row.task)
                                                  void startTransition(() =>
                                                    tabs.select(
                                                      tabs.addSessionTab({
                                                        server: item().server,
                                                        sessionId: row.task.id,
                                                      }),
                                                    ),
                                                  )
                                                }}
                                              >
                                                <bdi class="min-w-0 flex-1 truncate">
                                                  {sessionTitle(row.task.title) ?? language.t("command.session.new")}
                                                </bdi>
                                                <Show
                                                  when={childStatus.loading()}
                                                  fallback={
                                                    <Show when={childStatus.unread()}>
                                                      <span class="size-1.5 shrink-0 rounded-full bg-current" />
                                                    </Show>
                                                  }
                                                >
                                                  <ActivityRing class="size-3.5 shrink-0" />
                                                </Show>
                                              </Menu.Context.Trigger>
                                              <Menu.Context.Portal>
                                                <Menu.Context.Content>
                                                  <Menu.Item onSelect={() => void copySessionID(row.task.id)}>
                                                    {language.t("command.session.copyID")}
                                                  </Menu.Item>
                                                </Menu.Context.Content>
                                              </Menu.Context.Portal>
                                            </Menu.Context>
                                          </div>
                                        )
                                      }}
                                    </For>
                                  </>
                                )
                              }}
                            </For>
                            <Show when={item().sessions.length > limit()}>
                              <button
                                type="button"
                                class="h-7 w-full ps-8 text-start text-[13px] text-v2-text-text-muted hover:text-v2-text-text-base"
                                onClick={() => setVisible(key, limit() + 10)}
                              >
                                {language.t("sidebar.sections.more")}
                              </button>
                            </Show>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                  <Show when={items().length > projectLimit()}>
                    <button
                      type="button"
                      class="h-7 w-full px-2 text-start text-[13px] text-v2-text-text-muted hover:text-v2-text-text-base"
                      onClick={() => setProjectLimits(id, projectLimit() + 10)}
                    >
                      {language.t("sidebar.sections.more")}
                    </button>
                  </Show>
                  <Show when={!items().length}>
                    <p class="px-2 py-1 text-[13px] text-v2-text-text-muted">{language.t("sidebar.sections.empty")}</p>
                  </Show>
                </Show>
              </section>
            )
          }}
        </For>
        <Show when={queries.some((query) => query.isLoading)}>
          <Loader />
        </Show>
        <Show when={queries.some((query) => query.isError)}>
          <Button
            variant="ghost"
            size="small"
            onClick={() =>
              queries.forEach((query) => {
                if (query.isError) void query.refetch()
              })
            }
          >
            {language.t("sidebar.sections.retry")}
          </Button>
        </Show>
      </Show>
    </nav>
  )
}
