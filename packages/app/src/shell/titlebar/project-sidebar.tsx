import { batch, createEffect, createMemo, For, on, onCleanup, Show, startTransition } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useQueries, useQuery, useQueryClient } from "@tanstack/solid-query"
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
import { Tooltip } from "@opencode/ui/tooltip"
import { uuid } from "@opencode/util/uuid"
import { comparablePath, containsDirectory, getFilename } from "@opencode/util/path"
import { homeSessionsQuery, projectSessionDirectories } from "@/home/sessions/queries"
import { mergeHomeSessionIndex } from "@/home/sessions/index"
import { useLanguage } from "@/runtime/i18n/language"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { type ServerCtx, useGlobal } from "@/runtime/server/runtime"
import { useLayout } from "@/shell/state/layout"
import { type DraftTab, tabKey, useTabs } from "@/shell/tabs/tabs"
import { useSessionTabAvatarState } from "@/shell/layout/project-avatar-state"
import { ActivityRing } from "@opencode/ui/activity-ring"
import { sessionTitle } from "@/session/title"
import { sessionTreeIDs } from "@/session/requests/session-request-tree"
import { showToast } from "@/shell/notifications/toast"
import { usePlatform } from "@/runtime/platform/platform"
import { notifySessionTabsRemoved } from "./session-events"
import {
  ProjectSectionsState,
  projectSection,
  projectSorts,
  sidebarProjectKey,
  translateProjectSections,
} from "./project-sections"
import { createSidebarTaskChanges, createSidebarTaskTree } from "./sidebar-task-trees"
import { isSidebarSessionActivity } from "./sidebar-sessions"
import { createSessionPins } from "./sidebar-pins"
import { splitRecentSessionKey } from "./recent-sessions-model"
import { pinnedFirst, sidebarTaskRows } from "./sidebar-session-tree"

export function ProjectSidebar(props: { onNavigate?: () => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  const global = useGlobal()
  const servers = useServers()
  const tabs = useTabs()
  const layout = useLayout()
  const queryClient = useQueryClient()
  const platform = usePlatform()

  const initial = { sections: [], order: [], projects: [], sorting: {}, assignments: {}, collapsed: {}, sessions: {} }

  const [state, setState, , ready] = persisted(
    Persist.global("sidebar.project-sections"),
    ProjectSectionsState,
    initial,
  )

  const ownKey = () => {
    const current = servers.list.find(servers.current)
    return current ? ServerConnection.key(current) : "sidecar"
  }
  global.share({
    key: "sidebar.project-sections",
    schema: ProjectSectionsState,
    initial,
    read: () => translateProjectSections(state, ownKey(), "sidecar"),
    apply: (value) => setState(reconcile(translateProjectSections(value, "sidecar", ownKey()))),
    ready,
  })

  const pins = createSessionPins()

  // Pinned session IDs per server identity, in pin order.
  const pinnedIDs = createMemo(() =>
    Map.groupBy(
      pins.keys().flatMap((key) => {
        const pin = splitRecentSessionKey(key)

        return pin ? [pin] : []
      }),
      (pin) => pins.identity(pin.server, ""),
    ),
  )

  const pinnedFor = (server: string) => (pinnedIDs().get(pins.identity(server, "")) ?? []).map((pin) => pin.sessionID)

  const [visible, setVisible] = createStore<Record<string, number>>({})
  const [projectLimits, setProjectLimits] = createStore<Record<string, number>>({})

  const [drag, setDrag] = createStore<{
    project: string
    session: string
    sessionFolder: string
    section?: string
    target?: string
  }>({
    project: "",
    session: "",
    sessionFolder: "",
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

  const taskChanges = createSidebarTaskChanges(() => connections().map(({ ctx }) => ctx.sdk.event))
  const [activity, setActivity] = createStore<Record<string, number>>({})
  createEffect(() => {
    for (const { conn, ctx } of connections()) {
      onCleanup(
        ctx.data.listen(({ details }) => {
          if (!isSidebarSessionActivity(details)) return
          const session = ctx.data.session.get(details.data.sessionID)
          const directory =
            (session && ctx.projects.forSession(session)?.worktree) ??
            (details.location && ctx.projects.forDirectory(details.location.directory)?.worktree)
          if (!directory) return
          setActivity(sidebarProjectKey(ServerConnection.key(conn), directory), (at) =>
            Math.max(at ?? 0, details.created),
          )
        }),
      )
    }
  })

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
      .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  )

  const projectOrder = createMemo(() => new Map(state.projects.map((key, index) => [key, index])))
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
          onClick={() => {
            tabs.select(props.tab)
            navigated()
          }}
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

  function navigated() {
    props.onNavigate?.()
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

            const sort = createMemo(
              () =>
                state.sorting[id] ??
                (state.projects.some((key) => projectSection(state, key) === id) ? "manual" : "updated"),
            )
            const collator = createMemo(() => new Intl.Collator(language.intl(), { numeric: true }))
            const items = createMemo(() =>
              projects()
                .filter((project) => projectSection(state, project.key) === id)
                .toSorted((a, b) => {
                  const delta =
                    sort() === "manual"
                      ? (projectOrder().get(a.key) ?? projectOrder().size) -
                        (projectOrder().get(b.key) ?? projectOrder().size)
                      : sort() === "updated"
                        ? Math.max(activity[b.key] ?? 0, b.sessions[0]?.time.updated ?? b.project.time.created) -
                          Math.max(activity[a.key] ?? 0, a.sessions[0]?.time.updated ?? a.project.time.created)
                        : 0
                  return delta || collator().compare(displayName(a.project), displayName(b.project))
                }),
            )

            const move = (key: string, target: number) => {
              const keys = items().map((item) => item.key)
              const source = keys.indexOf(key)
              if (source < 0 || target < 0 || target >= keys.length || source === target) return
              const sectionKeys = new Set(keys)
              batch(() => {
                setState("projects", (order) => [
                  ...order.filter((other) => !sectionKeys.has(other)),
                  ...keys.toSpliced(source, 1).toSpliced(target, 0, key),
                ])
                setState("sorting", id, "manual")
                if (target >= projectLimit()) setProjectLimits(id, target + 1)
              })
            }
            const projectLimit = () => projectLimits[id] ?? 5
            const shown = createMemo(() => {
              const list = items()
              const first = list.slice(0, projectLimit())
              if (first.length === list.length) return first
              const route = layout.route()
              const selected =
                route.type === "draft" ? drafts().find(({ tab }) => tab.draftID === route.draftID)?.key : undefined
              const active = list.find((project) => {
                if (route.type !== "session" || route.server !== project.server) return project.key === selected
                const session = project.ctx.data.session.get(route.sessionId)
                return session && project.ctx.projects.forSession(session)?.worktree === project.project.worktree
              })
              return active && !first.includes(active) ? [...first, active] : first
            })
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
                        <Menu.Sub>
                          <Menu.SubTrigger>{language.t("sidebar.recent.view.sortBy")}</Menu.SubTrigger>
                          <Menu.Portal>
                            <Menu.SubContent>
                              <Menu.RadioGroup
                                value={sort()}
                                onChange={(value) => {
                                  const next = projectSorts.find((mode) => mode === value)
                                  if (next) setState("sorting", id, next)
                                }}
                              >
                                <For each={projectSorts}>
                                  {(mode) => (
                                    <Menu.RadioItem value={mode} closeOnSelect>
                                      {language.t(
                                        mode === "manual"
                                          ? "sidebar.view.ordering.manual"
                                          : `sidebar.recent.view.sortBy.${mode}`,
                                      )}
                                    </Menu.RadioItem>
                                  )}
                                </For>
                              </Menu.RadioGroup>
                            </Menu.SubContent>
                          </Menu.Portal>
                        </Menu.Sub>
                        <Menu.Separator />
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
                  <For each={shown().map((project) => project.key)}>
                    {(key) => {
                      const item = () => byKey().get(key)!
                      const expanded = () => !state.collapsed[`project:${key}`]
                      createEffect(
                        on(
                          () =>
                            expanded() &&
                            item().ctx.sdk.connection.status() === "connected" &&
                            item().project.vcs === "git" &&
                            item().project.id,
                          (id) => {
                            if (id && !item().ctx.sync.worktrees.cached(id)) void item().ctx.sync.worktrees.list(id)
                          },
                        ),
                      )

                      const newDraft = (worktree?: string) => {
                        setState("collapsed", `project:${key}`, false)
                        void tabs
                          .newDraft({
                            server: item().server,
                            directory: item().project.worktree,
                            worktree,
                          })
                          .then(navigated)
                      }

                      const ordered = createMemo(() => {
                        const saved = new Map(
                          (state.sessions[key] ?? []).map((entry, index) => [entry.id, { ...entry, index }]),
                        )

                        return pinnedFirst(
                          item().sessions.toSorted((a, b) => {
                            const left = saved.get(a.id)
                            const right = saved.get(b.id)
                            const freshA = !left || a.time.updated > left.updated
                            const freshB = !right || b.time.updated > right.updated

                            if (freshA && freshB) return b.time.updated - a.time.updated

                            if (freshA !== freshB) return freshA ? -1 : 1

                            return left!.index - right!.index
                          }),
                          pinnedFor(item().server),
                        )
                      })

                      const pinned = createMemo(() => new Set(pinnedFor(item().server)))

                      const directories = createMemo(() => projectSessionDirectories(item().project))
                      const deepestFirst = createMemo(() => directories().toSorted((a, b) => b.length - a.length))
                      const folderFor = (directory: string) =>
                        deepestFirst().find((root) => containsDirectory(root, directory)) ?? item().project.worktree
                      // Pinned sessions lead the project, above every worktree folder, and leave their folder's list.
                      const pinnedSessions = createMemo(() => ordered().filter((session) => pinned().has(session.id)))
                      const folderSessions = createMemo(() =>
                        Map.groupBy(
                          ordered().filter((session) => !pinned().has(session.id)),
                          (session) => folderFor(session.location.directory),
                        ),
                      )
                      const folderDrafts = createMemo(() =>
                        Map.groupBy(
                          drafts().filter((draft) => draft.key === key),
                          ({ tab }) =>
                            folderFor(
                              tab.worktree && tab.worktree !== "main" && tab.worktree !== "create"
                                ? tab.worktree
                                : tab.directory,
                            ),
                        ),
                      )
                      const folders = createMemo(() => [
                        ...directories()
                          .slice(1)
                          .filter((directory) => folderSessions().has(directory) || folderDrafts().has(directory))
                          .toSorted((a, b) => getFilename(a).localeCompare(getFilename(b)) || a.localeCompare(b)),
                        item().project.worktree,
                      ])
                      const currentRoot = createMemo(() => {
                        const route = layout.route()

                        const current =
                          route.type === "session" && route.server === item().server ? route.sessionId : undefined

                        let root = current

                        while (root) {
                          const parent = item().ctx.data.session.get(root)?.experimental?.taskParentID

                          if (!parent) break
                          root = parent
                        }

                        return root
                      })

                      return (
                        <div role="group" aria-label={displayName(item().project)} data-focus-scope>
                          <div
                            class="group/project flex h-7 items-center"
                            onDragOver={(event) => {
                              if (!drag.project || projectSection(state, drag.project) !== id) return
                              event.preventDefault()
                              event.stopPropagation()

                              if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                            }}
                            onDrop={(event) => {
                              if (!drag.project || projectSection(state, drag.project) !== id) return
                              event.preventDefault()
                              event.stopPropagation()
                              move(
                                drag.project,
                                items().findIndex((project) => project.key === key),
                              )
                              setDrag({ project: "", target: undefined })
                            }}
                          >
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
                            <Show when={item().project.vcs === "git"}>
                              <PullRequestLink
                                ctx={item().ctx}
                                projectID={item().project.id}
                                directory={item().project.worktree}
                              />
                            </Show>
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
                                  <Menu.Item onSelect={() => newDraft()}>{language.t("command.session.new")}</Menu.Item>
                                  <Menu.Separator />
                                  <Menu.Item
                                    disabled={items()[0]?.key === key}
                                    onSelect={() => move(key, items().findIndex((item) => item.key === key) - 1)}
                                  >
                                    {language.t("sidebar.recent.moveUp")}
                                  </Menu.Item>
                                  <Menu.Item
                                    disabled={items().at(-1)?.key === key}
                                    onSelect={() => move(key, items().findIndex((item) => item.key === key) + 1)}
                                  >
                                    {language.t("sidebar.recent.moveDown")}
                                  </Menu.Item>
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
                              onClick={() => newDraft()}
                            />
                          </div>
                          <Show when={expanded()}>
                            <Show when={pinnedSessions().length > 0}>
                              <SessionRows
                                ids={pinnedSessions().map((session) => session.id)}
                                folderKey={`pinned:${key}`}
                              />
                            </Show>
                            <For each={folders()}>
                              {(directory) => {
                                const nested = directory !== item().project.worktree
                                const folderKey = nested
                                  ? `worktree:${sidebarProjectKey(item().server, directory)}`
                                  : key
                                const list = () => folderSessions().get(directory) ?? []
                                const localDrafts = () => folderDrafts().get(directory) ?? []
                                const limit = () => visible[folderKey] ?? 5
                                const active = createMemo(() => list().find((session) => session.id === currentRoot()))
                                const currentDraft = () => {
                                  const route = layout.route()
                                  return (
                                    route.type === "draft" &&
                                    localDrafts().some(({ tab }) => tab.draftID === route.draftID)
                                  )
                                }
                                const current = () => !!active() || currentDraft()
                                const open = () => {
                                  if (!nested) return true
                                  const collapsed = state.collapsed[folderKey]
                                  return collapsed === undefined ? current() : !collapsed
                                }
                                const count = () => list().length + localDrafts().length
                                const sessions = createMemo(() => {
                                  const first = list().slice(0, limit())

                                  const selected = active()
                                  return selected && !first.includes(selected) ? [...first, selected] : first
                                })
                                const name = createMemo(() => worktreeLabel(directory, folders()))
                                return (
                                  <div
                                    classList={{ "ms-4": nested }}
                                    role={nested ? "group" : undefined}
                                    aria-label={nested ? name() : undefined}
                                  >
                                    <Show when={nested}>
                                      <div class="group/worktree flex h-7 items-center">
                                        <button
                                          type="button"
                                          aria-expanded={open()}
                                          aria-current={!open() && current() ? "location" : undefined}
                                          aria-description={language.plural(
                                            "settings.workspaces.sessions.filtered",
                                            count(),
                                            { count: count() },
                                          )}
                                          title={directory}
                                          class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-[6px] px-2 text-start text-[13px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:-outline-offset-2"
                                          classList={{ "bg-v2-overlay-simple-overlay-hover": !open() && current() }}
                                          onClick={() => setState("collapsed", folderKey, open())}
                                        >
                                          <Icon name="folder" size="small" class="shrink-0" />
                                          <bdi class="truncate">{name()}</bdi>
                                          <Icon
                                            name={open() ? "chevron-down" : "chevron-right"}
                                            size="small"
                                            class="shrink-0"
                                          />
                                          <Show when={!open()}>
                                            <span aria-hidden="true" class="ms-auto text-12 tabular-nums">
                                              {count()}
                                            </span>
                                          </Show>
                                        </button>
                                        <Show when={item().project.vcs === "git"}>
                                          <PullRequestLink
                                            ctx={item().ctx}
                                            projectID={item().project.id}
                                            directory={directory}
                                          />
                                        </Show>
                                        <IconButton
                                          variant="ghost-muted"
                                          size="small"
                                          class="shrink-0 hover-reveal group-hover/worktree:opacity-100 group-focus-within/worktree:opacity-100"
                                          icon={<Icon name="edit" />}
                                          aria-label={language.t("command.session.new")}
                                          onClick={() => {
                                            setState("collapsed", folderKey, false)
                                            newDraft(directory)
                                          }}
                                        />
                                      </div>
                                    </Show>
                                    <Show when={open()}>
                                      <div classList={{ "ps-2": nested }}>
                                        <For each={localDrafts()}>{(draft) => <DraftRow tab={draft.tab} nested />}</For>
                                        <SessionRows
                                          ids={sessions().map((session) => session.id)}
                                          folderKey={folderKey}
                                        />
                                        <Show when={list().length > sessions().length}>
                                          <button
                                            type="button"
                                            class="h-7 w-full ps-8 text-start text-[13px] text-v2-text-text-muted hover:text-v2-text-text-base"
                                            onClick={() => setVisible(folderKey, limit() + 10)}
                                          >
                                            {language.t("sidebar.sections.more")}
                                          </button>
                                        </Show>
                                      </div>
                                    </Show>
                                  </div>
                                )
                              }}
                            </For>
                          </Show>
                        </div>
                      )

                      function SessionRows(props: { ids: string[]; folderKey: string }) {
                        return (
                          <For each={props.ids}>
                            {(sessionID) => {
                              const session = () => item().sessions.find((session) => session.id === sessionID)

                              const family = createSidebarTaskTree(
                                () => item().ctx.sdk.event,
                                taskChanges,
                                () => item().ctx.sdk.api.experimental.session.tasks.tree({ sessionID }),
                              )

                              const tasks = () => {
                                const { tree } = family()

                                if (tree.state !== "ready" && tree.state !== "refreshing") return []

                                return tree.latest.tasks.filter((task) => !task.time.archived)
                              }

                              const children = (id: string) =>
                                tasks().filter((task) => task.experimental?.taskParentID === id)

                              const [collapsed, setCollapsed] = createStore<Record<string, boolean>>({})

                              const rows = createMemo(() =>
                                collapsed[sessionID]
                                  ? []
                                  : sidebarTaskRows({
                                      root: {
                                        id: sessionID,
                                        location: {
                                          directory: session()?.location.directory ?? item().project.worktree,
                                        },
                                      },
                                      tasks: tasks(),
                                      folderFor,
                                      collapsed: (key) => !!collapsed[key],
                                    }),
                              )

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
                                          setDrag({ session: sessionID, sessionFolder: props.folderKey })
                                        }}
                                        onDragEnd={() => setDrag({ session: "", sessionFolder: "" })}
                                        onDragOver={(event) => {
                                          if (drag.sessionFolder !== props.folderKey || drag.session === sessionID)
                                            return
                                          event.preventDefault()
                                          event.stopPropagation()

                                          if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
                                        }}
                                        onDrop={(event) => {
                                          if (drag.sessionFolder !== props.folderKey || drag.session === sessionID)
                                            return
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
                                          setDrag({ session: "", sessionFolder: "" })
                                        }}
                                        aria-current={selected() ? "page" : undefined}
                                        aria-description={
                                          pinned().has(sessionID) ? language.t("sidebar.recent.pinned") : undefined
                                        }
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
                                          ).then(navigated)
                                        }}
                                      >
                                        <bdi class="min-w-0 flex-1 truncate">
                                          {sessionTitle(session()?.title) ?? language.t("command.session.new")}
                                        </bdi>
                                        <Show when={pinned().has(sessionID)}>
                                          <Icon name="pin" size="small" class="shrink-0 text-v2-icon-icon-muted" />
                                        </Show>
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
                                          <Menu.Item onSelect={() => pins.toggle(item().server, sessionID)}>
                                            {language.t(
                                              pinned().has(sessionID) ? "sidebar.recent.unpin" : "sidebar.recent.pin",
                                            )}
                                          </Menu.Item>
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
                                  <Show when={family().tree.error}>
                                    <p class="ps-8 pe-2 text-12 text-text-weak">{language.t("tasks.error")}</p>
                                    <button
                                      type="button"
                                      class="w-full ps-8 pe-2 text-start text-12 text-text-weak"
                                      onClick={() => void family().refresh()}
                                    >
                                      {language.t("tasks.refresh")}
                                    </button>
                                  </Show>
                                  <For each={rows()}>
                                    {(row) => {
                                      if (row.type === "folder") {
                                        const open = () => !collapsed[row.key]

                                        const label = worktreeLabel(row.directory, directories())

                                        return (
                                          <div style={{ "padding-inline-start": `${row.depth * 16}px` }}>
                                            <button
                                              type="button"
                                              aria-expanded={open()}
                                              aria-description={language.plural(
                                                "settings.workspaces.sessions.filtered",
                                                row.count,
                                                {
                                                  count: row.count,
                                                },
                                              )}
                                              title={row.directory}
                                              class="flex h-7 w-full min-w-0 items-center gap-2 rounded-[6px] ps-8 pe-2 text-start text-[13px] text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover focus-visible:-outline-offset-2"
                                              onClick={() => setCollapsed(row.key, open())}
                                            >
                                              <Icon name="folder" size="small" class="shrink-0" />
                                              <bdi class="truncate">{label}</bdi>
                                              <Icon
                                                name={open() ? "chevron-down" : "chevron-right"}
                                                size="small"
                                                class="shrink-0"
                                                classList={{ "rtl:rotate-180": !open() }}
                                              />
                                              <Show when={!open()}>
                                                <span aria-hidden="true" class="ms-auto text-12 tabular-nums">
                                                  {row.count}
                                                </span>
                                              </Show>
                                            </button>
                                          </div>
                                        )
                                      }

                                      const task = row.session

                                      const childStatus = useSessionTabAvatarState(
                                        () => item().server,
                                        () => task.id,
                                        () => true,
                                      )

                                      const active = () => {
                                        const route = layout.route()

                                        return (
                                          route.type === "session" &&
                                          route.server === item().server &&
                                          route.sessionId === task.id
                                        )
                                      }

                                      return (
                                        <div class="relative" style={{ "padding-inline-start": `${row.depth * 16}px` }}>
                                          <Show when={children(task.id).length > 0}>
                                            <button
                                              type="button"
                                              class="absolute top-0 z-10 flex h-7 w-5 items-center justify-center"
                                              style={{ "inset-inline-start": `${12 + row.depth * 16}px` }}
                                              aria-expanded={!collapsed[task.id]}
                                              aria-label={language.t(
                                                collapsed[task.id] ? "tasks.expand" : "tasks.collapse",
                                                {
                                                  title: task.title ?? language.t("tasks.untitled"),
                                                },
                                              )}
                                              onClick={() => setCollapsed(task.id, !collapsed[task.id])}
                                            >
                                              <Icon
                                                name={collapsed[task.id] ? "chevron-right" : "chevron-down"}
                                                size="small"
                                                classList={{ "rtl:rotate-180": collapsed[task.id] }}
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
                                                item().ctx.data.session.remember(task)
                                                void startTransition(() =>
                                                  tabs.select(
                                                    tabs.addSessionTab({
                                                      server: item().server,
                                                      sessionId: task.id,
                                                    }),
                                                  ),
                                                ).then(navigated)
                                              }}
                                            >
                                              <bdi class="min-w-0 flex-1 truncate">
                                                {sessionTitle(task.title) ?? language.t("command.session.new")}
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
                                                <Menu.Item onSelect={() => void copySessionID(task.id)}>
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
                        )
                      }
                    }}
                  </For>
                  <Show when={items().length > shown().length}>
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

function worktreeLabel(directory: string, folders: string[]) {
  const parts = comparablePath(directory).split("/")
  const siblings = folders.filter((other) => other !== directory).map((path) => `/${comparablePath(path)}`)
  for (let depth = 1; depth < parts.length; depth++) {
    const suffix = parts.slice(-depth).join("/")
    if (!siblings.some((path) => path.endsWith(`/${suffix}`))) return suffix
  }
  return directory
}

function PullRequestLink(props: { ctx: ServerCtx; projectID: string; directory: string }) {
  const platform = usePlatform()
  const language = useLanguage()
  const key = () => [props.ctx.sdk.scope, "worktree-pr", props.projectID, props.directory]
  const query = useQuery(() => ({
    queryKey: key(),
    queryFn: ({ signal }) =>
      props.ctx.sdk.api.experimental.worktree.pullRequest(
        { projectID: props.projectID, directory: props.directory },
        { signal },
      ),
    enabled: props.ctx.sdk.connection.status() === "connected",
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  }))
  const client = useQueryClient()
  createEffect(() => {
    props.ctx.sdk.event.on("vcs.branch.updated", (event) => {
      if (event.location?.directory === props.directory) void client.invalidateQueries({ queryKey: key(), exact: true })
    })
  })
  const url = () => {
    const href = query.isSuccess && query.data.url
    return href && href.startsWith("https://") ? href : undefined
  }

  return (
    <Show when={url()}>
      {(href) => (
        <Tooltip
          placement={language.direction() === "rtl" ? "left" : "right"}
          value={<bdi dir="ltr">{href()}</bdi>}
          class="flex shrink-0"
        >
          <a
            href={href()}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`PR #${href().split("/").at(-1)}`}
            class="flex size-6 items-center justify-center rounded-[6px] text-v2-icon-icon-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
              event.preventDefault()
              platform.openExternal(href())
            }}
          >
            <Icon name="pull-request" />
          </a>
        </Tooltip>
      )}
    </Show>
  )
}
