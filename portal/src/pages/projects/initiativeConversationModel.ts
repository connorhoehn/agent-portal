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
