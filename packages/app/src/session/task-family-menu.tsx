import { createMemo, createResource, For, onCleanup, Show, startTransition } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"
import { useTabs } from "@/shell/tabs/tabs"
import { sessionTitle } from "./title"

export function TaskFamilyMenu(props: { sessionID: string; active: boolean }) {
  const server = useServer()
  const tabs = useTabs()
  const language = useLanguage()
  const [tree, controls] = createResource(
    () => (props.active ? props.sessionID : undefined),
    async (sessionID) => ({
      sessionID,
      tasks: await server.ctx.sdk.api.experimental.session.tasks.tree({ sessionID }),
    }),
  )
  const tasks = () => {
    if (tree.state !== "ready" && tree.state !== "refreshing") return []
    if (tree.latest?.sessionID !== props.sessionID) return []
    return tree.latest.tasks
  }
  const rows = createMemo(() => {
    const children = Map.groupBy(tasks(), (task) => task.experimental?.taskParentID)
    const ids = new Set(tasks().map((task) => task.id))
    const walk = (items: SessionInfo[], depth: number): Array<{ task: SessionInfo; depth: number }> =>
      items.flatMap((task) => [{ task, depth }, ...walk(children.get(task.id) ?? [], depth + 1)])
    return walk(tasks().filter((task) => !task.experimental?.taskParentID || !ids.has(task.experimental.taskParentID)), 0)
  })

  onCleanup(
    server.ctx.sdk.event.listen((event) => {
      if (!props.active) return
      if (
        event.type === "session.created" ||
        event.type === "session.deleted" ||
        event.type === "session.task.detached" ||
        event.type === "session.renamed" ||
        event.type === "session.archived" ||
        event.type === "session.unarchived"
      )
        void controls.refetch()
    }),
  )

  return (
    <Show when={rows().length > 1 || tree.error}>
      <Menu placement="bottom-start" gutter={4}>
        <Menu.Trigger
          as={IconButton}
          icon={<Icon name="branch" />}
          variant="ghost-muted"
          size="small"
          aria-label={language.t("tasks.tree")}
        />
        <Menu.Portal>
          <Menu.Content aria-label={language.t("tasks.tree")} class="max-h-[60vh] overflow-y-auto" data-scrollable>
            <Show when={tree.error}>
              <Menu.Item onSelect={() => void controls.refetch()}>{language.t("tasks.refresh")}</Menu.Item>
            </Show>
            <For each={rows()}>
              {(row) => (
                <Menu.Item
                  aria-current={row.task.id === props.sessionID ? "page" : undefined}
                  style={{ "padding-inline-start": `${12 + row.depth * 16}px` }}
                  onSelect={() => {
                    server.ctx.data.session.remember(row.task)
                    void startTransition(() =>
                      tabs.select(tabs.addSessionTab({ server: server.key, sessionId: row.task.id })),
                    )
                  }}
                >
                  <bdi class="truncate">{sessionTitle(row.task.title) ?? language.t("tasks.untitled")}</bdi>
                </Menu.Item>
              )}
            </For>
          </Menu.Content>
        </Menu.Portal>
      </Menu>
    </Show>
  )
}
