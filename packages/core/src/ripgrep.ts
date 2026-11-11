export * as Ripgrep from "./ripgrep.js"

import { Context, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { Entry, Match } from "@opencode/schema/filesystem"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { collectStream, waitForAbort } from "@opencode/util/process"
import { Environment } from "./environment/index.js"
import { NonNegativeInt, PositiveInt, RelativePath } from "./schema.js"
import { RipgrepBinary } from "./ripgrep/binary.js"

/**
 * Small core-owned ripgrep execution adapter. It deliberately exposes raw
 * process-oriented rows, not model text or permission behavior. Search maps
 * these rows into filesystem results; leaf tools own
 * presentation and permission prompts.
 */

const ERROR_BYTES = 8 * 1024
const MAX_SUBMATCHES = 100
const MAX_LINE_CHARS = 2_000
const MAX_CONTEXT_LINES = 1_000
const MAX_CONTEXT_CHARS = 200_000

const RawMatch = Schema.Struct({
  type: Schema.Literals(["match", "context"]),
  data: Schema.Struct({
    path: Schema.Struct({ text: Schema.String }),
    lines: Schema.Struct({ text: Schema.String }),
    line_number: PositiveInt,
    absolute_offset: NonNegativeInt,
    submatches: Schema.Array(
      Schema.Struct({
        match: Schema.Struct({ text: Schema.String }),
        start: NonNegativeInt,
        end: NonNegativeInt,
      }),
    ),
  }),
})
const decodeJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

type RawMatchData = (typeof RawMatch.Type)["data"]

export type ContextMatch = Match & { readonly context?: boolean }

export class Error extends Schema.TaggedError<Error>()("Ripgrep.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export class InvalidPatternError extends Schema.TaggedError<InvalidPatternError>()("Ripgrep.InvalidPatternError", {
  pattern: Schema.String,
  message: Schema.String,
}) {}

export interface FindInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly exclude?: readonly string[]
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
  readonly onEntry?: (entry: Entry) => Effect.Effect<void>
}

export interface GlobInput {
  readonly cwd: string
  readonly pattern: string
  readonly limit: number
  readonly hidden?: boolean
  readonly follow?: boolean
  readonly signal?: AbortSignal
}

export interface GrepInput {
  readonly cwd: string
  readonly pattern: string
  readonly file?: string
  readonly include?: string
  readonly literal?: boolean
  readonly caseSensitive?: boolean
  readonly limit: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly find: (input: FindInput) => Effect.Effect<readonly Entry[], Error>
  readonly glob: (input: GlobInput) => Effect.Effect<readonly Entry[], Error>
  readonly grep: (input: GrepInput) => Effect.Effect<readonly Match[], Error | InvalidPatternError>
  readonly grepContext: (
    input: GrepInput & { readonly context: number },
  ) => Effect.Effect<
    { readonly items: readonly ContextMatch[]; readonly truncated: boolean },
    Error | InvalidPatternError
  >
  readonly grepFiles: (input: GrepInput) => Effect.Effect<readonly Entry[], Error | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Ripgrep") {}

const failure = (message: string, cause?: unknown) => new Error({ message, cause })

const normalizePath = (value: string) =>
  value
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/")

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const environment = yield* Environment.Service
    const binary = yield* RipgrepBinary.Service

    const run = <A>(input: {
      readonly cwd: string
      readonly args: string[]
      readonly limit: number
      readonly signal?: AbortSignal
      readonly parse: (line: string) => Effect.Effect<A | undefined, Error>
      readonly pattern?: string
      readonly onItem?: (item: A) => Effect.Effect<void>
      readonly stop?: (item: A) => boolean
    }) => {
      const program = Effect.scoped(
        Effect.gen(function* () {
          // Hosted environments will resolve rg through their driver image; the spawner is the execution seam.
          const handle = yield* environment.spawner.spawn(
            ChildProcess.make(yield* binary.filepath, input.args, { cwd: input.cwd, extendEnv: true, stdin: "ignore" }),
          )
          const stderrFiber = yield* collectStream(handle.stderr, ERROR_BYTES).pipe(
            Effect.map((output) => output.buffer.toString("utf8")),
            Effect.forkScoped,
          )
          let observed = 0
          let stopped = false
          const rows = yield* Stream.decodeText(handle.stdout).pipe(
            Stream.splitLines,
            Stream.filter((line) => line.length > 0),
            Stream.mapEffect(input.parse),
            Stream.filter((row): row is A => row !== undefined),
            Stream.tap((row) => {
              if (!input.onItem || observed++ >= input.limit) return Effect.void
              return input.onItem(row)
            }),
            Stream.takeUntil((row) => {
              stopped = input.stop?.(row) ?? false
              return stopped
            }),
            Stream.take(input.limit + 1),
            Stream.runCollect,
          )
          const truncated = rows.length > input.limit
          if (truncated) return rows.slice(0, input.limit)
          if (stopped) return rows

          const code = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          if (input.pattern && code === 2 && isInvalidPattern(stderr)) {
            return yield* new InvalidPatternError({ pattern: input.pattern, message: stderr.trim() })
          }
          if (code !== 0 && code !== 1 && code !== 2) {
            return yield* failure(stderr.trim() || `ripgrep failed with code ${code}`)
          }
          return code === 1 ? [] : rows
        }),
      )
      const abortable = input.signal ? program.pipe(Effect.raceFirst(waitForAbort(input.signal))) : program
      return abortable.pipe(
        Effect.mapError((cause) =>
          cause instanceof Error || cause instanceof InvalidPatternError
            ? cause
            : failure("ripgrep execution failed", cause),
        ),
      )
    }

    const grepArgs = (input: GrepInput) => [
      "--no-config",
      "--hidden",
      "--no-messages",
      ...(input.literal ? ["--fixed-strings"] : []),
      ...(input.caseSensitive === false ? ["--ignore-case"] : []),
      ...(input.include ? [`--glob=${input.include}`] : []),
      "--glob=!**/.git/**",
      "--",
      input.pattern,
      input.file ?? ".",
    ]

    const grep = Effect.fn("Ripgrep.grep")(function* (input: GrepInput & { readonly context?: number }) {
      const context = Math.max(0, Math.min(20, input.context ?? 0))
      let count = 0
      let size = 0
      return yield* run<RawMatchData & { context: boolean }>({
        ...input,
        // Context has an independent hard bound, including the lookahead row.
        limit: context ? MAX_CONTEXT_LINES + 1 : input.limit,
        stop: context
          ? (row) => {
              size +=
                row.lines.text.length +
                row.path.text.length +
                100 +
                row.submatches.reduce((sum, match) => sum + match.match.text.length + 100, 0)
              return size > MAX_CONTEXT_CHARS || (!row.context && ++count > input.limit)
            }
          : undefined,
        args: ["--json", ...(context ? [`--context=${context}`] : []), ...grepArgs(input)],
        parse: (line) =>
          decodeJsonRecord(line).pipe(
            Effect.mapError((cause) => failure("Invalid ripgrep JSON output", cause)),
            Effect.flatMap((json) => {
              if (
                !json ||
                typeof json !== "object" ||
                !("type" in json) ||
                (json.type !== "match" && (json.type !== "context" || !context))
              )
                return Effect.undefined
              return Schema.decodeUnknownEffect(RawMatch)(json).pipe(
                Effect.map((match) => ({
                  ...match.data,
                  context: match.type === "context",
                  lines: {
                    text:
                      match.data.lines.text.length > MAX_LINE_CHARS
                        ? Buffer.from(match.data.lines.text.slice(0, MAX_LINE_CHARS), "utf8").toString() + "..."
                        : match.data.lines.text,
                  },
                  path: { text: normalizePath(match.data.path.text) },
                  submatches: match.data.submatches.slice(0, MAX_SUBMATCHES).map((submatch) =>
                    context
                      ? {
                          ...submatch,
                          // Keep offsets, but do not repeat unbounded text outside the preview.
                          match: { text: submatch.match.text.slice(0, Math.max(0, MAX_LINE_CHARS - submatch.start)) },
                        }
                      : submatch,
                  ),
                })),
                Effect.mapError((cause) => failure("Invalid ripgrep match output", cause)),
              )
            }),
          ),
      }).pipe(
        Effect.map((rows) => {
          let matched = 0
          const bounded = size > MAX_CONTEXT_CHARS ? rows.slice(0, -1) : rows
          const items = bounded
            .slice(0, context ? MAX_CONTEXT_LINES : input.limit)
            .filter((row) => {
              if (!row.context) matched++
              return matched <= input.limit
            })
            .map((row) => ({
              ...Match.make({
                entry: Entry.make({ path: RelativePath.make(row.path.text), type: "file" }),
                line: row.line_number,
                offset: row.absolute_offset,
                text: row.lines.text,
                submatches: row.submatches.map((submatch) => ({
                  text: submatch.match.text,
                  start: submatch.start,
                  end: submatch.end,
                })),
              }),
              ...(context ? { context: row.context } : {}),
            }))
          // Before-context for the lookahead match must not leak unrelated lines.
          const matches = items.filter((row) => !row.context)
          return {
            items: context
              ? items.filter(
                  (row) =>
                    !row.context ||
                    matches.some(
                      (match) => match.entry.path === row.entry.path && Math.abs(match.line - row.line) <= context,
                    ),
                )
              : items,
            truncated:
              matched > input.limit || (context > 0 && (rows.length > MAX_CONTEXT_LINES || size > MAX_CONTEXT_CHARS)),
          }
        }),
      )
    })

    return Service.of({
      glob: (input) =>
        run<string>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            `--glob=${input.pattern}`,
            // Positive globs override rg's hidden-file filter; exclude before applying the result limit.
            ...(input.hidden ? [] : ["--glob=!**/.*"]),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => Effect.succeed(normalizePath(line)),
        }).pipe(
          Effect.map((result) =>
            result.map((relative) =>
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            ),
          ),
          Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause))),
        ),
      find: (input) =>
        run<Entry>({
          cwd: input.cwd,
          limit: input.limit,
          signal: input.signal,
          args: [
            "--no-config",
            "--files",
            ...(input.hidden ? ["--hidden"] : []),
            ...(input.follow ? ["--follow"] : []),
            ...(input.pattern === "*" ? [] : [`--glob=${input.pattern}`]),
            ...(input.exclude ?? []).map((pattern) => `--glob=!${pattern}`),
            "--glob=!**/.git/**",
            ".",
          ],
          parse: (line) => {
            const relative = normalizePath(line)
            return Effect.succeed(
              Entry.make({
                path: RelativePath.make(relative),
                type: "file",
              }),
            )
          },
          onItem: input.onEntry,
        }).pipe(Effect.catchTag("Ripgrep.InvalidPatternError", (cause) => Effect.fail(failure(cause.message, cause)))),
      grep: (input) => grep(input).pipe(Effect.map((result) => result.items)),
      grepContext: grep,
      grepFiles: (input) =>
        run<Entry>({
          ...input,
          args: ["--files-with-matches", ...grepArgs(input)],
          parse: (line) => Effect.succeed(Entry.make({ path: RelativePath.make(normalizePath(line)), type: "file" })),
        }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Environment.node, RipgrepBinary.node] })
