// Why a docked composer's Apply / Send is off, from what the composer policy
// already knows (ui-components 2.515.6 `submitDisabledReason`: Send's tooltip,
// its accessible description and one line under the input). Nothing typed
// yet is NOT a reason: an empty box keeps Send quietly off, as every input
// does, so these return null for it. Pure: every rule is a node test.

/** A collection page's command host (Apply). */
export function collectionSubmitReason(input: {
  /** The page holds the input (a write it started is still running). */
  disabled?: boolean;
  /** The page's own words for `disabled`. */
  disabledReason?: string | null;
  /** A proposed operation waits on its confirm dialog. */
  confirming?: boolean;
  /** How many commands the page declares (its adapter's examples). */
  commandCount: number;
}): string | null {
  if (input.commandCount === 0) return 'This page has no commands.';
  if (input.confirming) return 'Confirm or keep the pending operation first.';
  if (input.disabled) return input.disabledReason?.trim() || 'Wait for the current change on this page to finish.';
  return null;
}

export const NO_DESTINATION_REASON = 'Choose a destination in To: first.';
export const READ_ONLY_DESTINATION_REASON = 'You can read this conversation but not post to it.';

/** A conversation composer (Send): read-only destination, no destination, socket down. */
export function conversationSubmitReason(input: {
  /** A destination is chosen (a thread composer always has its own conversation). */
  destinationChosen: boolean;
  /** The server's verdict, once it has answered: may this reader post here. */
  maySend: boolean;
  /** The server has not answered yet: stay quiet rather than flash "read only". */
  pending?: boolean;
  /** The page's own read-only words for this destination. */
  readOnlyReason?: string | null;
  /** The realtime socket is up. */
  connected: boolean;
  /** What to say while it is down. */
  offlineReason: string;
}): string | null {
  if (!input.destinationChosen) return NO_DESTINATION_REASON;
  if (input.pending) return null;
  if (!input.maySend || input.readOnlyReason) return input.readOnlyReason?.trim() || READ_ONLY_DESTINATION_REASON;
  if (!input.connected) return input.offlineReason;
  return null;
}
