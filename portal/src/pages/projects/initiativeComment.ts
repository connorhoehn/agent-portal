/** Where the note was stored: the initiative thread, or (a bound initiative) the work item's own thread. */
export interface SavedInitiativeComment { id: string | null; discussion: 'thread' | 'channel' }

/**
 * A /comment is acknowledged only after the chat store wrote it. On an
 * initiative bound to a channel the answer says `discussion: 'channel'`: the
 * note is a record on the work item, and the composer posts the one-line
 * reference in the channel itself (InitiativeComposer).
 */
export async function postInitiativeComment(projectId: string, workItemId: string, body: string, deliveryId: string = crypto.randomUUID()): Promise<SavedInitiativeComment> {
  const response = await fetch(`/api/graph/projects/${encodeURIComponent(projectId)}/discussion/comments`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, workItemId, clientDeliveryId: deliveryId }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? `The comment could not be saved (${response.status})`);
  return { id: typeof result?.id === 'string' ? result.id : null, discussion: result?.discussion === 'channel' ? 'channel' : 'thread' };
}
