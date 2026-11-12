export * as SessionContext from "./context.js"

import { Model } from "../model.js"
import { Permission } from "../permission.js"
import type { Message, ToolEntry } from "@opencode/ai/effect"
import { Context, Effect, Layer } from "effect"
import { Agent } from "../agent.js"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { CodeModeCatalog } from "../codemode/catalog.js"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { InstructionBuiltIns } from "../instructions/builtins.js"
import { Location } from "../location.js"
import { Mcp } from "../mcp/index.js"
import { McpInstructions } from "../mcp/instructions.js"
import { McpTool } from "../tool/mcp.js"
import { ReferenceInstructions } from "../reference/instructions.js"
import { SkillInstructions } from "../skill/instructions.js"
import { Tool } from "../tool.js"
import { Token } from "../util/token.js"
import { AgentNotFoundError } from "./error.js"
import { estimateMessage, estimateTool } from "./estimate.js"
import { SessionHistory } from "./history.js"
import { InstructionEntry } from "./instruction-entry.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.List
  readonly tools: Tool.Snapshot
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly initial: ReadonlyArray<Instructions.Rendered>
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly tools: Tool.Snapshot
}

/** One part of the next request, sized in tokens. */
export interface BreakdownPart {
  /** A stable id the client translates: `system-prompt`, `system-tools`, `mcp-tools`, `mcp-instructions`, `skills`, `instructions`, `references`, `session`, `messages`, or `other`. */
  readonly id: string
  readonly tokens: number
  /** The sources inside the part, such as tool names or instruction keys. */
  readonly entries: ReadonlyArray<{ readonly id: string; readonly tokens: number }>
}

/** What the next request spends the context window on, measured against the model's window. */
export interface Breakdown {
  /** The model's context window; 0 when the catalog has none. */
  readonly limit: number
  /** The model's input limit, when it differs from the context window; 0 when unknown. */
  readonly inputLimit: number
  /** Tokens the provider counted for the last prompt, which anchors the estimate. */
  readonly measured: number
  /** Tokens estimated for messages added after that prompt. */
  readonly estimated: number
  /** The prompt's size: measured plus estimated, or the whole estimate before the first response. */
  readonly used: number
  /** The prompt room left: the smaller of `limit` and `inputLimit` minus `used`, never negative; 0 when both are unknown. */
  readonly free: number
  /** The parts of the request, in display order. */
  readonly parts: ReadonlyArray<BreakdownPart>
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, instruction sources, and tool snapshot; `load` adds the model and
 * active history for that selection. Auxiliary operations resolve only the
 * capabilities they need; request preparation stays separate from selection.
 */
export interface Interface {
  /** Selects the Session, agent, instructions, and tools used by subsequent work. */
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves the model and active history for that selection. */
  readonly load: (selection: Selection) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  /** Sizes the request `load` would send, split into the parts that spend the context window. */
  readonly breakdown: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<
    Breakdown,
    AgentNotFoundError | SessionRunnerModel.Error | Instructions.InitializationBlocked
  >
  readonly resolveModel: (
    session: SessionSchema.Info,
    request: { readonly kind: SessionRequestKind; readonly agent: Agent.ID },
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  /** Selects auxiliary title capabilities without instruction or tool preflight. */
  readonly selectTitle: (session: SessionSchema.Info) => Effect.Effect<
    | {
        readonly agent: Agent.Info
        readonly primary: SessionRunnerModel.Resolved | undefined
        readonly selected: SessionRunnerModel.Resolved
      }
    | undefined
  >
  readonly request: SessionModelRequest.Interface
}

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const builtins = yield* InstructionBuiltIns.Service
    const model = yield* Model.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const location = yield* Location.Service
    const mcp = yield* Mcp.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const request = yield* SessionModelRequest.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const registry = yield* Tool.Service

    const resolveModel = (
      session: SessionSchema.Info,
      request: { readonly kind: SessionRequestKind; readonly agent: Agent.ID },
    ) => models.resolve(session, model.available, request)

    const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session: SessionSchema.Info) {
      const agent = yield* agents.get(Agent.ID.make("title"))
      if (!agent) return
      const primary = yield* resolveModel(session, { kind: "title", agent: agent.id }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const candidate = yield* Effect.gen(function* () {
        if (agent.model) {
          const info = yield* model.get(agent.model.providerID, agent.model.id)
          return info && { info, variant: agent.model.variant ?? minimalVariant(info) }
        }
        if (!primary) return
        const small = yield* model.small(primary.ref.providerID)
        if (small) return { info: small, variant: minimalVariant(small) }
        // Without a lower variant, the primary model at its selected variant is already the fallback.
        const info = yield* model.get(primary.ref.providerID, primary.ref.id)
        const variant = info && lowerVariant(info, primary.ref.variant)
        return variant && { info, variant }
      })
      const preferred =
        candidate &&
        (yield* resolveModel(
          {
            ...session,
            model: Model.Ref.make({
              providerID: candidate.info.providerID,
              id: candidate.info.id,
              ...(candidate.variant ? { variant: candidate.variant } : {}),
            }),
          },
          { kind: "title", agent: agent.id },
        ).pipe(Effect.orElseSucceed(() => undefined)))
      const selected = preferred ?? primary
      if (!selected) return
      return { agent, primary, selected }
    })

    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      yield* mcpTools.flush
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      // Session permissions narrow discovery the same way they narrow the tool snapshot.
      const permissions = Permission.merge(agent.info.permissions, session.permissions ?? [])
      const loaded = yield* Effect.all(
        {
          tools: registry.snapshot(permissions),
          builtins: builtins.load(),
          discovery: discovery.load(),
          skills: skillInstructions.load(permissions),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(permissions),
          entries: entries.load(sessionID),
        },
        { concurrency: "unbounded" },
      )
      return {
        session,
        agent: { ...agent, info: agent.info },
        // Ordered from most to least shared across sessions so the baseline stays a reusable
        // prompt-cache prefix: user-level catalog and guidance, then project instructions, then
        // the date and environment, which vary by day and directory.
        instructions: Instructions.combine([
          CodeModeInstructions.make(loaded.tools.codeModeCatalog),
          loaded.mcp,
          loaded.references,
          loaded.skills,
          loaded.discovery,
          loaded.builtins,
          loaded.entries,
        ]),
        tools: loaded.tools,
      }
    })

    const load = Effect.fn("SessionContext.load")(function* (selection: Selection) {
      const model = yield* resolveModel(selection.session, { kind: "primary", agent: selection.agent.id })
      const history = yield* SessionHistory.entriesForRunner(
        db,
        selection.session.id,
        selection.instructions,
        model.ref,
      )
      return {
        session: selection.session,
        agent: selection.agent,
        model,
        initial: history.initial,
        messages: history.entries.map((entry) => entry.message),
        tools: selection.tools,
      }
    })

    return Service.of({
      select,
      load,
      breakdown: Effect.fn("SessionContext.breakdown")(function* (sessionID) {
        const selection = yield* select(sessionID)
        const model = yield* resolveModel(selection.session, { kind: "primary", agent: selection.agent.id })
        // A session that has never run has no durable instruction baseline; the preview renders the current sources
        // without writing one.
        const history = yield* SessionHistory.preview(db, sessionID, selection.instructions, model.ref)
        const loaded: Loaded = {
          session: selection.session,
          agent: selection.agent,
          model,
          initial: history.initial,
          messages: history.messages,
          tools: selection.tools,
        }
        const mcpNamespaces = new Set((yield* mcp.servers()).map((server) => McpTool.namespace(server.name)))
        return breakdownOf(loaded, mcpNamespaces)
      }),
      resolveModel,
      selectTitle,
      request,
    })
  }),
)

type BreakdownParts = Map<string, { tokens: number; entries: Array<{ id: string; tokens: number }> }>

const BREAKDOWN_ORDER = [
  "system-prompt",
  "system-tools",
  "mcp-tools",
  "mcp-instructions",
  "skills",
  "instructions",
  "references",
  "session",
  "messages",
  "other",
] as const

const INSTRUCTION_PART: Record<Instructions.Category, string> = {
  system: "system-prompt",
  tools: "system-tools",
  mcp: "mcp-instructions",
  skills: "skills",
  instructions: "instructions",
  references: "references",
  session: "session",
}

/** The request `loaded` would send, split into the parts that spend the context window. */
const breakdownOf = (loaded: Loaded, mcpNamespaces: ReadonlySet<string>): Breakdown => {
  const limit = loaded.model.limit.context
  const inputLimit = loaded.model.limit.input ?? 0
  const anchorIndex = loaded.messages.findLastIndex((message) =>
    SessionHistory.hasMeasuredPrompt(message, loaded.model.ref),
  )
  const anchor = anchorIndex === -1 ? undefined : loaded.messages[anchorIndex]
  const measured = anchor?.type === "assistant" && anchor.tokens ? tokenTotal(anchor.tokens) : 0
  // The anchor's count covers the prompt before its own response: the base system prompt, instructions, tools, and
  // every message before it.
  const before = SessionModelRequest.baseTranscript({
    agent: loaded.agent.info,
    model: loaded.model,
    tools: loaded.tools,
    initial: loaded.initial,
    messages: anchor ? loaded.messages.slice(0, anchorIndex) : loaded.messages,
  })
  const anchored = composition({
    system: before.system,
    tools: loaded.tools.definitions,
    messages: before.messages,
    initial: loaded.initial,
    namespaces: loaded.tools.namespaces,
    mcpNamespaces,
    codeModeCatalog: loaded.tools.codeModeCatalog,
  })
  const after = anchor
    ? SessionModelRequest.baseTranscript({
        agent: loaded.agent.info,
        model: loaded.model,
        tools: loaded.tools,
        initial: [],
        messages: loaded.messages.slice(anchorIndex + 1),
      })
    : undefined
  const added = after
    ? composition({
        system: [],
        tools: [],
        messages: after.messages,
        initial: [],
        namespaces: undefined,
        mcpNamespaces,
        codeModeCatalog: undefined,
      })
    : undefined
  // The provider's count is exact for the prompt it saw; the character estimate only spreads it across the parts.
  // `measured` also covers the anchor's own reply, which is next request's history but not part of `anchored`.
  const prompt =
    anchor?.type === "assistant" && anchor.tokens
      ? anchor.tokens.input + anchor.tokens.cache.read + anchor.tokens.cache.write
      : 0
  const scale = prompt > 0 && anchored.total > 0 ? prompt / anchored.total : 1
  const parts: BreakdownParts = new Map()

  for (const [id, part] of anchored.parts) {
    addPart(
      parts,
      id,
      Math.round(part.tokens * scale),
      part.entries.map((entry) => ({
        id: entry.id,
        tokens: Math.round(entry.tokens * scale),
      })),
    )
  }
  if (measured > prompt) addPart(parts, "messages", measured - prompt, [{ id: "assistant", tokens: measured - prompt }])
  for (const [id, part] of added?.parts ?? []) addPart(parts, id, part.tokens, part.entries)

  const estimated = added?.total ?? 0
  const used = anchor ? measured + estimated : anchored.total
  const rounded = Array.from(parts.values()).reduce((sum, part) => sum + part.tokens, 0)
  adjustParts(parts, used - rounded)
  // Matches the window automatic compaction measures against: an input limit below the context window caps the prompt.
  const window = inputLimit && limit ? Math.min(inputLimit, limit) : inputLimit || limit

  return {
    limit,
    inputLimit,
    measured,
    estimated,
    used,
    free: window > 0 ? Math.max(0, window - used) : 0,
    parts: BREAKDOWN_ORDER.flatMap((id) => {
      const part = parts.get(id)

      return part && part.tokens > 0 ? [{ id, tokens: part.tokens, entries: part.entries }] : []
    }),
  }
}

const composition = (input: {
  readonly system: ReadonlyArray<{ readonly text: string }>
  readonly tools: ReadonlyArray<ToolEntry>
  readonly messages: ReadonlyArray<Message>
  readonly initial: ReadonlyArray<Instructions.Rendered>
  readonly namespaces: ReadonlyMap<string, string> | undefined
  readonly mcpNamespaces: ReadonlySet<string>
  readonly codeModeCatalog: CodeModeCatalog.Inventory | undefined
}): { readonly parts: BreakdownParts; readonly total: number } => {
  const parts: BreakdownParts = new Map()
  const systemPrompt = input.system[0]?.text
  if (systemPrompt)
    addPart(parts, "system-prompt", Token.estimate(systemPrompt), [
      { id: "base", tokens: Token.estimate(systemPrompt) },
    ])

  let instructionTokens = 0
  for (const rendered of input.initial) {
    const tokens = Token.estimate(rendered.text)
    instructionTokens += tokens
    if (rendered.category === "tools") {
      for (const part of codeModeParts(input.codeModeCatalog, input.mcpNamespaces, tokens)) {
        addPart(parts, part.id, part.tokens, part.entries)
      }
      continue
    }
    addPart(parts, INSTRUCTION_PART[rendered.category ?? "instructions"], tokens, [{ id: rendered.key, tokens }])
  }
  // Join separators, and any instruction text the stored initial rendering does not carry, such as an update in history.
  const joined = input.system[1]?.text
  const remainder = Math.max(0, Token.estimate(joined ?? "") - instructionTokens)
  if (remainder > 0) addPart(parts, "other", remainder, [{ id: "instructions", tokens: remainder }])

  for (const tool of input.tools) {
    const tokens = estimateTool(tool)
    const namespace = input.namespaces?.get(tool.name)
    const id = namespace !== undefined && input.mcpNamespaces.has(namespace) ? "mcp-tools" : "system-tools"
    addPart(parts, id, tokens, [{ id: tool.name, tokens }])
  }

  if (input.messages.length > 0) {
    const roles = new Map<string, number>()
    let tokens = 0
    for (const message of input.messages) {
      const size = estimateMessage(message)
      tokens += size
      roles.set(message.role, (roles.get(message.role) ?? 0) + size)
    }
    addPart(
      parts,
      "messages",
      tokens,
      Array.from(roles, ([id, tokens]) => ({ id, tokens })),
    )
  }

  return { parts, total: Array.from(parts.values()).reduce((sum, part) => sum + part.tokens, 0) }
}

/**
 * Code Mode delivers tool definitions as the rendered catalog, so the catalog's namespace lines and listings split
 * that text into system tools and MCP tools. Their rendered cost is scaled to the source text's estimate.
 */
const codeModeParts = (
  inventory: CodeModeCatalog.Inventory | undefined,
  mcpNamespaces: ReadonlySet<string>,
  total: number,
): ReadonlyArray<{
  readonly id: string
  readonly tokens: number
  readonly entries: Array<{ id: string; tokens: number }>
}> => {
  if (!inventory || total <= 0) return []
  const summary = CodeModeCatalog.summarize(inventory)
  const rendered = summary.namespaces.map((namespace) => {
    const entries = namespace.entries.map((entry) => ({
      id: entry.path,
      tokens: CodeModeCatalog.cost(entry.line),
    }))
    const line = CodeModeCatalog.cost(CodeModeCatalog.namespaceLine(namespace, namespace.entries.length))
    return {
      id: mcpNamespaces.has(namespace.name) ? "mcp-tools" : "system-tools",
      tokens: line + entries.reduce((sum, entry) => sum + entry.tokens, 0),
      entries,
    }
  })
  const catalog = rendered.reduce((sum, part) => sum + part.tokens, 0)
  if (catalog === 0) return []
  const scale = total / catalog
  const scaled = rendered.map((part) => ({
    ...part,
    tokens: Math.round(part.tokens * scale),
    entries: part.entries.map((entry) => ({ ...entry, tokens: Math.round(entry.tokens * scale) })),
  }))
  // The invariant guidance around the catalog has no tool of its own.
  const remainder = total - scaled.reduce((sum, part) => sum + part.tokens, 0)
  return remainder > 0
    ? [...scaled, { id: "system-tools", tokens: remainder, entries: [{ id: "core/codemode", tokens: remainder }] }]
    : scaled
}

const addPart = (parts: BreakdownParts, id: string, tokens: number, entries: Array<{ id: string; tokens: number }>) => {
  const part = parts.get(id) ?? { tokens: 0, entries: [] }
  part.tokens += tokens
  for (const entry of entries) {
    const existing = part.entries.find((item) => item.id === entry.id)
    if (!existing) {
      part.entries.push({ ...entry })
      continue
    }
    existing.tokens += entry.tokens
  }
  parts.set(id, part)
}

/** Rounding can leave the parts a few tokens off the measured total; the largest part absorbs the difference. */
const adjustParts = (parts: BreakdownParts, difference: number) => {
  if (difference === 0) return
  const largest = Array.from(parts.entries()).reduce<readonly [string, { tokens: number }] | undefined>(
    (best, entry) => (!best || entry[1].tokens > best[1].tokens ? entry : best),
    undefined,
  )
  if (!largest) return
  const part = parts.get(largest[0])
  if (!part) return
  part.tokens = Math.max(0, part.tokens + difference)
}

const tokenTotal = (tokens: {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}) => tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

/** Variant IDs that minimize reasoning output, in preference order. */
const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => Model.VariantID.make(id))

const minimalVariant = (info: Model.Info) =>
  MINIMAL_REASONING_VARIANTS.find((id) => info.variants.some((item) => item.id === id))

/**
 * `none` and `minimal` always reduce reasoning. `low` can enable reasoning on a model whose default
 * does not reason, so it is only used when it ranks below the variant the session selected.
 */
const lowerVariant = (info: Model.Info, selected: Model.VariantID | undefined) => {
  const rank = (id: Model.VariantID | undefined) => info.variants.findIndex((item) => item.id === id)
  return MINIMAL_REASONING_VARIANTS.find((id) => rank(id) !== -1 && (id !== "low" || rank(id) < rank(selected)))
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Model.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    Mcp.node,
    McpInstructions.node,
    McpTool.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
  ],
})
