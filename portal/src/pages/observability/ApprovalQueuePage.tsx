// Human-in-the-loop approval queue. Initial list via REST; live updates via
// SSE. Approve/Reject decisions POST back with optional note. Optimistic UI
// removes the row immediately; SSE 'decision' confirms (or another tab acts).
//
// Endpoints:
//   GET  /api/observability/approvals?status=PENDING
//   GET  /api/observability/approvals/stream            (SSE)
//   POST /api/observability/approvals/:id/decision      { decision, note? }

import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Chip,
  CodeBlock,
  Inline,
  Input,
  LiveRegion,
  PageSection,
  StatusDot,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { T } from './Text';

interface Approval {
  approvalId: string;
  txId: string;
  agentId: string;
  payload: unknown;
  reason: string;
  requestedAt: string;
}

interface ApprovalEvent {
  type: 'approval';
  id: string;
  txId: string;
  agentId: string;
  payload: unknown;
  reason: string;
  requestedAt: string;
}

interface DecisionEvent {
  type: 'decision';
  id: string;
  status: 'APPROVED' | 'REJECTED';
  decidedBy: string;
  decidedAt: string;
}

type StreamEvent = ApprovalEvent | DecisionEvent;

function ApprovalQueuePage() {
  // Deciding an approval is Cedar's ApproveTransaction — the same action the
  // decision endpoint enforces.
  const { can, ready } = useCapabilities();
  const canApprove = ready && can('ApproveTransaction');
  const [items, setItems] = useState<Approval[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expandedPayload, setExpandedPayload] = useState<Set<string>>(new Set());
  const [denied, setDenied] = useState<Record<string, true>>({});
  // Per-row lock so a double-click (or a slow network + an impatient click)
  // can't fire the same decision twice — the second Approve used to land on
  // a row the first request had already removed, silently no-op'ing against
  // a 404 with nothing on screen to say so.
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Initial fetch. Tolerate 404 with empty list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/observability/approvals?status=PENDING', {
          credentials: 'include',
        });
        if (!res.ok) return;
        const json = (await res.json()) as { approvals?: Approval[] } | Approval[];
        const list = Array.isArray(json) ? json : (json.approvals ?? []);
        if (!cancelled) setItems(list);
      } catch {
        // swallow — empty state handles it
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // SSE stream. Prepend approvals; drop on decision.
  useEffect(() => {
    const es = new EventSource('/api/observability/approvals/stream', {
      withCredentials: true,
    });
    es.onopen = () => setStreaming(true);
    es.onerror = () => {
      // EventSource fires onerror on every transient reconnect — only treat
      // CLOSED (terminal) as actually disconnected. CONNECTING is the browser
      // automatically re-establishing and is not user-visible failure.
      if (es.readyState === EventSource.CLOSED) setStreaming(false);
    };
    es.onmessage = (ev) => {
      try {
        const obj = JSON.parse(ev.data) as StreamEvent;
        if (obj.type === 'approval') {
          setItems((prev) => {
            if (prev.some((p) => p.approvalId === obj.id)) return prev;
            return [
              {
                approvalId: obj.id,
                txId: obj.txId,
                agentId: obj.agentId,
                payload: obj.payload,
                reason: obj.reason,
                requestedAt: obj.requestedAt,
              },
              ...prev,
            ];
          });
        } else if (obj.type === 'decision') {
          setItems((prev) => prev.filter((p) => p.approvalId !== obj.id));
        }
      } catch {
        // malformed event — ignore
      }
    };
    return () => es.close();
  }, []);

  function togglePayload(id: string) {
    setExpandedPayload((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(id: string, decision: 'APPROVED' | 'REJECTED') {
    if (busy.has(id)) return;
    const snapshot = items.find((i) => i.approvalId === id);
    if (!snapshot) return;
    const note = notes[id]?.trim() || undefined;

    setBusy((prev) => new Set(prev).add(id));
    // Optimistic remove.
    setItems((prev) => prev.filter((p) => p.approvalId !== id));
    const tid = toastPending(
      decision === 'APPROVED' ? 'Approving' : 'Rejecting',
      snapshot.reason,
    );

    const res = await writeJson(
      `/api/observability/approvals/${encodeURIComponent(id)}/decision`,
      'POST',
      { decision, note },
    );

    if (!res.ok) {
      // Restore the row on any failure — the optimistic remove was wrong.
      setItems((prev) => [snapshot, ...prev]);
      if (res.status === 403) {
        setDenied((d) => ({ ...d, [id]: true }));
        toastError(tid, 'Not authorized', res.error ?? 'you cannot decide this approval');
      } else {
        toastError(tid, decision === 'APPROVED' ? 'Approve failed' : 'Reject failed', res.error ?? 'unknown error');
      }
    } else {
      toastSuccess(tid, decision === 'APPROVED' ? 'Approved' : 'Rejected');
    }

    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
      ),
    [items],
  );

  return (
    <PageSection
      title="Approval Queue"
      description="Pending HITL approvals. Initial list via REST; live updates over SSE. Decisions are optimistic — denied requests reappear with a danger chip."
      actions={
        <Inline gap="sm" align="center" className="text-[11px] text-text-secondary">
          <StatusDot
            color={streaming ? 'var(--color-success)' : 'var(--color-text-tertiary)'}
            size="sm"
          />
          <T>{streaming ? 'live' : 'reconnecting…'}</T>
          <T className="text-text-tertiary">·</T>
          <T><strong>{sorted.length}</strong> pending</T>
          <LiveRegion
            politeness="polite"
            message={`${sorted.length} approval${sorted.length === 1 ? '' : 's'} pending`}
          />
        </Inline>
      }
    >
      <Card padding="md">
        {sorted.length === 0 ? (
          <SmartEmptyState
            title="No pending approvals"
            detail="Approvals arrive when an agent calls its request_approval tool. You can also seed one over HTTP for a smoke test."
            actions={[
              {
                label: 'Seed a pending approval via HTTP',
                code: 'python3 -c \'import requests; requests.post("http://localhost:3001/api/observability/approvals/request", json={"txId":"tx-001","agentId":"orgiq-ingestion","payload":{"amount":15000},"reason":"smoke test"})\'',
              },
            ]}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Requested</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Tx</TableTh>
                <TableTh>Reason</TableTh>
                <TableTh>Payload</TableTh>
                <TableTh>Decision</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((a) => {
                const open = expandedPayload.has(a.approvalId);
                return (
                  <Fragment key={a.approvalId}>
                    <TableRow>
                      <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                        {new Date(a.requestedAt).toLocaleTimeString()}
                      </TableTd>
                      <TableTd className="text-[12px] font-medium whitespace-nowrap">{a.agentId}</TableTd>
                      <TableTd className="text-[11px] text-text-tertiary font-mono" title={a.txId}>
                        {a.txId.length > 12 ? `${a.txId.slice(0, 12)}…` : a.txId}
                      </TableTd>
                      <TableTd className="text-[12px] max-w-[320px] truncate" title={a.reason}>
                        {a.reason}
                      </TableTd>
                      <TableTd>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => togglePayload(a.approvalId)}
                        >
                          {open ? 'hide' : 'show'}
                        </Button>
                      </TableTd>
                      <TableTd>
                        {canApprove ? (
                          <Inline gap="xs" align="center" wrap>
                            <Input
                              size="sm"
                              value={notes[a.approvalId] ?? ''}
                              onChange={(e) =>
                                setNotes((m) => ({ ...m, [a.approvalId]: e.target.value }))
                              }
                              placeholder="note (optional)"
                              className="min-w-[140px]"
                            />
                            <Button
                              variant="primary"
                              size="sm"
                              disabled={busy.has(a.approvalId)}
                              onClick={() => decide(a.approvalId, 'APPROVED')}
                            >
                              {busy.has(a.approvalId) ? 'Approving…' : 'Approve'}
                            </Button>
                            <Button
                              variant="danger-solid"
                              size="sm"
                              disabled={busy.has(a.approvalId)}
                              onClick={() => decide(a.approvalId, 'REJECTED')}
                            >
                              {busy.has(a.approvalId) ? 'Rejecting…' : 'Reject'}
                            </Button>
                            {denied[a.approvalId] && (
                              <Chip tone="danger" size="xs">
                                Not authorized
                              </Chip>
                            )}
                          </Inline>
                        ) : (
                          <T className="text-[11px] text-text-tertiary italic">
                            Viewing only — your role can&apos;t decide approvals
                          </T>
                        )}
                      </TableTd>
                    </TableRow>
                    {open && (
                      <TableRow key={`${a.approvalId}-payload`}>
                        <TableTd colSpan={6} className="p-3 bg-bg">
                          <CodeBlock code={safeJson(a.payload)} language="json" />
                        </TableTd>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageSection>
  );
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export default ApprovalQueuePage;
