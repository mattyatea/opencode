import { expect, test } from "bun:test"
import { pinnedFirst, sidebarTaskFolderKey, sidebarTaskRows } from "./sidebar-session-tree"

const session = (id: string, directory: string, taskParentID?: string) => ({
  id,
  location: { directory },
  experimental: taskParentID ? { taskParentID } : undefined,
})

const folders = ["/repo/.worktrees/feature-a", "/repo/.worktrees/feature-b", "/repo"]

const folderFor = (directory: string) => folders.find((root) => directory.startsWith(root)) ?? "/repo"

const root = session("root", "/repo")

const tasks = [
  session("same", "/repo/packages/app", "root"),
  session("a1", "/repo/.worktrees/feature-a", "root"),
  session("b1", "/repo/.worktrees/feature-b", "root"),
  session("a2", "/repo/.worktrees/feature-a/src", "root"),
  session("a1-child", "/repo/.worktrees/feature-a", "a1"),
  session("nested", "/repo/.worktrees/feature-b", "a1"),
  session("nested-child", "/repo/.worktrees/feature-b", "nested"),
]

const rendered = (collapsed: string[] = []) =>
  sidebarTaskRows({ root, tasks, folderFor, collapsed: (key) => collapsed.includes(key) }).map((row) =>
    row.type === "session"
      ? `${row.depth} ${row.session.id} (${row.children})`
      : `${row.depth} [${row.directory}] ${row.count}`,
  )

test("groups tasks by the worktree they run in, recursively, and keeps same-folder tasks under their parent", () => {
  expect(rendered()).toEqual([
    "1 same (0)",
    "1 [/repo/.worktrees/feature-a] 2",
    "2 a1 (2)",
    "3 a1-child (0)",
    "3 [/repo/.worktrees/feature-b] 1",
    "4 nested (1)",
    "5 nested-child (0)",
    "2 a2 (0)",
    "1 [/repo/.worktrees/feature-b] 1",
    "2 b1 (0)",
  ])
})

test("collapsing a folder or a session hides only its descendants", () => {
  expect(rendered([sidebarTaskFolderKey("root", "/repo/.worktrees/feature-a"), "b1"])).toEqual([
    "1 same (0)",
    "1 [/repo/.worktrees/feature-a] 2",
    "1 [/repo/.worktrees/feature-b] 1",
    "2 b1 (0)",
  ])
  expect(rendered(["a1"])).toContain("2 a2 (0)")
  expect(rendered(["a1"])).not.toContain("3 a1-child (0)")
})

test("a session without tasks has no rows, and each task appears once", () => {
  expect(sidebarTaskRows({ root, tasks: [], folderFor, collapsed: () => false })).toEqual([])

  const ids = sidebarTaskRows({ root, tasks: [root, ...tasks], folderFor, collapsed: () => false }).flatMap((row) =>
    row.type === "session" ? [row.session.id] : [],
  )

  expect(ids.toSorted()).toEqual(tasks.map((task) => task.id).toSorted())
})

test("pinned sessions lead in pin order and the rest keep their order", () => {
  const sessions = ["a", "b", "c", "d", "e"].map((id) => ({ id }))

  expect(pinnedFirst(sessions, ["d", "missing", "b"]).map((item) => item.id)).toEqual(["d", "b", "a", "c", "e"])
  expect(pinnedFirst(sessions, []).map((item) => item.id)).toEqual(["a", "b", "c", "d", "e"])
})
