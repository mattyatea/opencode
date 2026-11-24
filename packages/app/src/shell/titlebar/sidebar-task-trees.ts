import { createEventBus } from "@solid-primitives/event-bus"
import { createEffect, createMemo, createResource, on } from "solid-js"
import type { OpenCodeEventStream } from "@/runtime/server/client"

export function createSidebarTaskChanges(sources: () => OpenCodeEventStream[]) {
  const changes = createEventBus<{ source: OpenCodeEventStream; id?: string }>()
  createEffect(() => {
    for (const source of sources()) {
      const changed = (event: { data: { sessionID: string } }) => changes.emit({ source, id: event.data.sessionID })
      source.on("session.created", (event) => {
        if (event.data.taskParentID) changes.emit({ source, id: event.data.taskParentID })
      })
      source.on("session.renamed", changed)
      source.on("session.deleted", changed)
      source.on("session.archived", changed)
      source.on("session.unarchived", changed)
      source.on("session.task.detached", changed)
      // A new feed does not replay changes missed while disconnected.
      source.on("server.connected", () => changes.emit({ source }))
    }
  })
  return changes
}

export function createSidebarTaskTree<T extends { id: string }>(
  source: () => OpenCodeEventStream,
  changes: ReturnType<typeof createSidebarTaskChanges>,
  load: () => Promise<T[]>,
) {
  // A controller replacement keeps the same sidebar row but starts a new event stream and snapshot.
  const stream = createMemo(source)
  return createMemo(
    on(stream, (current) => {
      const [tree, controls] = createResource(async () => {
        const tasks = await load()
        return { tasks, ids: new Set(tasks.map((task) => task.id)) }
      })

      // A change can arrive before the first snapshot tells us which family it affects.
      const pending = new Set<string | undefined>()
      const affects = (id?: string) => id === undefined || tree.state !== "ready" || tree.latest.ids.has(id)
      changes.listen((change) => {
        if (change.source !== current) return
        if (tree.loading) return void pending.add(change.id)
        if (affects(change.id)) void controls.refetch()
      })
      createEffect(() => {
        if (tree.loading || !pending.size) return
        const refresh = Array.from(pending).some(affects)
        pending.clear()
        if (refresh) void controls.refetch()
      })
      return { tree, refresh: controls.refetch }
    }),
  )
}
