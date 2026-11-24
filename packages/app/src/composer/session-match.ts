import type { SessionInfo } from "@opencode/client/promise"
import { Session } from "@opencode/schema/session"
import { displayName } from "@opencode/ui/project-avatar"
import { getFilename } from "@opencode/util/path"
import { parseSessionMention } from "@opencode/util/session-mention"
import type { Project } from "@/runtime/server/types"
import { projectForSession } from "@/shell/layout/helpers"
import type { ComposerSuggestion } from "./types"

/** `sessions` is the server source's merged list, newest first. Keep at most five matches, stable within each rank. */
export function sessionMentionSuggestions(
  sessions: readonly SessionInfo[],
  query: string,
  context: {
    current?: string
    project?: string
    directory: string
    projects: Project[]
    open: ReadonlySet<string>
    untitled: string
  },
): ComposerSuggestion[] {
  const match = createSessionTitleRanker(query)
  const projects = new Set(context.projects.map((project) => project.id))
  const best: { session: SessionInfo; id: string; score: number }[] = []

  for (const session of sessions) {
    if (session.id === context.current || session.time.archived) continue
    const rank = query ? match(session.title || context.untitled) : 0

    if (rank === undefined) continue

    // If the ID has no project record, the directory/sandbox fallback can still identify a local session.
    const local =
      !context.project ||
      session.location.directory === context.directory ||
      (projects.has(session.projectID)
        ? session.projectID === context.project
        : projectForSession(session, context.projects)?.id === context.project)

    if (!query && !local) continue
    const mention = parseSessionMention(session.id)

    if (!mention) continue

    // Local first, then title match (exact / leading / later word), then open tabs. A tie keeps source recency.
    const score = (local ? 0 : 6) + rank * 2 + Number(!context.open.has(mention.id))

    if (best.length === 5 && score >= best[4]!.score) continue
    const index = best.findIndex((item) => score < item.score)
    best.splice(index < 0 ? best.length : index, 0, { session, id: mention.id, score })

    if (best.length > 5) best.pop()

    if (best.length === 5 && best[4]!.score === 0) break
  }

  return best.map(({ session, id }) => {
    const title = session.title || context.untitled
    const project = projectForSession(session, context.projects)

    return {
      id: `session:${id}`,
      kind: "session",
      label: title,
      description: project ? displayName(project) : getFilename(session.location.directory),
      mention: { type: "session", id: Session.ID.make(id), content: `@${title}`, start: 0, end: 0 },
    }
  })
}

/**
 * Ranks a title against a typed query: 0 for the exact title, 1 when the title starts with the query, 2 when a later
 * title word does, and undefined otherwise. Each query word must start consecutive title words, case-insensitively.
 * A trailing space asks for one more title word, so `@HOME ` stops matching "HOME" and the popover gives way to prose.
 */
export function createSessionTitleRanker(query: string) {
  const text = query.toLowerCase()
  const words = text.split(" ")

  return (title: string) => {
    const value = title.toLowerCase()

    if (value === text) return 0

    if (!value.includes(words[0]!)) return
    const titleWords = value.split(/\s+/).filter(Boolean)

    const start = titleWords.findIndex((_, start) =>
      words.every((word, index) => titleWords[start + index]?.startsWith(word)),
    )

    if (start < 0) return

    return start === 0 ? 1 : 2
  }
}
