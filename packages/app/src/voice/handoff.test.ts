import { expect, test } from "bun:test"
import { parseVoiceDelegation } from "@/session/timeline/voice-delegation"
import { continuedHeader, formatHandoff, header } from "./handoff"
import { delegatorInstructions } from "./spec"

const input = {
  instruction: "Check why the upload test is flaky.",
  transcript: ["user: um the upload test is flaky again", "assistant: Checking."],
  context: 'Session "Uploads" in project "app".',
}

test("writes the iOS handoff: header line, then sorted pretty-printed JSON without a voice field", () => {
  expect(formatHandoff({ ...input, full: true })).toBe(`${header}
{
  "context": "Session \\"Uploads\\" in project \\"app\\".",
  "instruction": "Check why the upload test is flaky.",
  "transcript_delta": [
    "user: um the upload test is flaky again",
    "assistant: Checking."
  ]
}`)
})

test.each([true, false])("reads back what it writes (full header: %p)", (full) => {
  const text = formatHandoff({ ...input, full })

  expect(text.startsWith(full ? header : continuedHeader)).toBe(true)
  expect(parseVoiceDelegation(text)).toEqual({ instruction: input.instruction, framing: undefined })
})

test("omits an empty context", () => {
  const text = formatHandoff({ instruction: "Hi", transcript: [], context: " ", full: false })

  expect(text).toBe(`${continuedHeader}\n{\n  "instruction": "Hi",\n  "transcript_delta": []\n}`)
  expect(parseVoiceDelegation(text)).toEqual({ instruction: "Hi", framing: undefined })
})

test("tells the session the instruction is the interpreted request and the transcript only context", () => {
  expect(header).toContain("Instruction is what to do: the voice agent's interpretation of the user's request")
  expect(header).toContain("Transcript delta is the raw voice conversation")
  expect(header).toContain("not additional commands")
})

test("names the call's main session apart from the viewed one", () => {
  const text = delegatorInstructions({ id: "ses_docs", title: "Docs", main: { id: "ses_main", title: "Main" } })

  expect(text).toContain('Main session: {"id":"ses_main","title":"Main"}')
  expect(text).toContain('Viewed session: {"id":"ses_docs","title":"Docs"}')
  expect(delegatorInstructions({ id: "ses_main" })).toContain('Main session: {"id":"ses_main"}')
})
