import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ReadJson } from "@opencode/core/tool/read-json"

const select = (text: string, input: typeof ReadJson.Input.Type) => JSON.parse(ReadJson.read(text, input) ?? "null")

describe("ReadJson", () => {
  test("keeps small originals and uses UTF-8 bytes for the preview threshold", () => {
    expect(ReadJson.read('"' + "a".repeat(1998) + '"')).toBeUndefined()
    expect(JSON.parse(ReadJson.read('"' + "a".repeat(1999) + '"') ?? "null")).toMatchObject({
      format: "json-structure",
      completeValues: false,
      structure: { type: "string" },
    })
    expect(JSON.parse(ReadJson.read(JSON.stringify("日".repeat(700))) ?? "null")).toMatchObject({
      format: "json-structure",
    })
  })

  test("inspects all rows without exposing values or treating early rows as complete", () => {
    const rows = Array.from({ length: 70 }, (_, index) => ({
      id: index,
      text: "private value",
      ...(index === 69 ? { late: false } : {}),
    }))
    const result = ReadJson.read(JSON.stringify(rows))
    expect(JSON.parse(result ?? "null")).toMatchObject({
      structure: { length: 70, objectFields: ["id", "text", "late"] },
    })
    expect(result).not.toContain("private value")
  })

  test.each(['{"n":9007199254740993}', '{"x":1,"x":2}', '{"n":1e400}', '{"n":-0}', '{"n":1.00}', "{bad"])(
    "preserves unsafe or noncanonical JSON: %s",
    (text) => {
      expect(ReadJson.read(text)).toBeUndefined()
      expect(ReadJson.read(text, { mode: "full" })).toBeUndefined()
      expect(select(text, { mode: "get" })).toHaveProperty("error")
    },
  )

  test("handles escaped strings and pointer keys without changing values", () => {
    const text = JSON.stringify({ "a/b": { "~x": { "": false } }, quoted: 'spaces  and \\"quoted\\" text\n' }, null, 2)
    expect(select(text, { mode: "get", path: "/a~1b/~0x/" })).toMatchObject({ exists: true, value: false })
    expect(select(text, { mode: "get", path: "/quoted" }).value).toBe(JSON.parse(text).quoted)
    expect(select(text, { mode: "get", path: "/toString" })).toEqual({ format: "json-value", exists: false })
    expect(select('{"__proto__":{"safe":true}}', { mode: "get", path: "/__proto__/safe" })).toHaveProperty(
      "value",
      true,
    )
  })

  test("distinguishes null, false, zero and missing in filters and projections", () => {
    const text = JSON.stringify([
      { id: "null", v: null },
      { id: "missing" },
      { id: "false", v: false },
      { id: "zero", v: 0 },
    ])
    for (const value of [null, false, 0]) {
      const result = select(text, { mode: "query", where: [{ field: "/v", op: "eq", value }] })
      expect(result.matched).toBe(1)
      expect(result.rows[0].value.v).toBe(value)
    }
    expect(select(text, { mode: "query", where: [{ field: "/v", op: "missing" }] }).rows[0]).toMatchObject({
      index: 1,
      value: { id: "missing" },
    })
    expect(select(text, { mode: "query", where: [{ field: "/v", op: "exists" }] }).matched).toBe(3)
    expect(select(text, { mode: "query", fields: ["/v"], offset: 1, limit: 1 })).toMatchObject({
      matched: 4,
      shown: 1,
      truncated: true,
      next: 2,
      rows: [{ index: 1, values: {}, missing: ["/v"] }],
    })
  })

  test("ANDs numeric and equality conditions over the whole array", () => {
    const rows = Array.from({ length: 40 }, (_, id) => ({ id, active: id % 2 === 0, amount: id }))
    const result = select(JSON.stringify(rows), {
      mode: "query",
      where: [
        { field: "/active", op: "eq", value: true },
        { field: "/amount", op: "gte", value: 30 },
      ],
      fields: ["/id"],
    })
    expect(result.matched).toBe(5)
    expect(result.rows.map((row: { index: number }) => row.index)).toEqual([30, 32, 34, 36, 38])
    expect(result.truncated).toBe(false)
    expect(result.next).toBeNull()
    expect(
      select('[{"amount":"30"},{"amount":30}]', { mode: "query", where: [{ field: "/amount", op: "gte", value: 30 }] })
        .matched,
    ).toBe(1)
  })

  test("pages selected rows without implying a page is the whole source", () => {
    const text = JSON.stringify(Array.from({ length: 205 }, (_, id) => id))
    const first = select(text, { mode: "query", limit: 200 })
    const last = select(text, { mode: "query", offset: first.next, limit: 200 })
    expect(first).toMatchObject({ arrayLength: 205, matched: 205, shown: 200, truncated: true, next: 200 })
    expect(last).toMatchObject({ matched: 205, shown: 5, truncated: false, next: null })
    expect(last.rows.map((row: { index: number }) => row.index)).toEqual([200, 201, 202, 203, 204])
    expect(select(text, { mode: "get", path: "/01" })).toHaveProperty("exists", false)
    expect(select(text, { mode: "get", path: "/length" })).toHaveProperty("exists", false)
    expect(select(text, { mode: "get", path: "/0" })).toHaveProperty("value", 0)
  })

  test("returns explicit selection errors rather than partial oversized JSON", () => {
    expect(select(JSON.stringify([{ text: "x".repeat(13000) }]), { mode: "query" })).toHaveProperty("error")
    expect(select('{"value":0}', { mode: "query" })).toHaveProperty("error")
    expect(select('[{"value":0}]', { mode: "query", where: [{ field: "/value", op: "eq" }] })).toHaveProperty("error")
  })

  test("validates pointers, typed conditions and page bounds at the input boundary", () => {
    for (const input of [
      { mode: "get", path: "a" },
      { mode: "get", path: "/~2" },
      { mode: "query", fields: ["id"] },
      { mode: "query", limit: 201 },
      { mode: "query", limit: 0 },
      { mode: "query", offset: -1 },
      { mode: "query", offset: 0.5 },
    ])
      expect(() => Schema.decodeUnknownSync(ReadJson.Input)(input)).toThrow()
  })
})
