import { useState } from 'react';
import type { DocumentLifecycleStatus, LifecycleAction, LifecycleErrorView } from '@connorhoehn/ui-components/doc-editor';
import { useFetch } from '../../../hooks/useFetch';
import { writeJson } from '../../../lib/writeJson';

interface WorkflowResponse {
  documentId: string;
  lifecycle: { documentId: string; status: DocumentLifecycleStatus; ownerId: string | null; version: number; implicit: boolean };
  availableActions: LifecycleAction[];
  canManageWorkflow?: boolean;
  canClaimOwnership?: boolean;
  outstandingReviews?: Array<{ requestKey: string; reviewerId: string; state: string }>;
}

/** Server-computed actions remain the single lifecycle permission table. */
export function useDocumentWorkflow(sourceId: string, documentId: string, onChanged: () => void) {
  const query = `?id=${encodeURIComponent(sourceId)}`;
  const source = useFetch<WorkflowResponse>(`/api/assessment/knowledge/doc/workflows${query}`, 30_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LifecycleErrorView | null>(null);
  const [latest, setLatest] = useState<WorkflowResponse | null>(null);
  const data = latest && (!source.data || latest.lifecycle.version > source.data.lifecycle.version) ? latest : source.data;
  const valid = data?.lifecycle.documentId === documentId ? data : null;
  async function mutate(path: string, body: unknown) {
    if (busy) return;
    setBusy(true); setError(null);
    const result = await writeJson<WorkflowResponse>(`/api/assessment/knowledge/doc/workflows/${path}${query}`, 'POST', body);
    if (result.ok && result.data?.lifecycle?.documentId === documentId) { setLatest(result.data); onChanged(); }
    else setError({ kind: result.status === 403 || result.status === 401 ? 'forbidden' : result.status === 409 ? 'conflict' : result.status === 400 ? 'invalid' : result.status === 0 ? 'network' : 'unknown', message: result.error ?? 'The document workflow could not be updated.' });
    source.refresh();
    setBusy(false);
  }
  return {
    data: valid, loading: source.isLoading, busy, error,
    unavailable: source.error, refresh: source.refresh, clearError: () => setError(null),
    transition: (action: LifecycleAction, reason?: string) => void mutate('transitions', { action, ...(reason ? { reason } : {}) }),
    claim: () => void mutate('ownership', {}),
  };
}
