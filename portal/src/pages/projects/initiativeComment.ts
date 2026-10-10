/** A /comment is acknowledged only after the initiative's chat store wrote it. */
export async function postInitiativeComment(projectId: string, workItemId: string, body: string, deliveryId: string = crypto.randomUUID()): Promise<void> {
  const response = await fetch(`/api/graph/projects/${encodeURIComponent(projectId)}/discussion/comments`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body, workItemId, clientDeliveryId: deliveryId }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error ?? `The comment could not be saved (${response.status})`);
}
