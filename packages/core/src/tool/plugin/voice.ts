export * as VoiceTools from "./voice.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { AbsolutePath } from "@opencode/schema/schema"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Duration, Effect, Schema } from "effect"
import { Location } from "../../location.js"
import { Model } from "../../model.js"
import { voiceAgentID } from "../../plugin/agent.js"
import { Session } from "../../session.js"
import { VoiceRegistry } from "../../voice/registry.js"

/** The permission every voice tool shares; only the voice agent allows it. */
export const permission = "voice"

const sessionID = Schema.String.pipe(Schema.optional).annotate({ description: "Omit for the main session on Desktop" })
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
    const location = yield* Location.Service
    const models = yield* Model.Service

    const availableModels = (session: Session.Info) =>
      session.location.directory === location.directory && session.location.workspaceID === location.workspaceID
        ? models.available()
        : sessions.availableModels(session)

    const link = (context: { readonly sessionID: string }) => {
      const value = VoiceRegistry.get(context.sessionID)
      return value
        ? Effect.succeed(value)
        : Effect.fail(new ToolFailure({ message: "Voice tools work only in a live voice call's session." }))
    }

    // An omitted target is the session the call started from, whatever Desktop shows now.
    const target = Effect.fnUntraced(function* (
      input: { readonly session_id?: string },
      context: { readonly sessionID: string },
    ) {
      const value = yield* link(context)
      const session = yield* sessions.get(Session.ID.make(input.session_id ?? value.main))
      if (session.agent === voiceAgentID)
        return yield* new ToolFailure({ message: "The voice helper is not a session you can send work to." })
      return session
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
        .pipe(Effect.map((page) => page.data.filter((session) => session.agent !== voiceAgentID)))

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
            const admitted = yield* sessions.prompt({
              sessionID: session.id,
              text: input.text,
              delivery: input.delivery,
            })
            value.watch({
              sessionID: session.id,
              after: admitted.id,
              title: session.title ?? "Untitled",
              request: input.text,
            })
            return { output: { sent: true, session_id: session.id, title: session.title ?? "Untitled" } }
          }).pipe(Effect.mapError(failure("Unable to send the message"))),
      })

      draft.add({
        name: "voice_create_session",
        description:
          "Create a new main session. Omit directory to use the current main session's project or worktree. Does not change what Desktop shows.",
        input: Schema.Struct({ directory: Schema.optional(Schema.String), title: Schema.optional(Schema.String) }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const current = yield* target({}, context)
            const session = yield* sessions.create({
              title: input.title,
              location: input.directory
                ? Location.Ref.make({ directory: AbsolutePath.make(input.directory) })
                : current.location,
              agent: current.agent,
              model: current.model,
            })
            return { output: { session_id: session.id, title: session.title ?? "Untitled" } }
          }).pipe(Effect.mapError(failure("Unable to create the session"))),
      })

      draft.add({
        name: "voice_create_task",
        description:
          "Create and start an interactive child task under the current main session. It runs in the background and does not change the screen. Call once for each independent task.",
        input: Schema.Struct({
          title: Schema.String.check(Schema.isMinLength(1)),
          text: Schema.String.check(Schema.isMinLength(1)),
        }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const value = yield* link(context)
            const main = yield* target({}, context)
            const task = yield* sessions.taskCreate({ sessionID: main.id, title: input.title })
            const admitted = yield* sessions.prompt({ sessionID: task.id, text: input.text }).pipe(Effect.option)
            if (admitted._tag === "None")
              return {
                output: {
                  task_id: task.id,
                  title: task.title,
                  started: false,
                  error: "The task was created but its instruction was not admitted.",
                },
              }
            value.watch({
              sessionID: task.id,
              after: admitted.value.id,
              title: task.title ?? task.id,
              request: input.text,
            })
            return { output: { task_id: task.id, title: task.title, started: true } }
          }).pipe(Effect.mapError(failure("Unable to create the task"))),
      })

      draft.add({
        name: "voice_list_tasks",
        description:
          "List the main session's interactive tasks with their status. Excludes subagents and archived tasks.",
        input: Schema.Struct({}),
        output,
        options,
        execute: (_, context) =>
          Effect.gen(function* () {
            const main = yield* target({}, context)
            const active = yield* sessions.active
            const tasks = yield* sessions.taskTree(main.id)
            return {
              output: tasks.flatMap((task) =>
                task.experimental?.taskParentID && !task.time.archived
                  ? [{ ...row(task, active), parent_id: task.experimental.taskParentID }]
                  : [],
              ),
            }
          }).pipe(Effect.mapError(failure("Unable to list tasks"))),
      })

      draft.add({
        name: "voice_list_models",
        description:
          "Find the models a session can use across all configured providers, including the current model and reasoning variants.",
        input: Schema.Struct({ session_id: sessionID, query: Schema.optional(Schema.String), limit }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* target(input, context)
            const catalog = yield* availableModels(session)
            const words = input.query?.trim().toLowerCase().split(/\s+/) ?? []
            const models = catalog.filter((model) => {
              const label = `${model.name} ${model.providerID}/${model.id}`.toLowerCase()
              return words.every((word) => label.includes(word))
            })
            return {
              output: {
                current: session.model,
                matches: models.length,
                models: models.slice(0, input.limit ?? 20).map((model) => ({
                  id: `${model.providerID}/${model.id}`,
                  name: model.name,
                  variants: model.variants.map((variant) => variant.id),
                })),
              },
            }
          }).pipe(Effect.mapError(failure("Unable to list the session's models"))),
      })

      draft.add({
        name: "voice_switch_model",
        description:
          "Switch a session's work model, not the voice model. Use the exact provider/model ID from voice_list_models.",
        input: Schema.Struct({ session_id: sessionID, model: Schema.String, variant: Schema.optional(Schema.String) }),
        output,
        options,
        execute: (input, context) =>
          Effect.gen(function* () {
            const session = yield* target(input, context)
            const catalog = yield* availableModels(session)
            const model = catalog.find((model) => `${model.providerID}/${model.id}` === input.model)
            if (!model)
              return yield* new ToolFailure({ message: "Model not available in this session. Use voice_list_models." })
            const variants = model.variants.map((variant) => variant.id)
            const variant = variants.find((variant) => variant === (input.variant ?? session.model?.variant))
            if (input.variant && !variant)
              return yield* new ToolFailure({
                message: `The model does not offer that variant: ${variants.join(", ") || "none"}.`,
              })
            yield* sessions.switchModel({
              sessionID: session.id,
              model: { providerID: model.providerID, id: model.id, variant },
            })
            return { output: { switched_to: model.name, variant, session_id: session.id, title: session.title } }
          }).pipe(Effect.mapError(failure("Unable to switch the session's model"))),
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
            const session = yield* target(input, context)
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
