import { useEffect } from 'react';
import { DocumentReviewPanel, type DocumentReviewEntry } from '@connorhoehnslalom/ui-components/doc-editor';
import { useGateway } from '@connorhoehnslalom/realtime-modules/client';
import { useFetch } from '../../../hooks/useFetch';
import { sendJson } from '../../../lib/writeJson';
import { DocumentContextPanel } from './ExplorerFrame';

interface ReviewRequest extends DocumentReviewEntry { scope: 'document' | 'section'; documentId: string }

/** Source-scoped BFF delegates identity and permissions; no section IDs are invented for a canvas. */
export function DocumentReviews({ sourceId, documentId, currentUserId, canManage, available, open, onChanged }: {
  sourceId: string; documentId: string; currentUserId: string; canManage: boolean; available: boolean; open: boolean; onChanged: () => void;
}) {
  const gateway = useGateway();
  const base = '/api/assessment/knowledge/doc/workflows';
  const query = `?id=${encodeURIComponent(sourceId)}`;
  const requests = useFetch<{ requests: ReviewRequest[] }>(open ? `${base}/review-requests${query}` : null, 30_000);
  const directory = useFetch<{ reviewers: Array<{ id: string; displayName: string }> }>(open && canManage ? `${base}/reviewers${query}` : null);
  const refresh = () => { requests.refresh(); if (canManage) directory.refresh(); };
  useEffect(() => { if (open && gateway.connectionState === 'connected') requests.refresh(); }, [open, gateway.connectionState, requests.refresh]);
  useEffect(() => gateway.onMessage(message => {
    if (open && message.channel === `doc:${documentId}` && typeof message.type === 'string' && /review|lifecycle/.test(message.type)) requests.refresh();
  }), [gateway.onMessage, open, documentId, requests.refresh]);
  async function update(requestKey: string, body: unknown) {
    await sendJson(`${base}/review-requests/${encodeURIComponent(requestKey)}${query}`, 'PATCH', body);
    requests.refresh(); onChanged();
  }
  const writable = available && !requests.error;
  return <DocumentContextPanel id="reviews"><DocumentReviewPanel currentUserId={currentUserId}
    requests={(requests.data?.requests ?? []).filter(request => request.documentId === documentId && request.scope === 'document')}
    reviewers={directory.data?.reviewers ?? []} loading={requests.isLoading || directory.isLoading}
    error={requests.error ?? directory.error} onRefresh={refresh}
    onDecide={writable ? (key, state, comment) => update(key, { state, comment }) : undefined}
    onWithdraw={canManage && writable ? key => update(key, { state: 'withdrawn' }) : undefined}
    onRequest={canManage && writable && !directory.error ? async input => {
      await sendJson(`${base}/review-requests${query}`, 'POST', input);
      requests.refresh(); onChanged();
    } : undefined} /></DocumentContextPanel>;
}
