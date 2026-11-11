import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { createComposerAttachments } from "@/composer/attachments/attachments"
import { uploads } from "@/composer/attachments/uploads"
import { createMemoryComposerState } from "@/composer/state"
import type { ComposerPrompt } from "@/composer/types"
import { buildPromptRequest } from "@/composer/request"

function target() {
  const [store, setStore] = createStore<{ prompt: ComposerPrompt; cursor: number }>({
    prompt: [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: 0,
  })

  return {
    prompt: store,
    capture: {
      current: () => store.prompt,
      cursor: () => store.cursor,
      set: (prompt: ComposerPrompt, cursor = store.cursor) => setStore({ prompt, cursor }),
    },
  }
}

describe("Composer attachment ownership", () => {
  test.each([true, false])("large paste stays with its captured draft after upload success=%s", async (success) => {
    const first = target()
    const second = target()
    const uploaded = Promise.withResolvers<string>()
    const errors: unknown[] = []
    const text = `  ${"日本語\n".repeat(120)}末尾ID-42  `
    let active = first.capture
    let file: File | undefined
    const root = createRoot((dispose) => ({
      dispose,
      attachments: createComposerAttachments({
        capture: () => active,
        editor: () => document.createElement("div"),
        focusEditor() {},
        addPart: () => false,
        setDraggingType() {},
        directory: () => "/repo",
        pasteFiles: () => true,
        destination: () => ({
          input: { image: true, pdf: true },
          local: false,
          upload: (value) => {
            file = value
            return uploaded.promise
          },
        }),
        isDialogActive: () => false,
        duplicate() {},
        onError: (error) => errors.push(error),
        onUploadError: (error) => errors.push(error),
      }),
    }))
    try {
      const clipboardData = new DataTransfer()
      clipboardData.setData("text/plain", text)
      const event = new ClipboardEvent("paste", { cancelable: true, clipboardData })
      const pending = root.attachments.handlePaste(event)
      expect(event.defaultPrevented).toBe(true)
      expect(root.attachments.pending()).toHaveLength(1)
      active = second.capture
      if (success) uploaded.resolve("/server/uploads/one/paste.txt")
      if (!success) uploaded.reject(new Error("upload failed"))
      await pending
      expect(file?.name).toBe("paste.txt")
      expect(await file?.text()).toBe(text)
      expect(second.prompt.prompt).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
      expect(root.attachments.pending()).toEqual([])
      if (!success) {
        expect(first.prompt.prompt.map((part) => ("content" in part ? part.content : "")).join("")).toBe(text)
        expect(errors).toHaveLength(1)
        return
      }
      const request = buildPromptRequest({
        prompt: first.prompt.prompt,
        context: [],
        images: [],
        text: "",
        sessionDirectory: "/repo",
      })
      expect(request.text).toBe("Attached file: `/server/uploads/one/paste.txt`")
      expect(request.files).toEqual([])
      expect(request.text).not.toContain("末尾ID-42")
      expect(errors).toEqual([])
    } finally {
      root.dispose()
    }
  })

  test("keeps an async attachment with the Composer where it started", async () => {
    await new Promise<void>((resolveTest, rejectTest) => {
      createRoot((dispose) => {
        const first = target()
        const second = target()
        const stored = Promise.withResolvers<{ id: string; url: string }>()
        let active = first.capture

        const attachments = createComposerAttachments({
          capture: () => active,
          editor: () => document.createElement("div"),
          focusEditor() {},
          addPart: () => false,
          setDraggingType() {},
          directory: () => "C:/repo",
          destination: () => ({
            input: { image: true, pdf: true },
            local: false,
            upload: () => Promise.reject(new Error("native attachments must not upload")),
          }),
          isDialogActive: () => false,
          duplicate() {},
          onError: rejectTest,
          onUploadError: rejectTest,
          store: () => stored.promise,
        })

        const pending = attachments.addAttachments([new File(["image"], "image.png", { type: "image/png" })])
        active = second.capture
        stored.resolve({ id: "blob-1", url: "blob:test" })
        void pending.then(() => {
          expect(first.prompt.prompt.some((part) => part.type === "image" && part.blob.id === "blob-1")).toBe(true)
          expect(second.prompt.prompt.some((part) => part.type === "image")).toBe(false)
          dispose()
          resolveTest()
        }, rejectTest)
      })
    })
  })

  test("upload progress keeps each row's identity and writes only its own row", async () => {
    const scope = {}
    const reports: ((loaded: number) => void)[] = []

    const work = (report: (loaded: number) => void) => {
      reports.push(report)

      return new Promise<string>(() => {})
    }

    const first = uploads.track({ id: "one", scope, filename: "one.bin", mime: "", size: 100 }, work)
    const second = uploads.track({ id: "two", scope, filename: "two.bin", mime: "", size: 100 }, work)
    const rows = [...uploads.items()]

    reports[1]?.(40)
    expect(uploads.items()[0]).toBe(rows[0]!)
    expect(uploads.items()[1]).toBe(rows[1]!)
    expect(uploads.items().map((item) => item.loaded)).toEqual([0, 40])

    uploads.cancelScope(scope)
    expect(await Promise.all([first, second])).toEqual([undefined, undefined])
  })

  test("keeps an upload pending for its draft across a remount, and stops it when the draft closes", async () => {
    const draft = createRoot((dispose) => ({ state: createMemoryComposerState(), dispose }))
    const prompt = target()
    let signal: AbortSignal | undefined

    const mount = () =>
      createRoot((dispose) => ({
        dispose,
        attachments: createComposerAttachments({
          capture: () => ({ ...prompt.capture, scope: unwrap(draft.state.store[0]()) }),
          editor: () => document.createElement("div"),
          focusEditor() {},
          addPart: () => false,
          setDraggingType() {},
          directory: () => "C:/repo",
          destination: () => ({
            input: { image: false, pdf: false },
            local: false,
            upload: (_file, _report, abort) => {
              signal = abort

              return new Promise<string>(() => {})
            },
          }),
          isDialogActive: () => false,
          duplicate() {},
          onError() {},
          onUploadError() {},
        }),
      }))

    const first = mount()
    await first.attachments.addAttachments([new File([new Uint8Array([0, 1, 2])], "data.bin")])
    first.dispose()

    const second = mount()
    expect(second.attachments.pending().map((upload) => upload.filename)).toEqual(["data.bin"])

    draft.dispose()
    expect(second.attachments.pending()).toEqual([])
    expect(signal?.aborted).toBe(true)
    second.dispose()
  })
})
