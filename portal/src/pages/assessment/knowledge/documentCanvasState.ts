import type { DocumentSaveState } from '@connorhoehn/ui-components/doc-editor';

export function documentCanvasSaveState(state: 'idle' | 'pending' | 'saved' | 'error', pending: number, online: boolean, retry: () => void): DocumentSaveState | undefined {
  if (state === 'idle') return undefined;
  return {
    status: !online && pending > 0 ? 'offline' : state,
    ...(state === 'error' || !online ? { onRetry: retry } : {}),
  };
}

/** Auth expiry is independent of whether a socket is open. The grant is the
 * authority on editing: the BFF issues `edit` only to a role that may edit,
 * prompts included — a prompt is edited through its draft (goal decision 7). */
export function canEditDocumentCanvas(grant: { canEdit: boolean; expiresAt: number }, accessValid: boolean, now = Date.now()): boolean {
  return accessValid && grant.canEdit && grant.expiresAt > now;
}
