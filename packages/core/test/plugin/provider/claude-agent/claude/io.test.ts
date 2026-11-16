import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { ClaudeIO } from "@opencode/core/plugin/provider/claude-agent/claude/io"
import { withEnv } from "../../../../fixture/env"
import { tmpdirScoped } from "../../../../fixture/tmpdir"
import { it } from "../../../../lib/effect"

describe("Claude executable discovery", () => {
  it.live("uses the server PATH or an explicit executable without checking login", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const bin = path.join(tmp.path, "bin")
      const executable = path.join(bin, process.platform === "win32" ? "claude.cmd" : "claude")
      yield* Effect.promise(async () => {
        await fs.mkdir(bin)
        await Bun.write(executable, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n")
        if (process.platform !== "win32") await fs.chmod(executable, 0o755)
      })
      yield* withEnv({ OPENCODE_CLAUDE_PATH: undefined, PATH: path.join(tmp.path, "missing") }, () =>
        Effect.gen(function* () {
          expect(ClaudeIO.real.which()).toBeUndefined()
          yield* withEnv({ PATH: bin }, () => Effect.sync(() => expect(ClaudeIO.real.which()).toBe(executable)))
          yield* withEnv({ OPENCODE_CLAUDE_PATH: executable }, () =>
            Effect.sync(() => expect(ClaudeIO.real.which()).toBe(executable)),
          )
        }),
      )
    }),
  )
})
