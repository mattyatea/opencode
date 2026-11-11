import { expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

test("the prompt keeps pasted control characters and drops escape sequences", async () => {
  // Other app tests can leave a home draft in the process-wide stash.
  takeDraft(undefined)
  await using setup = await createAppFixture()
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("commands"))
  await setup.mockInput.typeText("x")
  await setup.waitForFrame((frame) => frame.includes("x"))
  await setup.mockInput.pasteBracketedText("a\fb\u001b[31mc\u0000d")
  await setup.waitForFrame((frame) => frame.includes("xa^Lbc^@d"))
  expect(setup.renderer.currentFocusedEditor?.plainText).toBe("xa\fbc\0d")
})

test.each([true, false])(
  "large paste uploads full text and sends a reference (upload succeeds: %s)",
  async (success) => {
    takeDraft(undefined)
    const location = { directory: process.cwd(), project: { id: "project", directory: process.cwd() } }
    const uploaded = Promise.withResolvers<{ path: string; text: string }>()
    const release = Promise.withResolvers<void>()
    const submitted = Promise.withResolvers<{ text: string; files?: unknown[] }>()
    const text = `  ${"日本語\n".repeat(120)}末尾ID-42  `
    let session: unknown
    let requests = 0
    await using setup = await createAppFixture({
      config: { animations: false, tabs: { mode: "off" }, experimental: { "paste-files": true } },
      fetch: async (url, request) => {
        if (url.pathname === "/api/location") return json(location)
        if (url.pathname === "/api/fs/list") return json({ location, data: [] })
        if (url.pathname === "/api/agent")
          return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
        if (url.pathname === "/api/model")
          return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
        if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
        if (url.pathname === "/api/experimental/fs/write") {
          uploaded.resolve({ path: url.searchParams.get("path") ?? "", text: await request.text() })
          await release.promise
          if (!success) return json({ message: "disk full" }, { status: 400 })
          return json({ location, data: { path: "/server/uploads/one/paste.txt" } })
        }
        if (url.pathname === "/api/session" && request.method === "POST") {
          session = {
            ...(await request.json()),
            projectID: "project",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          }
          return json({ data: session })
        }
        if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
          requests++
          submitted.resolve(await request.json())
          return json({ data: {} })
        }
        if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
          return json({ data: [], cursor: {} })
        if (session && /^\/api\/session\/[^/]+$/.test(url.pathname)) return json({ data: session })
        return undefined
      },
    })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Build · Model Provider"))
    await setup.mockInput.pasteBracketedText(text)
    const upload = await uploaded.promise
    expect(upload.text).toBe(text)
    expect(upload.path).toMatch(/\/uploads\/[^/]+\/paste\.txt$/)
    await setup.waitForFrame((frame) => frame.includes("[paste.txt]"))
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(requests).toBe(0)
    release.resolve()
    const prompt = await submitted.promise
    expect(prompt.text).toBe(success ? "Attached file: `/server/uploads/one/paste.txt` " : `${text} `)
    expect(prompt.files ?? []).toEqual([])
  },
)
