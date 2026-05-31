// Human-in-the-loop approval queue. Initial list via REST; live updates via
// SSE. Approve/Reject decisions POST back with optional note. Optimistic UI
// removes the row immediately; SSE 'decision' confirms (or another tab acts).
//
// Endpoints:
//   GET  /api/observability/approvals?status=PENDING
//   GET  /api/observability/approvals/stream            (SSE)
//   POST /api/observability/approvals/:id/decision      { decision, note? }

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';

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
  const [items, setItems] = useState<Approval[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expandedPayload, setExpandedPayload] = useState<Set<string>>(new Set());
  const [denied, setDenied] = useState<Record<string, true>>({});

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
    const snapshot = items.find((i) => i.approvalId === id);
    if (!snapshot) return;
    const note = notes[id]?.trim() || undefined;

    // Optimistic remove.
    setItems((prev) => prev.filter((p) => p.approvalId !== id));

    try {
      const res = await fetch(
        `/api/observability/approvals/${encodeURIComponent(id)}/decision`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ decision, note }),
        },
      );
      if (res.status === 403) {
        // Cedar denied — restore row and mark as denied.
        setItems((prev) => [snapshot, ...prev]);
        setDenied((d) => ({ ...d, [id]: true }));
        return;
      }
      if (!res.ok) {
        // Other failure — restore row, no special flag.
        setItems((prev) => [snapshot, ...prev]);
      }
    } catch {
      setItems((prev) => [snapshot, ...prev]);
    }
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
        <div style={liveIndicator}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: streaming
                ? 'var(--color-success, #10b981)'
                : 'var(--color-text-tertiary)',
            }}
          />
          {streaming ? 'live' : 'reconnecting…'}
          <span style={{ color: 'var(--color-text-tertiary)' }}>·</span>
          <span>
            <strong>{sorted.length}</strong> pending
          </span>
        </div>
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
                      <TableTd style={tsCell}>
                        {new Date(a.requestedAt).toLocaleTimeString()}
                      </TableTd>
                      <TableTd style={agentCell}>{a.agentId}</TableTd>
                      <TableTd style={monoCell} title={a.txId}>
                        {a.txId.length > 12 ? `${a.txId.slice(0, 12)}…` : a.txId}
                      </TableTd>
                      <TableTd style={reasonCell} title={a.reason}>
                        {a.reason}
                      </TableTd>
                      <TableTd>
                        <button
                          style={btnSecondary}
                          onClick={() => togglePayload(a.approvalId)}
                        >
                          {open ? 'hide' : 'show'}
                        </button>
                      </TableTd>
                      <TableTd>
                        <div style={decideRow}>
                          <input
                            value={notes[a.approvalId] ?? ''}
                            onChange={(e) =>
                              setNotes((m) => ({ ...m, [a.approvalId]: e.target.value }))
                            }
                            placeholder="note (optional)"
                            style={{ ...inputStyle, minWidth: 140 }}
                          />
                          <button
                            style={btnApprove}
                            onClick={() => decide(a.approvalId, 'APPROVED')}
                          >
                            Approve
                          </button>
                          <button
                            style={btnReject}
                            onClick={() => decide(a.approvalId, 'REJECTED')}
                          >
                            Reject
                          </button>
                          {denied[a.approvalId] && (
                            <Chip tone="danger" size="xs">
                              Not authorized
                            </Chip>
                          )}
                        </div>
                      </TableTd>
                    </TableRow>
                    {open && (
                      <TableRow key={`${a.approvalId}-payload`}>
                        <TableTd colSpan={6} style={{ padding: 12, background: 'var(--color-bg)' }}>
                          <pre style={payloadPre}>
                            {safeJson(a.payload)}
                          </pre>
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

const liveIndicator: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 11,
  color: 'var(--color-text-secondary)',
};

const tsCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  whiteSpace: 'nowrap',
};

const agentCell: CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  whiteSpace: 'nowrap',
};

const monoCell: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
};

const reasonCell: CSSProperties = {
  fontSize: 12,
  maxWidth: 320,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const decideRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
};

const inputStyle: CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
};

const btnSecondary: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  background: 'var(--color-surface-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const btnApprove: CSSProperties = {
  ...btnSecondary,
  background: 'var(--color-success, #10b981)',
  color: '#fff',
  border: '1px solid var(--color-success, #10b981)',
};

const btnReject: CSSProperties = {
  ...btnSecondary,
  background: 'var(--color-danger, #dc2626)',
  color: '#fff',
  border: '1px solid var(--color-danger, #dc2626)',
};

const payloadPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  maxHeight: 320,
  overflowY: 'auto',
};

export default ApprovalQueuePage;
