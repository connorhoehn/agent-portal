// What the thread's alert says when a chat command is refused. Every command
// (`/summarize`, `/deck`, `/diagram`, `/doc`, `/agent`) throws the server's own
// explanation from `run`; the hook turns whatever was thrown into one sentence
// here, so no command can fail with an empty alert or none at all.

/** The server's text when it gave one; otherwise a sentence naming the command. */
export function commandFailureMessage(trigger: string, cause: unknown): string {
  const text = cause instanceof Error ? cause.message.trim() : typeof cause === 'string' ? cause.trim() : '';
  return text || `${trigger} could not be started.`;
}
