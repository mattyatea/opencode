export * as CodeModeTools from "./codemode.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { Effect, Schema } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { GlobTool } from "./glob.js"
import { GrepTool } from "./grep.js"

const names = ["read", "grep", "glob", "shell", "webfetch", "websearch"]

export const Plugin = {
  id: "opencode.tool.codemode",
  effect: Effect.fn("CodeModeTools.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())

    yield* ctx.tool
      .transform((editor) => {
        if (Config.latest(loaded.entries, "experimental")?.codemode_tools !== true) return
        for (const name of names) {
          const tool = editor.get(name)
          if (!tool) continue
          editor.update(name, (current) => {
            current.options = { ...current.options, codemode: true, pinned: true }
            // Search truncation otherwise exists only in model content/metadata, which
            // Code Mode deliberately does not return alongside the machine output.
            if (name !== "grep" && name !== "glob") return
            current.output = Schema.Struct({
              items: name === "grep" ? GrepTool.Output : GlobTool.Output,
              truncated: Schema.Boolean,
            })
            current.execute = (input, context) =>
              tool.execute(input, context).pipe(
                Effect.map((result) => ({
                  ...result,
                  output: { items: result.output, truncated: result.metadata?.truncated === true },
                })),
              )
          })
        }
      })
      .pipe(Effect.orDie)
  }),
}
