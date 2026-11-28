import type { SessionMessageInfo } from "@opencode/client/promise"
import { Predicate } from "effect"

/** A message another task sent this one. Core keeps the sender's own words in `metadata.text`, apart from the
 * attribution the model reads, so the bubble shows only what the sender wrote. */
export function taskCorrespondence(message: SessionMessageInfo | undefined) {
  if (message?.type !== "synthetic" || message.metadata?.source !== "task") return
  const from = message.metadata.fromSessionID
  const senderID = Predicate.isString(from) && from ? from : undefined
  const text = message.metadata.text

  return {
    id: message.id,
    sender: message.description || senderID || "",
    senderID,
    text: Predicate.isString(text) ? text : message.text,
  }
}
