import { describe, expect } from "bun:test"
import { LLMEvent, Message, SystemPart, ToolDefinition } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/testing"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { Location } from "@opencode/core/location"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionContextUsage } from "@opencode/core/session/context-usage"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const KINDS: ReadonlyArray<SessionRequestKind> = ["primary", "compaction", "title", "generate"]

const session = Session.Info.make({
  id: Session.ID.make("ses_hook_kind"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

describe("SessionModelRequest HTTP hooks", () => {
  it.effect("fingerprints cache affinity after model hooks without changing the model body", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      let affinity = "hook-affinity-first"
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          event.headers["Session-Id"] = affinity
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const input = {
        session,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [Message.user("fixed input")],
      }
      const first = yield* requests.primary(input)
      affinity = "hook-affinity-second"
      const second = yield* requests.primary(input)

      expect(first.request.headers?.["Session-Id"]).toBe("hook-affinity-first")
      expect(second.request.headers?.["Session-Id"]).toBe("hook-affinity-second")
      expect(second.context?.fingerprints.routing).not.toBe(first.context?.fingerprints.routing)
      expect(second.context?.fingerprints.system).toBe(first.context?.fingerprints.system)
      expect(second.context?.fingerprints.tools).toBe(first.context?.fingerprints.tools)
      expect(second.context?.fingerprints.history).toBe(first.context?.fingerprints.history)
      expect(JSON.stringify(first.context)).not.toContain("hook-affinity-first")
      expect(JSON.stringify(second.context)).not.toContain("hook-affinity-second")
      const before = yield* compileRequest(first.request)
      const after = yield* compileRequest(second.request)
      expect(after.body).toEqual(before.body)
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("uses final hooked context for diagnostics and skill reuse, including renamed tools", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const body = '<skill_content name="demo">' + "Use the actual implementation.\n".repeat(50) + "</skill_content>"
      let removed = false
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          event.system = [SystemPart.make("Final hooked system")]
          event.tools.load_skill = event.tools.skill!
          delete event.tools.skill
          if (removed) event.messages = []
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const result = { content: [{ type: "text" as const, text: body }] }
      const prepare = () =>
        requests.primary({
          session,
          agent: Agent.ID.make("build"),
          model,
          system: [],
          messages: [Message.user(body)],
          tools: {
            definitions: [new ToolDefinition({ name: "skill", description: "Load skill", inputSchema: {} })],
            execute: () => Effect.succeed(result),
          },
        })
      const call = {
        sessionID: session.id,
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.create(),
        call: LLMEvent.toolCall({ id: "skill_call", name: "load_skill", input: { id: "demo" } }),
      }
      const first = yield* prepare()
      expect(first.context).toEqual(SessionContextUsage.measure(first.request))
      expect(yield* first.executeTool(call)).toMatchObject({ metadata: { reused: true } })
      removed = true
      const second = yield* prepare()
      expect(yield* second.executeTool(call)).toBe(result)
      expect(second.context?.fingerprints.history).not.toBe(first.context?.fingerprints.history)
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("tags every Session request kind on http.request and http.response", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: Array<{ hook: string; kind: SessionRequestKind; agent: Agent.ID }> = []
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "request", kind: event.kind, agent: event.agent })
        }),
      )
      yield* hooks.register("session", "http.response", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "response", kind: event.kind, agent: event.agent })
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      for (const kind of KINDS) {
        const prepared = yield* requests[kind]({
          session,
          agent: Agent.ID.make("build"),
          model,
          system: [],
          messages: [],
        })
        const http = prepared.options.http
        if (!http) throw new Error(`Expected HTTP middleware for ${kind}`)
        yield* http(HttpClientRequest.post("https://example.test/v1/chat/completions"), (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
        )
      }

      expect(seen).toEqual(
        KINDS.flatMap((kind) => [
          { hook: "request", kind, agent: Agent.ID.make("build") },
          { hook: "response", kind, agent: Agent.ID.make("build") },
        ]),
      )
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("sends a kept request's original body and a replaced request's new body", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      let replace = false
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          if (replace) {
            event.request = new Request(event.request.url, { method: "POST", body: '{"replaced":true}' })
            return
          }
          event.request.headers.set("x-plugin", "kept")
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model,
        system: [],
        messages: [],
      })
      const http = prepared.options.http
      if (!http) throw new Error("Expected HTTP middleware")
      const original = HttpClientRequest.post("https://example.test/v1/chat/completions").pipe(
        HttpClientRequest.bodyText('{"messages":[]}', "application/json"),
      )
      const send = () => {
        const sent: HttpClientRequest.HttpClientRequest[] = []
        return http(original, (request) =>
          Effect.sync(() => {
            sent.push(request)
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))
          }),
        ).pipe(Effect.map(() => sent[0]!))
      }

      const kept = yield* send()
      expect(kept.body).toBe(original.body)
      expect(kept.headers["x-plugin"]).toBe("kept")

      replace = true
      const replaced = yield* send()
      expect(replaced.body._tag).toBe("Uint8Array")
      if (replaced.body._tag !== "Uint8Array") return
      expect(new TextDecoder().decode(replaced.body.body)).toBe('{"replaced":true}')
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("keeps hook edits to a tool schema out of later requests", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          const input = event.tools.lookup!.input as { required: string[] }
          input.required.push("extra")
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const inputSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
      const tools = {
        definitions: [new ToolDefinition({ name: "lookup", description: "Lookup", inputSchema })],
        execute: () => Effect.die("unused tool execution"),
      }

      const required = yield* Effect.forEach([1, 2], () =>
        requests.primary({ session, agent: Agent.ID.make("build"), model, system: [], messages: [], tools }).pipe(
          Effect.map((prepared) => {
            const tool = prepared.request.tools[0]
            return tool?.type === "tool" ? tool.inputSchema.required : undefined
          }),
        ),
      )

      expect(required).toEqual([
        ["id", "extra"],
        ["id", "extra"],
      ])
      expect(inputSchema.required).toEqual(["id"])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("offers the WebSocket executor alongside HTTP hooks and routes the WebSocket hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "http.request", () => Effect.sync(() => void seen.push("http.request")))
      yield* hooks.register("session", "experimental.ws.handshake", (event) =>
        Effect.sync(() => {
          seen.push(`handshake:${event.kind}:${event.url}`)
          event.headers.authorization = "Bearer minted"
          delete event.headers["api-key"]
        }),
      )
      yield* hooks.register("session", "experimental.ws.send", (event) =>
        Effect.sync(() => {
          seen.push(`send:${event.kind}:${event.frame}`)
          event.frame = `${event.frame}+plugin`
        }),
      )
      yield* hooks.register("session", "experimental.ws.receive", (event) =>
        Effect.sync(() => {
          seen.push(`receive:${event.kind}:${event.frame}`)
          event.frame = event.frame.toUpperCase()
        }),
      )
      const bound: Array<{ url: string; headers: Record<string, string> }> = []
      const frames: string[] = []
      const websocketTransport = SessionModelTransport.Service.of({
        bind: (_sessionID, interceptor) => ({
          execute: () =>
            Effect.gen(function* () {
              if (!interceptor?.handshake || !interceptor.send || !interceptor.receive)
                throw new Error("Expected a full WebSocket interceptor")
              bound.push(
                yield* interceptor.handshake({ url: "wss://example.test/v1/responses", headers: { "api-key": "k" } }),
              )
              frames.push(yield* interceptor.send("create"))
              frames.push(yield* interceptor.receive("created"))
              return { frames: Stream.empty, complete: Effect.void }
            }),
        }),
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const requests = yield* SessionModelRequest.Service.pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, websocketTransport),
      )
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
          transport: "websocket",
        }),
        system: [],
        messages: [],
        webSocket: "session",
      })

      expect(prepared.options.http).toBeDefined()
      expect(prepared.options.webSocket).toBeDefined()
      yield* prepared.options.webSocket!.execute({} as never)
      expect(bound).toEqual([{ url: "wss://example.test/v1/responses", headers: { authorization: "Bearer minted" } }])
      expect(frames).toEqual(["create+plugin", "CREATED"])
      expect(seen).toEqual([
        "handshake:primary:wss://example.test/v1/responses",
        "send:primary:create",
        "receive:primary:created",
      ])
    }),
  )
})
