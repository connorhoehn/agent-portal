// Human-in-the-loop approval queue. Initial list via REST; live updates via
// SSE. Approve/Reject decisions POST back with optional note. Optimistic UI
// removes the row immediately; SSE 'decision' confirms (or another tab acts).
//
// Endpoints:
//   GET  /api/observability/approvals?status=PENDING
//   GET  /api/observability/approvals/stream            (SSE)
//   POST /api/observability/approvals/:id/decision      { decision, note? }

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { relativeTime, absoluteTime } from '../../lib/relativeTime';
import { Card, CheckIcon, Chip, CloseIcon, CodeBlock, EyeIcon, EyeOffIcon, IconButton, Inline, Input, LiveRegion, PageSection, SearchInput, StatusDot, T, Table, TableBody, TableHead, TableRow, TableTd, TableTh } from '@connorhoehn/ui-components/shared';
import { SmartEmptyState } from '../../components/observability/SmartEmptyState';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { streamStatusLabel } from '../../lib/streamStatus';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { ObservabilityCommandSection } from './ObservabilityCommandSection';
import { RowEmpty } from './ReadState';
import { OBSERVABILITY_GRAMMARS, approvalTarget, matchesAny } from './observabilityCommands';

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
  /** Whether the stream has ever been up, so the first wait is not called a
   *  reconnect. A page that says "reconnecting…" before it has ever connected
   *  reports a failure that has not happened. */
  const [connectedOnce, setConnectedOnce] = useState(false);
  // Why this exists: the seed fetch below used to `return` on !res.ok and
  // swallow its catch, with the comment "empty state handles it". The empty
  // state says "Nothing is waiting on you" — on an APPROVALS queue that is the
  // worst possible thing to say from no data, because the entire purpose of
  // the page is to tell you when something is blocked on your decision.
  const [seedError, setSeedError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [expandedPayload, setExpandedPayload] = useState<Set<string>>(new Set());
  const [denied, setDenied] = useState<Record<string, true>>({});
  // Per-row lock so a double-click (or a slow network + an impatient click)
  // can't fire the same decision twice — the second Approve used to land on
  // a row the first request had already removed, silently no-op'ing against
  // a 404 with nothing on screen to say so.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  /** Bumped by the `refresh` command to reread the pending list. */
  const [reloadKey, setReloadKey] = useState(0);
  /** Ids whose decision POST is in flight, readable from the reread. */
  const deciding = useRef(new Set<string>());

  // Initial fetch. A 404 genuinely means "no such endpoint yet" and is the one
  // status worth tolerating as empty; everything else is a failed read and has
  // to say so.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/observability/approvals?status=PENDING', {
          credentials: 'include',
        });
        if (res.status === 404) return;
        if (!res.ok) {
          if (!cancelled) setSeedError(`the approvals list returned HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as { approvals?: Approval[] } | Approval[];
        const list = Array.isArray(json) ? json : (json.approvals ?? []);
        if (!cancelled) {
          // A reread must not resurrect a row whose decision is in flight
          // (the optimistic remove already took it off the queue).
          setItems(list.filter((a) => !deciding.current.has(a.approvalId)));
          setSeedError(null);
        }
      } catch (err) {
        if (!cancelled) setSeedError((err as Error).message || 'the approvals list could not be reached');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // SSE stream. Prepend approvals; drop on decision.
  useEffect(() => {
    const es = new EventSource('/api/observability/approvals/stream', {
      withCredentials: true,
    });
    es.onopen = () => { setStreaming(true); setConnectedOnce(true); };
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
    deciding.current.add(id);
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

    deciding.current.delete(id);
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  const sorted = useMemo(
    () =>
      items
        .filter((a) => matchesAny(query, a.approvalId, a.txId, a.agentId, a.reason))
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()),
    [items, query],
  );

  const adapter = collectionCommandAdapter(OBSERVABILITY_GRAMMARS.approvals, {
    setQuery,
    refresh: () => setReloadKey((k) => k + 1),
    scopeNote: 'Search matches the pending approvals\' agents, transaction IDs and reasons. Open shows one exact approval\'s payload. Approve and reject stay explicit, permission-checked buttons on the row; this input records no decision.',
    open(target) {
      const { id } = resolveCollectionTarget(target, sorted.map(approvalTarget));
      setExpandedPayload((prev) => new Set(prev).add(id));
      return `Showing the payload for ${id}. No decision was recorded.`;
    },
  });

  return (
    <PageSection
      title="Approvals"
      description="Actions an agent has paused on until a person decides. Approving lets the run continue; denying stops it and tells the agent why."
      actions={
        <Inline gap="sm" align="center" className="text-xs text-text-secondary">
          <StatusDot
            color={streaming ? 'var(--color-success)' : 'var(--color-text-tertiary)'}
            size="sm"
          />
          <T size="sm">{streamStatusLabel(streaming, connectedOnce)}</T>
          <T size="sm" className="text-text-tertiary">·</T>
          <T size="sm"><T size="sm" weight="semibold">{items.length}</T>&nbsp;pending</T>
          <LiveRegion
            politeness="polite"
            message={`${items.length} approval${items.length === 1 ? '' : 's'} pending`}
          />
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search approvals"
            aria-label="Search approvals"
            className="w-[200px]"
          />
        </Inline>
      }
    >
      <ObservabilityCommandSection adapter={adapter}>
      <Card padding="md">
        {sorted.length === 0 && items.length > 0 ? (
          <RowEmpty text="No pending approvals match the current search." />
        ) : sorted.length === 0 ? (
          <SmartEmptyState
            degraded={seedError}
            degradedWhat="the approval queue"
            degradedSource="Pending approvals are read from the middleware, which reads them from Aurora"
            title="Nothing is waiting on you"
            detail="An agent lands here when it reaches an action it is not allowed to take alone — spending over its cap, or writing where a person has to sign off. An empty queue means nothing is currently blocked on a decision."
            actions={[
              {
                label: 'Send a test approval (developer)',
                detail: 'Files one pending request against the local middleware so the queue and the decision buttons can be exercised without waiting for an agent to reach a gate.',
                code: 'python3 -c \'import requests; requests.post("http://localhost:3001/api/observability/approvals/request", json={"txId":"tx-001","agentId":"orgiq-ingestion","payload":{"amount":15000},"reason":"smoke test"})\'',
              },
            ]}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Requested</TableTh>
                <TableTh>Tx</TableTh>
                <TableTh>Reason</TableTh>
                <TableTh>Details</TableTh>
                <TableTh>Decision</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((a) => {
                const open = expandedPayload.has(a.approvalId);
                return (
                  <Fragment key={a.approvalId}>
                    <TableRow>
                      <TableTd className="whitespace-nowrap">{a.agentId}</TableTd>
                      {/* title=, because this is the approvals queue: adjudicating
                          "requested 2h ago" needs the real clock time, and there was
                          nowhere else on the row to read it. */}
                      <TableTd className="text-text-tertiary whitespace-nowrap" title={absoluteTime(a.requestedAt)}>
                        {relativeTime(a.requestedAt)}
                      </TableTd>
                      <TableTd className="text-text-tertiary" title={a.txId}>
                        <T className="font-mono">{a.txId.length > 12 ? `${a.txId.slice(0, 12)}…` : a.txId}</T>
                      </TableTd>
                      <TableTd className="max-w-[320px] truncate" title={a.reason}>
                        {a.reason}
                      </TableTd>
                      <TableTd>
                        <IconButton
                          size="sm"
                          icon={open ? <EyeOffIcon /> : <EyeIcon />}
                          aria-label={open ? 'Hide payload' : 'Show payload'}
                          title={open ? 'Hide payload' : 'Show payload'}
                          onClick={() => togglePayload(a.approvalId)}
                        />
                      </TableTd>
                      <TableTd>
                        <Inline gap="xs" align="center" wrap={false}>
                          {canApprove && (
                            <Input
                              size="sm"
                              value={notes[a.approvalId] ?? ''}
                              onChange={(e) =>
                                setNotes((m) => ({ ...m, [a.approvalId]: e.target.value }))
                              }
                              placeholder="note (optional)"
                              className="w-[140px] shrink-0"
                            />
                          )}
                          {canApprove && (
                            <IconButton
                              variant="primary"
                              size="sm"
                              icon={<CheckIcon />}
                              disabled={busy.has(a.approvalId)}
                              onClick={() => decide(a.approvalId, 'APPROVED')}
                              aria-label={`Approve ${a.agentId} request`}
                              title={busy.has(a.approvalId) ? 'Approving…' : 'Approve'}
                            />
                          )}
                          {canApprove && (
                            <IconButton
                              variant="danger"
                              size="sm"
                              icon={<CloseIcon />}
                              disabled={busy.has(a.approvalId)}
                              onClick={() => decide(a.approvalId, 'REJECTED')}
                              aria-label={`Reject ${a.agentId} request`}
                              title={busy.has(a.approvalId) ? 'Rejecting…' : 'Reject'}
                            />
                          )}
                          {canApprove && denied[a.approvalId] && (
                            <Chip tone="danger" size="xs">
                              Not authorized
                            </Chip>
                          )}
                          {!canApprove && (
                            <T size="xs" className="text-text-tertiary italic">
                              Viewing only — your role can&apos;t decide approvals
                            </T>
                          )}
                        </Inline>
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
      </ObservabilityCommandSection>
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
