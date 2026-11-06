export * as SessionTask from "./session-task.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"
import { DateTimeUtcFromMillis } from "./schema.js"

/** A read model of durable task correspondence, including admitted messages not yet delivered. */
export const Message = Schema.Struct({
  id: SessionMessage.ID,
  from: SessionID,
  to: SessionID,
  text: Schema.String,
  time: DateTimeUtcFromMillis,
  state: Schema.Literals(["pending", "delivered"]),
}).annotate({ identifier: "SessionTask.Message" })
export interface Message extends Schema.Schema.Type<typeof Message> {}
