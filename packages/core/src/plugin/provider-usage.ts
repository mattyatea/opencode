export * as ProviderUsagePlugin from "./provider-usage.js"

import { define } from "@opencode/plugin/effect/plugin"
import { ProviderUsage } from "@opencode/schema/provider-usage"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Clock, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess } from "effect/process"
import path from "node:path"

type Meter = ProviderUsage.Meter
type Usage = ProviderUsage.Provider
type Credential =
  | { type: "oauth"; access: string; expires: number; metadata?: Record<string, unknown> }
  | { type: "key"; key: string; metadata?: Record<string, unknown> }
  | { type: "external"; metadata?: Record<string, unknown> }
type Reply = { ok: true; status: number; json: unknown } | { ok: false; status: number; error: string }

const CACHE_FOR = 300_000
// Shared by every Location's instance: the usage belongs to the machine's sign-ins, not to a project.
let cached: ProviderUsage.Snapshot | undefined

export const Plugin = define({
  id: "opencode.provider-usage",
  effect: Effect.fn(function* (ctx) {
    const http = yield* HttpClient.HttpClient
    const fs = yield* FSUtil.Service
    const processes = yield* AppProcess.Service

    const getJSON = (url: string, headers: Record<string, string>): Effect.Effect<Reply> =>
      http
        .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ accept: "application/json", ...headers })))
        .pipe(
          Effect.flatMap((response) =>
            response.status < 200 || response.status >= 300
              ? Effect.succeed<Reply>({ ok: false, status: response.status, error: `HTTP ${response.status}` })
              : response.json.pipe(Effect.map((json): Reply => ({ ok: true, status: response.status, json }))),
          ),
          Effect.timeout("12 seconds"),
          Effect.orElseSucceed((): Reply => ({ ok: false, status: 0, error: "取得できなかった" })),
        )

    const active = (integrationID: string) =>
      Effect.gen(function* () {
        const connection = yield* ctx.integration.connection.active(integrationID)
        if (!connection) return undefined
        // SAFETY: resolved credentials are one of the three stored credential shapes.
        return (yield* ctx.integration.connection.resolve(connection)) as Credential | undefined
      }).pipe(Effect.orElseSucceed(() => undefined))

    const readJSONFile = (file: string) =>
      fs.readFileStringSafe(file).pipe(
        Effect.map((text) => (text === undefined ? undefined : parseJSON(text))),
        Effect.orElseSucceed(() => undefined),
      )

    const readGo = Effect.gen(function* () {
      const name = "OpenCode Go"
      const credential = yield* active("opencode")
      if (!credential || credential.type === "external") return signedOut("opencode", name)
      const workspaceID = stringOf(credential.metadata?.orgID)
      if (!workspaceID) return unavailable("opencode", name, "ワークスペースがトークンにない")
      const server = stringOf(credential.metadata?.server) ?? "https://opencode.ai/console"
      const origin = originOf(server.replace(/^https:\/\/console\.opencode\.ai(?=\/|$)/, "https://opencode.ai/console"))
      if (!origin) return unavailable("opencode", name, "サーバーの URL が読めない")
      const token = credential.type === "oauth" ? credential.access : credential.key
      const body = yield* getJSON(`${origin}/zen/go/v1/usage`, {
        authorization: `Bearer ${token}`,
        "x-opencode-org-id": workspaceID,
      })
      if (body.status === 403) return unavailable("opencode", name, "このワークスペースは Go 未加入")
      if (!body.ok) return unavailable("opencode", name, body.error)
      const usage = record(record(body.json)?.usage)
      const meters = ["rolling", "weekly", "monthly"].flatMap((id) => {
        const meter = goMeter(id, usage?.[id])
        return meter ? [meter] : []
      })
      if (meters.length === 0) return unavailable("opencode", name, "使用量の形が読めない")
      return ready("opencode", name, meters)
    })

    const codexLogin = Effect.gen(function* () {
      const tokens = record(record(yield* readJSONFile(path.join(Global.Path.home, ".codex", "auth.json")))?.tokens)
      const access = stringOf(tokens?.access_token)
      if (!access) return undefined
      return { access, accountID: stringOf(tokens?.account_id) ?? accountFromToken(access) }
    })

    const readCodex = Effect.gen(function* () {
      const name = "Codex"
      const credential = yield* active("openai")
      const oauth =
        credential?.type === "oauth"
          ? {
              access: credential.access,
              accountID: stringOf(credential.metadata?.accountID) ?? accountFromToken(credential.access),
            }
          : undefined
      const login = oauth?.accountID ? oauth : ((yield* codexLogin) ?? oauth)
      if (!login) {
        if (credential?.type === "key") return unavailable("openai", name, "API キーではサブスクリプション使用量を取れない")
        return signedOut("openai", name)
      }
      if (!login.accountID) return unavailable("openai", name, "Codex ログインのアカウント ID がない")
      const body = yield* getJSON("https://chatgpt.com/backend-api/wham/usage", {
        authorization: `Bearer ${login.access}`,
        "ChatGPT-Account-Id": login.accountID,
      })
      if (!body.ok) return unavailable("openai", name, body.error)
      const json = record(body.json)
      const rate = record(json?.rate_limit)
      const meters = [windowMeter("primary", rate?.primary_window), windowMeter("secondary", rate?.secondary_window)]
        .filter((meter) => meter !== undefined)
      if (meters.length === 0) return unavailable("openai", name, "使用量の形が読めない")
      return ready("openai", name, meters, stringOf(json?.plan_type))
    })

    const readXAI = Effect.gen(function* () {
      const name = "xAI"
      const credential = yield* active("xai")
      if (!credential) return signedOut("xai", name)
      if (credential.type !== "oauth") return unavailable("xai", name, "API キーでは SuperGrok の使用量を取れない")
      const body = yield* getJSON("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        authorization: `Bearer ${credential.access}`,
        "x-grok-client-mode": "cli",
      })
      if (body.status === 401 || body.status === 403) return unavailable("xai", name, "サブスクリプションの請求情報を拒否された")
      if (!body.ok) return unavailable("xai", name, body.error)
      const json = record(body.json)
      const config = record(json?.config)
      const raw = config?.creditUsagePercent ?? config?.credit_usage_percent
      if (typeof raw !== "number" || !Number.isFinite(raw)) return unavailable("xai", name, "使用量の形が読めない")
      const period = record(config?.currentPeriod ?? config?.current_period)
      const plan = stringOf(json?.subscription_tier ?? json?.subscriptionTier)
      return ready(
        "xai",
        name,
        [meterOf("period", periodLabel(stringOf(period?.type)), raw, timeOf(period?.end))],
        plan,
      )
    })

    const claudeKeychain = Effect.gen(function* () {
      if (process.platform !== "darwin") return undefined
      const result = yield* processes
        .run(
          ChildProcess.make("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
            stdin: "ignore",
          }),
          { timeout: "5 seconds" },
        )
        .pipe(Effect.flatMap(AppProcess.requireSuccess))
      return parseJSON(result.stdout.toString("utf8"))
    }).pipe(Effect.orElseSucceed(() => undefined))

    const claudeCodeToken = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const keychain = oauthToken(record(yield* claudeKeychain)?.claudeAiOauth, now)
      if (keychain) return keychain
      const file = yield* readJSONFile(path.join(Global.Path.home, ".claude", ".credentials.json"))
      return oauthToken(record(file)?.claudeAiOauth, now)
    })

    const readClaude = Effect.gen(function* () {
      const name = "Claude"
      const oauth = yield* active("anthropic")
      const token = oauth?.type === "oauth" ? oauth.access : yield* claudeCodeToken
      if (token === "expired") return unavailable("claude", name, "ログインの再認証が必要")
      if (!token) return signedOut("claude", name)
      const body = yield* getJSON("https://api.anthropic.com/api/oauth/usage", {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      })
      if (body.status === 401 || body.status === 403) return unavailable("claude", name, "ログインの再認証が必要")
      if (!body.ok) return unavailable("claude", name, body.error)
      const json = record(body.json)
      const meters = [
        claudeMeter("five_hour", "5時間", json?.five_hour),
        claudeMeter("seven_day", "週間・すべてのモデル", json?.seven_day),
        claudeMeter("seven_day_sonnet", "週間・Sonnet", json?.seven_day_sonnet),
        claudeMeter("seven_day_opus", "週間・Opus", json?.seven_day_opus),
      ].filter((meter) => meter !== undefined)
      if (meters.length === 0) return unavailable("claude", name, "使用量の形が読めない")
      return ready("claude", name, meters)
    })

    yield* ctx.rpc
      .register(ProviderUsage.Definition, {
        snapshot: (input) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (!input.fresh && cached && now - cached.checkedAt < CACHE_FOR) return cached
            const providers = yield* Effect.all([readGo, readCodex, readXAI, readClaude], { concurrency: "unbounded" })
            const snapshot: ProviderUsage.Snapshot = { checkedAt: yield* Clock.currentTimeMillis, providers }
            cached = snapshot
            return snapshot
          }),
      })
      .pipe(Effect.orDie)
  }),
})

function ready(id: string, name: string, meters: Meter[], detail?: string): Usage {
  return { id, name, state: "ready", meters, ...(detail ? { detail } : {}) }
}

function signedOut(id: string, name: string): Usage {
  return { id, name, state: "signed-out", meters: [] }
}

function unavailable(id: string, name: string, detail: string): Usage {
  return { id, name, state: "unavailable", detail, meters: [] }
}

function meterOf(id: string, label: string, usedPercent: number, resetsAt?: number, limited?: boolean): Meter {
  return {
    id,
    label,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(limited ? { limited } : {}),
  }
}

function goMeter(id: string, value: unknown): Meter | undefined {
  const meter = record(value)
  const percent = meter?.percent
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined
  const labels: Record<string, string> = { rolling: "5時間", weekly: "週間", monthly: "月間" }
  return meterOf(id, labels[id] ?? "期間", percent, timeOf(meter?.resetsAt), meter?.status === "rate-limited")
}

function windowMeter(id: string, value: unknown): Meter | undefined {
  const meter = record(value)
  const percent = meter?.used_percent
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined
  return meterOf(id, windowLabel(meter?.limit_window_seconds), percent, timeOf(meter?.reset_at), percent >= 100)
}

function windowLabel(seconds: unknown) {
  if (seconds === 604800) return "週間"
  if (seconds === 18000) return "5時間"
  if (typeof seconds !== "number" || seconds <= 0) return "期間"
  if (seconds % 86400 === 0) return `${seconds / 86400}日間`
  if (seconds % 3600 === 0) return `${seconds / 3600}時間`
  return "期間"
}

function claudeMeter(id: string, label: string, value: unknown): Meter | undefined {
  const meter = record(value)
  const raw = meter?.utilization
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
  return meterOf(id, label, raw, timeOf(meter?.resets_at))
}

function periodLabel(type: string | undefined) {
  if (type?.endsWith("WEEKLY")) return "週間"
  if (type?.endsWith("MONTHLY")) return "月間"
  return "期間"
}

function oauthToken(value: unknown, now: number) {
  const oauth = record(value)
  const token = stringOf(oauth?.accessToken)
  if (!token) return undefined
  const expires = oauth?.expiresAt
  if (typeof expires === "number" && Number.isFinite(expires) && (expires < 1e12 ? expires * 1000 : expires) <= now)
    return "expired" as const
  return token
}

function accountFromToken(token: string) {
  const part = token.split(".")[1]
  if (!part) return undefined
  const claims = record(parseJSON(Buffer.from(part, "base64url").toString()))
  const auth = record(claims?.["https://api.openai.com/auth"])
  const firstOrg = (value: unknown) => (Array.isArray(value) ? stringOf(record(value[0])?.id) : undefined)
  return (
    stringOf(claims?.chatgpt_account_id) ??
    stringOf(auth?.chatgpt_account_id) ??
    firstOrg(claims?.organizations) ??
    firstOrg(auth?.organizations)
  )
}

function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function record(value: unknown) {
  // SAFETY: only object values pass; callers read fields as unknown and check each one.
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function stringOf(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function timeOf(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value !== "string") return undefined
  const parsed = Date.parse(value)
  if (!Number.isNaN(parsed)) return parsed
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric
  return undefined
}
