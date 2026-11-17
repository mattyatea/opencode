import { describe, expect, test } from "bun:test"
import { decideSharedPreference } from "./shared-preference"

describe("decideSharedPreference", () => {
  test.each([
    [
      "server has nothing and this client kept the defaults",
      { local: "d", remote: undefined, synced: undefined },
      "none",
    ],
    [
      "server has nothing and this client changed a setting",
      { local: "a", remote: undefined, synced: undefined },
      "push",
    ],
    ["first contact with a different server copy", { local: "a", remote: "b", synced: undefined }, "adopt"],
    ["first contact with the same copy", { local: "a", remote: "a", synced: undefined }, "none"],
    ["another client changed it", { local: "a", remote: "b", synced: "a" }, "adopt"],
    ["this client changed it", { local: "c", remote: "a", synced: "a" }, "push"],
    ["both changed, the local edit wins", { local: "c", remote: "b", synced: "a" }, "push"],
    ["both changed to the same value", { local: "b", remote: "b", synced: "a" }, "none"],
    ["nothing changed", { local: "a", remote: "a", synced: "a" }, "none"],
  ] as const)("%s", (_, input, expected) => {
    expect(decideSharedPreference({ ...input, initial: "d" })).toBe(expected)
  })
})
