import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"

const AuthFile = Schema.Struct({
  tokens: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        access_token: Schema.String,
        account_id: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
const decodeAuthFile = Schema.decodeUnknownOption(Schema.fromJsonString(AuthFile))
const Claims = Schema.Struct({ exp: Schema.optional(Schema.Number) })
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))

/**
 * The Codex CLI's ChatGPT sign-in from `$CODEX_HOME/auth.json`. It is only read: refreshing would rotate the CLI's
 * refresh token and sign the CLI out, so an expired token is reported for the CLI to refresh itself.
 */
export function codexCLICredentials(env: Record<string, string | undefined> = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), ".codex")
  const text = readText(path.join(home, "auth.json"))
  const tokens = text === undefined ? undefined : Option.getOrUndefined(decodeAuthFile(text))?.tokens
  if (!tokens) return undefined
  const payload = tokens.access_token.split(".")[1]
  const exp = payload
    ? Option.getOrUndefined(decodeClaims(Buffer.from(payload, "base64url").toString("utf8")))?.exp
    : undefined
  return {
    token: tokens.access_token,
    account: tokens.account_id ?? undefined,
    expired: exp !== undefined && exp * 1000 < Date.now() + 60_000,
  }
}

function readText(file: string) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    // No Codex CLI sign-in on this machine.
    return undefined
  }
}
