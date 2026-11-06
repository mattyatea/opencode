import { expect, test } from "bun:test"
import { reconnectPlan } from "./connection"

test("a reconnect refreshes held directories and releases the rest", () => {
  const held = new Set(["/b", "/d"])
  expect(reconnectPlan(["/a", "/b", "/c", "/d"], (directory) => held.has(directory))).toEqual({
    refresh: ["/b", "/d"],
    release: ["/a", "/c"],
  })
  expect(reconnectPlan(["/a"], () => false)).toEqual({ refresh: [], release: ["/a"] })
})
