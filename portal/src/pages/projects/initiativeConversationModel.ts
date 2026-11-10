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
// <work item>: …", metadata `workComment` and the item's `pageReference`; the
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

export const WORK_NOTE_REFERENCE_MAX = 120;

/** "Comment on <work item>: <first 120 characters of the note>", one line. */
export function workNoteReferenceText(item: string, body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  const cut = flat.length > WORK_NOTE_REFERENCE_MAX ? `${flat.slice(0, WORK_NOTE_REFERENCE_MAX).trimEnd()}…` : flat;
  return `Comment on ${item}: ${cut}`;
}

/** The metadata that marks the reference (the pane's Work notes view) and links it to the item. */
export function workNoteReferenceMetadata(workItemId: string): Record<string, unknown> {
  return { workComment: true, pageReference: { kind: 'work-item', id: workItemId } };
}

/** What the composer says when the note was saved but the channel could not be told (its posting rule, or the socket). */
export function workNoteNotNotified(item: string, label: string, reason: string): string {
  const why = reason.trim().replace(/[.\s]+$/, '');
  return `Comment saved on ${item}. ${label} was not notified: ${why}.`;
}
