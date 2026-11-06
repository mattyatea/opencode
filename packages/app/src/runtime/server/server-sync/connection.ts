import { createEffect, type Accessor } from "solid-js"
import type { ServerConnectionStatus } from "../client"

export function createConnectionSync(input: {
  status: Accessor<ServerConnectionStatus>
  invalidate: () => void
  connected: (info: { reconnect: boolean }) => void
}) {
  createEffect(() => {
    if (input.status() === "connected") return
    input.invalidate()
  })

  let connectedOnce = false

  function handleEvent(event: { type: string }) {
    if (event.type !== "server.connected") return
    input.connected({ reconnect: connectedOnce })
    connectedOnce = true
  }

  return { handleEvent }
}

// Syncing a directory boots its server Location, so a reconnect refreshes only what a mounted view holds. The rest
// are released to bootstrap on their next access; refreshing them would wake every Location the server had evicted.
export function reconnectPlan(directories: string[], held: (directory: string) => boolean) {
  return {
    refresh: directories.filter(held),
    release: directories.filter((directory) => !held(directory)),
  }
}
