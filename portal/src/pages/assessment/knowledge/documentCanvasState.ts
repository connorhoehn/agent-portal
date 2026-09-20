import type { DocumentSaveState } from '@connorhoehnslalom/ui-components/doc-editor';

export function documentCanvasSaveState(state: 'idle' | 'pending' | 'saved' | 'error', pending: number, online: boolean, retry: () => void): DocumentSaveState | undefined {
  if (state === 'idle') return undefined;
  return {
    status: !online && pending > 0 ? 'offline' : state,
    ...(state === 'error' || !online ? { onRetry: retry } : {}),
  };
}

/** Auth expiry and source prompts are independent of whether a socket is open. */
export function canEditDocumentCanvas(grant: { canEdit: boolean; expiresAt: number }, mode: string, accessValid: boolean, now = Date.now()): boolean {
  return accessValid && grant.canEdit && grant.expiresAt > now && mode !== 'prompts';
}
