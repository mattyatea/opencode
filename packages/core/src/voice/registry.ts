export * as VoiceRegistry from "./registry.js"

/**
 * Voice sessions of live calls, by session ID. The call runs in the server's global Location while its voice session
 * runs in a project's, so the voice tools reach the call through this process-wide table instead of a service.
 */
export interface Link {
  /** The session Desktop shows. Tools resolve its main session for an omitted session_id. */
  readonly viewing: () => { readonly id: string; readonly title?: string } | undefined
  /** Asks the client to show a session. */
  readonly open: (sessionID: string) => void
  /** Has the voice read a session's reply aloud once the work just sent to it finishes. */
  readonly watch: (input: {
    readonly sessionID: string
    readonly after: string
    readonly title: string
    readonly request: string
  }) => void
}

const links = new Map<string, Link>()

export function link(sessionID: string, value: Link) {
  links.set(sessionID, value)
  return () => {
    if (links.get(sessionID) === value) links.delete(sessionID)
  }
}

export function get(sessionID: string) {
  return links.get(sessionID)
}
