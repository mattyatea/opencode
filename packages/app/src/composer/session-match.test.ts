import { expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client/promise"
import type { Project } from "@/runtime/server/types"
import { createSessionTitleRanker, sessionMentionSuggestions } from "./session-match"

test.each([
  { title: "OPENCODE CONSOLE", query: "open con", rank: 1 },
  { title: "OPENCODE CONSOLE", query: "OPENCODE CONSOLE", rank: 0 },
  { title: "OPENCODE CONSOLE", query: "opencode console", rank: 0 },
  { title: "OPENCODE CONSOLE", query: "console", rank: 2 },
  { title: "OPENCODE CONSOLE", query: "OPENCODE CONSOLE ", rank: undefined },
  { title: "OPENCODE CONSOLE", query: "OPENCODE CONSOLE on", rank: undefined },
  { title: "HOME", query: "HOME ", rank: undefined },
  { title: "HOME", query: "home", rank: 0 },
  { title: "Home office", query: "home", rank: 1 },
  { title: "Back home", query: "home", rank: 2 },
  { title: "foobar", query: "foo bar", rank: undefined },
  { title: "foo bar", query: "foo bar", rank: 0 },
  { title: "console", query: "sole", rank: undefined },
])("$query against $title: $rank", (row) => {
  expect(createSessionTitleRanker(row.query)(row.title)).toBe(row.rank)
})

test("ranks all known sessions before taking five and keeps bare @ local", () => {
  const project = (id: string): Project => ({
    id,
    worktree: `/${id}`,
    worktrees: [],
    sandboxes: [`/sandbox/${id}`],
    time: { created: 1, updated: 1, active: 1 },
  })
  const session = (i: number, title: string, projectID: string): SessionInfo => ({
    id: `ses_${i.toString().padStart(26, "0")}`,
    title,
    projectID,
    location: { directory: `/${projectID}` },
    time: { created: 0, updated: 100 - i },
    agent: "build",
    model: { id: "model", providerID: "provider" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const current = session(0, "foo", "a")
  const remote = session(1, "foo", "b")
  const recent = session(2, "Foo Bar", "a")
  const older = session(3, "Foo Another", "a")
  const late = session(90, "Foo", "unmapped")
  late.location.directory = "/sandbox/a"
  const sessions = [
    current,
    remote,
    recent,
    older,
    ...Array.from({ length: 60 }, (_, i) => session(4 + i, "Foo Later", "b")),
    late,
    { ...late, id: "invalid" },
  ]
  const context = {
    current: current.id,
    project: "a",
    directory: "/a",
    projects: [project("a"), project("b")],
    open: new Set([older.id]),
    untitled: "Untitled",
  }

  expect(sessionMentionSuggestions(sessions, "foo", context).map((item) => item.id)).toEqual(
    [late, older, recent, remote, sessions[4]!].map((row) => `session:${row.id}`),
  )
  expect(sessionMentionSuggestions(sessions, "", context).map((item) => [item.label, item.description])).toEqual([
    ["Foo Another", "a"],
    ["Foo Bar", "a"],
    ["Foo", "a"],
  ])
})
