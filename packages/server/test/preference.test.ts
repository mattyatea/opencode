import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("shares a client setting through the server and keeps it per key", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-preference-api-")).path
    const global = path.join(dir, "global")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))

    const handler = yield* ServerFetch.make({
      app: { version: "test" },
      database: { path: path.join(dir, "opencode.db") },
      config: { directory: global, project: false, claude: false },
      models: { fetch: false },
      fs: { filewatcher: false },
    })
    const api = OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
        preconnect: fetch.preconnect,
      }),
    })

    yield* Effect.promise(async () => {
      expect(await api.experimental.preference.get({ key: "model" })).toBeNull()

      await api.experimental.preference.set({
        key: "model",
        value: { favorite: [{ providerID: "openai", modelID: "gpt" }] },
      })
      await api.experimental.preference.set({ key: "sidebar.view", value: { grouping: "date" } })

      expect(await api.experimental.preference.get({ key: "model" })).toEqual({
        favorite: [{ providerID: "openai", modelID: "gpt" }],
      })
      expect(await api.experimental.preference.get({ key: "sidebar.view" })).toEqual({ grouping: "date" })

      await api.experimental.preference.set({ key: "model", value: { favorite: [] } })
      expect(await api.experimental.preference.get({ key: "model" })).toEqual({ favorite: [] })
    })
  }),
)
