export * as ConfigCompactionPlugin from "./compaction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Flag } from "../../flag.js"
import { SessionCompaction } from "../../session/compaction.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "opencode.config.compaction",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const compaction = yield* SessionCompaction.Service
    const flags = yield* Flag.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, compaction.reload())
    yield* compaction.transform((editor) => {
      editor.configure({
        precompute: flags.resolve(loaded.entries).background_compaction.enabled,
        // Opt-in only: in one measured session it cut the largest request from ~121k to ~25k tokens, but sent more
        // uncached input, ran slower, and kept fewer exact details (mattyatea/opencode#3).
        limit: Config.latest(loaded.entries, "experimental")?.short_context_compaction === true ? 48_000 : undefined,
      })
      for (const entry of loaded.entries) {
        if (entry.type !== "document" || !entry.info.compaction) continue
        editor.configure({
          ...(entry.info.compaction.auto === undefined ? {} : { auto: entry.info.compaction.auto }),
          ...(entry.info.compaction.buffer === undefined ? {} : { buffer: entry.info.compaction.buffer }),
          ...(entry.info.compaction.keep?.tokens === undefined ? {} : { keep: entry.info.compaction.keep.tokens }),
        })
      }
    })
  }),
})
