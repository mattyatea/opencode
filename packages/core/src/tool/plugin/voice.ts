export * as VoiceTools from "./voice.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { AbsolutePath } from "@opencode/schema/schema"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Duration, Effect, Schema } from "effect"
import { Location } from "../../location.js"
import { Session } from "../../session.js"
import { VoiceRegistry } from "../../voice/registry.js"

/** The permission every voice tool shares; only the voice agent allows it. */
export const permission = "voice"

const sessionID = Schema.String.pipe(Schema.optional).annotate({ description: "Omit for the session Desktop shows" })
const limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).pipe(Schema.optional)
const excerpt = 400
const waitLimit = Duration.seconds(90)
/** Tool results are plain JSON for the voice agent to read. */
const output = Schema.Unknown

/**
 * Tools of the voice agent, the OpenCode agent behind a ChatGPT voice call. It manages sessions; the sessions' own
 * agents do the work. They act only inside a voice session, which knows its call.
 */
export const Plugin = {
  id: "opencode.voice-tools",
  effect: Effect.fn("VoiceTools.Plugin")(function* (ctx: Context) {
    const sessions = yield* Session.Service

    const link = (context: { readonly sessionID: string }) => {
      const value = VoiceRegistry.get(context.sessionID)
      return value
        ? Effect.succeed(value)
        : Effect.fail(new ToolFailure({ message: "Voice tools work only in a live voice call's session." }))
    }

    // An omitted session means the one on screen.
    const target = Effect.fnUntraced(function* (
      input: { readonly session_id?: string },
      context: { readonly sessionID: string },
    ) {
      const value = yield* link(context)
      const id = input.session_id ?? value.viewing()?.id
      if (!id) return yield* new ToolFailure({ message: "Desktop shows no session; pass session_id." })
      return yield* sessions.get(Session.ID.make(id))
    })

    const row = (session: Session.Info, active: ReadonlySet<string>, viewing?: string) => ({
      id: session.id,
      title: session.title ?? "Untitled",
      directory: session.location.directory,
      status: active.has(session.id) ? "running" : (session.outcome ?? "idle"),
      on_screen: session.id === viewing,
    })

    const roots = (input: { readonly search?: string; readonly limit?: number }) =>
      sessions
        .list({ order: "desc", parentID: null, archived: false, search: input.search, limit: input.limit ?? 10 })
        .pipe(Effect.map((page) => page.data))

    const read = (session: Session.Info, count: number) =>
      sessions.messages({ sessionID: session.id, order: "desc", limit: count }).pipe(
        Effect.map((messages) =>
          messages.toReversed().flatMap((message) => {
            const text = messageText(message)
            return text ? [{ role: message.type, text: text.slice(0, excerpt) }] : []
          }),
        ),
      )

    const failure = (message: string) => (error: unknown) => new ToolFailure({ message, error })

    yield* ctx.tool.transform((draft) => {
      const options = { codemode: false, permission } as const

      draft.add({
        name: "voice_list_sessions",
        description: "List recent sessions, newest first, with their status and which one Desktop shows.",
        input: Schema.Struct({ limit }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const value = yield* link(context)
            const active = yield* sessions.active
            const list = yield* roots(input)
            return { output: list.map((session) => row(session, active, value.viewing()?.id)) }
          }).pipe(Effect.mapError(failure("Unable to list sessions"))),
      })

      draft.add({
        name: "voice_search_sessions",
        description: "Find sessions by words from their title, newest first. Use it before creating a session.",
        input: Schema.Struct({ query: Schema.String, limit }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const value = yield* link(context)
            const active = yield* sessions.active
            const list = yield* roots({ search: input.query, limit: input.limit })
            return { output: list.map((session) => row(session, active, value.viewing()?.id)) }
          }).pipe(Effect.mapError(failure("Unable to search sessions"))),
      })

      draft.add({
        name: "voice_read_session",
        description: `Read a session's status and latest messages as text excerpts of at most ${excerpt} characters.`,
        input: Schema.Struct({ session_id: sessionID, limit }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* target(input, context)
            const active = yield* sessions.active
            return { output: { ...row(session, active), messages: yield* read(session, input.limit ?? 6) } }
          }).pipe(Effect.mapError(failure("Unable to read the session"))),
      })

      draft.add({
        name: "voice_wait_for_session",
        description: "Wait up to 90 seconds for a session to finish its work, then read its latest reply.",
        input: Schema.Struct({ session_id: sessionID }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* target(input, context)
            const finished = yield* sessions.wait(session.id).pipe(
              Effect.timeout(waitLimit),
              Effect.as(true),
              Effect.catchTag("TimeoutError", () => Effect.succeed(false)),
            )
            const active = yield* sessions.active
            return { output: { ...row(session, active), finished, messages: yield* read(session, 2) } }
          }).pipe(Effect.mapError(failure("Unable to wait for the session"))),
      })

      draft.add({
        name: "voice_send_message",
        description:
          "Send work to a session as a clear instruction. It steers the current work by default; queue runs it after.",
        input: Schema.Struct({
          session_id: sessionID,
          text: Schema.String,
          delivery: Schema.Literals(["steer", "queue"]).pipe(Schema.optional),
        }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const value = yield* link(context)
            const session = yield* target(input, context)
            yield* sessions.prompt({ sessionID: session.id, text: input.text, delivery: input.delivery })
            value.watch({ sessionID: session.id, title: session.title ?? "Untitled", request: input.text })
            return { output: { sent: true, session_id: session.id, title: session.title ?? "Untitled" } }
          }).pipe(Effect.mapError(failure("Unable to send the message"))),
      })

      draft.add({
        name: "voice_create_session",
        description: "Create a session in a project or worktree directory. It does not change what Desktop shows.",
        input: Schema.Struct({ directory: Schema.String, title: Schema.String.pipe(Schema.optional) }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* link(context)
            const session = yield* sessions.create({
              title: input.title,
              location: Location.Ref.make({ directory: AbsolutePath.make(input.directory) }),
            })
            return { output: { session_id: session.id, title: session.title ?? "Untitled" } }
          }).pipe(Effect.mapError(failure("Unable to create the session"))),
      })

      draft.add({
        name: "voice_open_session",
        description:
          "Show a session on Desktop's screen. Only call it when the user asks to see or switch to a session.",
        input: Schema.Struct({ session_id: Schema.String }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const value = yield* link(context)
            const session = yield* sessions.get(Session.ID.make(input.session_id))
            value.open(session.id)
            return { output: { requested: true, session_id: session.id, title: session.title ?? "Untitled" } }
          }).pipe(Effect.mapError(failure("Unable to open the session"))),
      })

      draft.add({
        name: "voice_interrupt_session",
        description: "Stop a session's current work.",
        input: Schema.Struct({ session_id: sessionID }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* target(input, context)
            return { output: { interrupted: yield* sessions.interrupt(session.id), session_id: session.id } }
          }).pipe(Effect.mapError(failure("Unable to interrupt the session"))),
      })
    })
  }),
}

/** The text a person would read in a message; tool calls and reasoning are left out. */
export function messageText(message: SessionMessage.Info) {
  if (message.type === "user") return message.text
  if (message.type !== "assistant") return ""
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}
