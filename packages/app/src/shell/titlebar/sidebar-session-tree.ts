type TreeSession = {
  id: string
  location: { directory: string }
  experimental?: { taskParentID?: string }
}

export type SidebarTreeRow<T> =
  | { type: "session"; key: string; session: T; depth: number; children: number }
  | { type: "folder"; key: string; directory: string; depth: number; count: number }

/**
 * The rows nested under one root session: its persistent tasks by `taskParentID`. Tasks that run in a different
 * worktree folder than their parent are grouped under a folder row for that worktree, so the tree reads orchestrator
 * -> worktree -> sessions, recursively. Tasks in the parent's own folder stay directly under it. A collapsed session
 * id or folder key hides that node's descendants.
 */
export function sidebarTaskRows<T extends TreeSession>(input: {
  root: TreeSession
  tasks: readonly T[]
  folderFor: (directory: string) => string
  collapsed: (key: string) => boolean
}): SidebarTreeRow<T>[] {
  const children = Map.groupBy(
    input.tasks.filter((task) => task.id !== input.root.id),
    (task) => task.experimental?.taskParentID,
  )

  const node = (session: T, depth: number): SidebarTreeRow<T>[] => [
    { type: "session", key: session.id, session, depth, children: children.get(session.id)?.length ?? 0 },
    ...(input.collapsed(session.id) ? [] : walk(session, depth + 1)),
  ]

  const walk = (parent: TreeSession, depth: number): SidebarTreeRow<T>[] => {
    const home = input.folderFor(parent.location.directory)
    const groups = Map.groupBy(children.get(parent.id) ?? [], (task) => input.folderFor(task.location.directory))

    return [
      ...(groups.get(home) ?? []).flatMap((task) => node(task, depth)),
      ...[...groups].flatMap(([directory, tasks]): SidebarTreeRow<T>[] => {
        if (directory === home) return []
        const key = sidebarTaskFolderKey(parent.id, directory)

        return [
          { type: "folder", key, directory, depth, count: tasks.length },
          ...(input.collapsed(key) ? [] : tasks.flatMap((task) => node(task, depth + 1))),
        ]
      }),
    ]
  }

  return walk(input.root, 1)
}

export function sidebarTaskFolderKey(parentID: string, directory: string) {
  return `folder:${parentID}:${directory}`
}

/** Pinned sessions first, in pin order; the others keep their relative order. */
export function pinnedFirst<T extends { id: string }>(sessions: readonly T[], pins: readonly string[]) {
  const rank = new Map(pins.map((id, index) => [id, index]))

  return sessions.toSorted((a, b) => (rank.get(a.id) ?? rank.size) - (rank.get(b.id) ?? rank.size))
}
