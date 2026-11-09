export * as ReadJson from "./read-json.js"

import { Option, Schema } from "effect"
import { NonNegativeInt } from "../schema.js"

const Pointer = Schema.String.check(Schema.isPattern(/^(?:\/(?:[^~]|~[01])*)*$/))
const Scalar = Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null])

export const Input = Schema.Struct({
  mode: Schema.Literals(["full", "get", "query"]).annotate({
    description:
      "full returns the original through ordinary read bounds. get returns {exists,value}. query returns {matched,rows:[{index,values,missing}],truncated,next}, not a bare array. In Code Mode parse file.content, compute inside execute, and return only needed evidence. For semantic review retrieve every relevant text, not a sample.",
  }),
  path: Schema.optionalKey(Pointer).annotate({
    description: 'RFC6901 pointer to the value or array. Root is ""; escape ~ as ~0 and / as ~1.',
  }),
  fields: Schema.optionalKey(Schema.Array(Pointer)).annotate({
    description:
      'Projected pointers relative to each row, e.g. ["/id","/amount"], not bare names. Omit for whole rows. Projected keys keep the pointer spelling, e.g. row.values["/amount"].',
  }),
  where: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        field: Pointer.annotate({ description: 'RFC6901 pointer relative to each row, e.g. "/active", not "active".' }),
        op: Schema.Literals(["eq", "gte", "exists", "missing"]).annotate({
          description:
            "Conditions are ANDed over the complete original array. eq uses strict typed equality; gte compares numbers. exists/missing test key presence, not truthiness.",
        }),
        value: Schema.optionalKey(Scalar).annotate({
          description: "Required for eq/gte. null, false, 0 and missing are distinct.",
        }),
      }),
    ),
  ),
  offset: Schema.optionalKey(NonNegativeInt).annotate({
    description: "Zero-based position in matching rows. Follow next when truncated=true.",
  }),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))).annotate({
    description:
      "Maximum rows per response: default 20, maximum 200. Continue with next until truncated=false before claiming completeness.",
  }),
})

export function read(text: string, input?: typeof Input.Type) {
  if (input?.mode === "full") return
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text)
  if (Option.isNone(parsed) || JSON.stringify(parsed.value) !== compact(text)) {
    if (!input) return
    return encode({
      error:
        "Selection requires complete canonical JSON without duplicate keys or changed number spellings. Use json full or ordinary line reads for the original.",
    })
  }
  if (!input) {
    if (new TextEncoder().encode(text).length <= 2000) return
    return encode({
      format: "json-structure",
      completeValues: false,
      structure: structure(parsed.value),
      retrieval:
        "Use json get/query for original values or json full for all text. Structure is not evidence of missing values. Read every relevant text for semantic review.",
    })
  }
  const found = pointer(parsed.value, input.path ?? "")
  if (!found.exists) return encode({ format: "json-value", exists: false })
  if (input.mode === "get") return encode({ format: "json-value", ...found })
  if (!isArray(found.value)) return encode({ error: "query requires an array; use get for other values." })
  if (input.where?.some((condition) => ["eq", "gte"].includes(condition.op) && !Object.hasOwn(condition, "value")))
    return encode({ error: "eq/gte require an explicit comparison value." })
  const rows = found.value
    .map((value, index) => ({ value, index }))
    .filter(
      (row) =>
        input.where?.every((condition) => {
          const cell = pointer(row.value, condition.field)
          if (condition.op === "exists") return cell.exists
          if (condition.op === "missing") return !cell.exists
          if (!cell.exists) return false
          if (condition.op === "eq") return cell.value === condition.value
          return typeof cell.value === "number" && typeof condition.value === "number" && cell.value >= condition.value
        }) ?? true,
    )
  const offset = input.offset ?? 0
  const limit = input.limit ?? 20
  return encode({
    format: "json-selection",
    arrayLength: found.value.length,
    matched: rows.length,
    offset,
    shown: Math.min(limit, Math.max(0, rows.length - offset)),
    truncated: offset + limit < rows.length,
    next: offset + limit < rows.length ? offset + limit : null,
    rows: rows.slice(offset, offset + limit).map((row) =>
      !input.fields?.length
        ? row
        : {
            index: row.index,
            values: Object.fromEntries(
              input.fields.flatMap((field) => {
                const cell = pointer(row.value, field)
                return cell.exists ? [[field, cell.value]] : []
              }),
            ),
            missing: input.fields.filter((field) => !pointer(row.value, field).exists),
          },
    ),
  })
}

function pointer(document: Schema.Json, path: string): { exists: true; value: Schema.Json } | { exists: false } {
  if (path === "") return { exists: true, value: document }
  let value = document
  for (const part of path.slice(1).split("/")) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~")
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return { exists: false }
    if (isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return { exists: false }
      value = value[Number(key)]
      continue
    }
    value = value[key]
  }
  return { exists: true, value }
}

function structure(value: Schema.Json, depth = 0): Schema.Json {
  if (value === null) return { type: "null" }
  if (isArray(value))
    return {
      type: "array",
      length: value.length,
      itemTypes: [...new Set(value.map((item) => (item === null ? "null" : isArray(item) ? "array" : typeof item)))],
      objectFields: [
        ...new Set(
          value.flatMap((item) => (item && typeof item === "object" && !isArray(item) ? Object.keys(item) : [])),
        ),
      ],
    }
  if (typeof value !== "object") return { type: typeof value }
  if (depth >= 2) return { type: "object", keys: Object.keys(value) }
  return {
    type: "object",
    fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, structure(item, depth + 1)])),
  }
}

function encode(value: Schema.Json) {
  const text = JSON.stringify(value)
  if (text.length <= 12000) return text
  return JSON.stringify({
    error:
      "JSON result exceeds 12000 characters. Narrow the path, project fewer fields, reduce the page, or use json full through ordinary read bounds.",
  })
}

function isArray(value: Schema.Json): value is ReadonlyArray<Schema.Json> {
  return Array.isArray(value)
}

function compact(text: string) {
  const parts: string[] = []
  let quoted = false
  let escaped = false
  for (const char of text) {
    if (quoted) {
      parts.push(char)
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    if (!" \t\r\n".includes(char)) parts.push(char)
  }
  return parts.join("")
}
