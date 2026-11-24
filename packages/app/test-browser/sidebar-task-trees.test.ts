import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createOpenCodeEventSource } from "@/runtime/server/client"
import { createSidebarTaskChanges, createSidebarTaskTree } from "@/shell/titlebar/sidebar-task-trees"

function created(sessionID: string, taskParentID?: string) {
  return {
    id: `evt_${sessionID}`,
    created: 1,
    durable: { aggregateID: sessionID, seq: 1, version: 1 as const },
    type: "session.created" as const,
    data: {
      sessionID,
      taskParentID,
      projectID: "project",
      location: { directory: "/p" },
      slug: sessionID,
      version: "1",
    },
  }
}

test("a change received before the tree loads refreshes only its family, including archived parents", async () => {
  const snapshot = Promise.withResolvers<{ id: string; archived?: number }[]>()
  const calls: string[] = []
  const root = createRoot((dispose) => {
    const server = createOpenCodeEventSource()
    const other = createOpenCodeEventSource()
    const changes = createSidebarTaskChanges(() => [server.event, other.event])
    const [source, swap] = createSignal(server.event)
    const family = createSidebarTaskTree(source, changes, () => {
      calls.push("family")
      return snapshot.promise
    })
    createSidebarTaskTree(
      () => server.event,
      changes,
      async () => {
        calls.push("unrelated")
        return [{ id: "unrelated" }]
      },
    )
    return { server, other, family, swap, dispose }
  })
  try {
    root.server.publish(created("grandchild", "child"))
    root.server.publish(created("second-grandchild", "child"))
    root.server.publish(created("standalone"))
    snapshot.resolve([{ id: "family" }, { id: "child", archived: 1 }])
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(calls).toEqual(["family", "unrelated", "family"])
    expect(root.family().tree.state).toBe("ready")

    const detach = { ...created("child"), type: "session.task.detached" as const, data: { sessionID: "child" } }
    root.other.publish(detach)
    expect(calls).toHaveLength(3)
    root.server.publish(detach)
    expect(calls).toEqual(["family", "unrelated", "family", "family"])
    root.swap(root.other.event)
    expect(calls).toHaveLength(5)
    await new Promise<void>((resolve) => setImmediate(resolve))
    root.server.publish(detach)
    expect(calls).toHaveLength(5)
    root.other.publish(detach)
    expect(calls).toHaveLength(6)
  } finally {
    root.dispose()
  }
})
