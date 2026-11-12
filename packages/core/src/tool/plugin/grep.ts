export * as GrepTool from "./grep.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai/effect"
import { Effect, Schema } from "effect"
import path from "path"
import { Environment } from "../../environment/index.js"
import { FileSystem } from "../../filesystem.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"
import { Ripgrep } from "../../ripgrep.js"
import { NonNegativeInt, RelativePath } from "../../schema.js"
import { ToolSearch } from "../search.js"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern
    .check(Schema.isMinLength(1, { message: "Pattern must not be empty" }))
    .annotate({
      description: "Regular expression or literal text to match in file contents.",
    }),
  path: Schema.optionalKey(RelativePath).annotate({
    description: "File or directory to search. Defaults to the current working directory.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")',
  }),
  literal: FileSystem.GrepInput.fields.literal.annotate({
    description: "Treat `pattern` as exact text instead of a regular expression (default: false).",
  }),
  caseSensitive: FileSystem.GrepInput.fields.caseSensitive.annotate({
    description: "Use case-sensitive matching (default: true).",
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum matching lines, or files with output="files" (default: ${FileSystem.DEFAULT_SEARCH_LIMIT}). Context output is additionally capped at 1,000 total lines and 200,000 preview characters.`,
  }),
  context: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(20))).annotate({
    description:
      'Neighboring lines before and after each match (0–20, default: 0). Overlapping context is merged. Ignored with output="files".',
  }),
  output: Schema.optionalKey(Schema.Literals(["content", "files"])).annotate({
    description:
      'Use "content" (default) for code or values; use "files" only to locate distinct matching file paths, without their contents.',
  }),
})

export const Output = Schema.Array(
  Schema.Union([
    Schema.Struct({ ...FileSystem.Match.fields, context: Schema.optionalKey(Schema.Boolean) }),
    FileSystem.Entry,
  ]),
)
type EncodedOutput = typeof Output.Encoded

/** Format raw search matches into concise model content. */
export const toModelContent = (matches: EncodedOutput, truncated = false) => {
  const count = matches.filter((match) => !("context" in match && match.context)).length
  const lines =
    matches.length === 0
      ? ["No matches found"]
      : matches.some((match) => "entry" in match)
        ? [`Found ${count} matches`]
        : []
  let current = ""
  for (const match of matches) {
    if (!("entry" in match)) {
      lines.push(match.path)
      continue
    }
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  ${match.context ? "Context" : "Line"} ${match.line}: ${match.text}`)
  }
  if (truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${count} results. Consider using a more specific path or pattern.)`,
    )
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const Plugin = {
  id: "opencode.tool.grep",
  effect: Effect.fn("GrepTool.Plugin")(function* (ctx: Context) {
    const environment = yield* Environment.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false, readOnly: true },
          description:
            'Search file contents with ripgrep regex or literal text; reuse known owner paths via `path`/`include`, widen scope if needed, and match declaration syntax—not references/imports—when locating definitions. Use output="files" only to locate files, not matched code or nearby values; use default content with `context` for local facts, and read the file for larger bodies.',
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const target = yield* access.resolve({ path: input.path ?? "." })
              yield* access.authorizeExternal([target], context)
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  literal: input.literal,
                  caseSensitive: input.caseSensitive,
                  limit: input.limit,
                  context: input.context,
                  output: input.output,
                },
                ...Permission.invocation(context),
              })
              const root = target.absolute
              const type = yield* ToolSearch.pathType(environment.files, root, input.path ?? ".")
              const cwd = type === "directory" ? root : path.dirname(root)
              const search = {
                cwd,
                pattern: input.pattern,
                file: type === "file" ? path.basename(root) : undefined,
                include: input.include,
                literal: input.literal,
                caseSensitive: input.caseSensitive,
                limit: input.limit ?? FileSystem.DEFAULT_SEARCH_LIMIT,
              }
              const result =
                input.output === "files"
                  ? yield* ToolSearch.bounded(search.limit, (limit) => ripgrep.grepFiles({ ...search, limit })).pipe(
                      Effect.map((result) => ({
                        ...result,
                        items: result.items.map((entry) => ({
                          ...entry,
                          path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                        })),
                      })),
                    )
                  : input.context
                    ? yield* ripgrep.grepContext({ ...search, context: input.context }).pipe(
                        Effect.timeoutOrElse({
                          duration: FileSystem.DEFAULT_SEARCH_TIMEOUT_MS,
                          orElse: () =>
                            Effect.fail(
                              new ToolFailure({
                                message: "Search timed out. Consider using a more specific path or pattern.",
                              }),
                            ),
                        }),
                      )
                    : yield* ToolSearch.bounded(search.limit, (limit) => ripgrep.grep({ ...search, limit }))
              return {
                matches: result.items.map((match) =>
                  !("entry" in match)
                    ? match
                    : {
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(
                            path.relative(location.directory, path.resolve(cwd, match.entry.path)),
                          ),
                        }),
                      },
                ),
                truncated: result.truncated,
              }
            }).pipe(
              Effect.map((result) => ({
                output: result.matches,
                content: toModelContent(
                  result.matches.map((match) => ({
                    ...match,
                    ...("entry" in match
                      ? { entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) } }
                      : { path: path.resolve(location.directory, match.path) }),
                  })),
                  result.truncated,
                ),
                metadata: {
                  matches: result.matches.filter((match) => !("context" in match && match.context)).length,
                  truncated: result.truncated,
                },
              })),
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : error instanceof Ripgrep.InvalidPatternError
                    ? new ToolFailure({ message: `Invalid regex pattern: ${error.message}` })
                    : new ToolFailure({ message: `Unable to grep for ${input.pattern}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
