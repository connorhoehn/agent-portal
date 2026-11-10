export type InitiativeConversationFilter = 'dialogue' | 'all' | 'initiative';

/** Dialogue excludes explicit work-log comments; initiative-only also hides
 * discussion anchored to a leaf work item. Filtering never changes storage. */
export function initiativeConversationMessages<T extends { metadata?: Record<string, unknown> }>(messages: readonly T[], filter: InitiativeConversationFilter): T[] {
  return messages.filter(message => {
    if (filter === 'all') return true;
    if (message.metadata?.workComment === true) return false;
    const page = message.metadata?.pageReference as { kind?: string } | undefined;
    return filter !== 'initiative' || page?.kind !== 'work-item';
  });
}

// ─── A channel-backed Discussion pane (leftovers 2) ─────────────────────────
//
// A bound initiative's pane is its Social channel. Its messages are people's
// messages, the one-line references a `/comment` posts there ("Comment on
// <work item>", metadata `workComment` and the item's `pageReference`; the
// note itself is a record on the work item), and what agents post (a run's
// card, a /summarize summary, a /diagram or /doc artifact, a deck). The view
// filters those by their metadata; it never changes storage.

export type ChannelConversationFilter = 'all' | 'messages' | 'work-notes' | 'agent';
export type ChannelMessageKind = 'message' | 'work-note' | 'agent';

export const CHANNEL_FILTERS: ReadonlyArray<{ id: ChannelConversationFilter; label: string; description: string }> = [
  { id: 'all', label: 'All', description: 'Everything posted in the channel' },
  { id: 'messages', label: 'Messages', description: 'What people wrote, without work notes or agent posts' },
  { id: 'work-notes', label: 'Work notes', description: 'References to /comment notes saved on work items' },
  { id: 'agent', label: 'Agent', description: 'Agent runs, summaries and artifacts' },
];

export function channelMessageKind(message: { metadata?: Record<string, unknown> }): ChannelMessageKind {
  const m = message.metadata ?? {};
  if (m.workComment === true) return 'work-note';
  if (m.kind === 'agent-run' || m.summaryOf || m.artifactOf || m.sourceDeck) return 'agent';
  return 'message';
}

export function channelConversationMessages<T extends { metadata?: Record<string, unknown> }>(messages: readonly T[], filter: ChannelConversationFilter): T[] {
  if (filter === 'all') return [...messages];
  const want: ChannelMessageKind = filter === 'messages' ? 'message' : filter === 'work-notes' ? 'work-note' : 'agent';
  return messages.filter(message => channelMessageKind(message) === want);
}

export function parseChannelFilter(raw: string | null | undefined): ChannelConversationFilter {
  return raw === 'messages' || raw === 'work-notes' || raw === 'agent' ? raw : 'all';
}

// ─── The channel reference a /comment posts on a bound initiative ───────────

/**
 * "Comment on <work item title>", one line, and nothing of the note (sweep 12,
 * L3). The channel's readers may hold no orgiq grant, so the note itself stays
 * a record on the work item, read under the item's own access; the reference
 * only names the item, whose title the page read from the server, and links
 * it through the page reference below.
 */
export function workNoteReferenceText(item: string): string {
  return `Comment on ${item.replace(/\s+/g, ' ').trim()}`;
}

/**
 * The metadata that marks the reference (the pane's Work notes view) and links
 * it to the item. `workComment` is set by the posting client, and any client
 * can set it on any channel message, so it ONLY drives the pane's filter
 * (channelMessageKind, initiativeConversationMessages). It is never evidence
 * that a note exists on the item: what a work item's notes are is the
 * server's comment feed (GET …/work-items/:id/comments), and the message's
 * reference chip names the item without claiming a comment
 * (workConversationContext.tsx).
 */
export function workNoteReferenceMetadata(workItemId: string): Record<string, unknown> {
  return { workComment: true, pageReference: { kind: 'work-item', id: workItemId } };
}

/** What the composer says when the note was saved but the channel could not be told (its posting rule, or the socket). */
export function workNoteNotNotified(item: string, label: string, reason: string): string {
  const why = reason.trim().replace(/[.\s]+$/, '');
  return `Comment saved on ${item}. ${label} was not notified: ${why}.`;
}

/** The tone of the composer's receipt row (a library Banner): a failure is an error, a note the channel was not told of a warning, a saved note or message a success, the rest information. */
export type ReceiptTone = 'error' | 'warning' | 'success' | 'info';
export function receiptTone(state: 'pending' | 'saved' | 'requested' | 'failed' | 'notice', detail?: string): ReceiptTone {
  if (state === 'failed') return 'error';
  if (state === 'saved') return 'success';
  if (state !== 'notice') return 'info';
  if (/\bwas not notified\b/.test(detail ?? '')) return 'warning';
  return /^Comment saved on\b/.test(detail ?? '') ? 'success' : 'info';
}
