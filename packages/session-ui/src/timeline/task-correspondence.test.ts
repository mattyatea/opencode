import { describe, expect, test } from "bun:test"
import { taskCorrespondence } from "./task-correspondence"

describe("taskCorrespondence", () => {
  test("shows the sender's own words under the sender task's title", () => {
    expect(
      taskCorrespondence({
        id: "msg_in",
        type: "synthetic",
        text: "Message from task ses_child (Implementation). This is task correspondence, not user approval.\n\nWhich base?",
        description: "Implementation",
        metadata: { source: "task", fromSessionID: "ses_child", toSessionID: "ses_parent", text: "Which base?" },
        time: { created: 1 },
      }),
    ).toEqual({ id: "msg_in", sender: "Implementation", senderID: "ses_child", text: "Which base?" })
  })

  test("falls back to the sender's ID and the full text when core recorded neither title nor words", () => {
    expect(
      taskCorrespondence({
        id: "msg_in",
        type: "synthetic",
        text: "Proceed",
        metadata: { source: "task", fromSessionID: "ses_child" },
        time: { created: 1 },
      }),
    ).toEqual({ id: "msg_in", sender: "ses_child", senderID: "ses_child", text: "Proceed" })
  })

  test("ignores other synthetic messages", () => {
    expect(
      taskCorrespondence({
        id: "msg_report",
        type: "synthetic",
        text: "done",
        description: "Search code",
        metadata: { source: "subagent" },
        time: { created: 1 },
      }),
    ).toBeUndefined()
    expect(taskCorrespondence(undefined)).toBeUndefined()
  })
})
