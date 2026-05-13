// InvocationDetailPage — full triage surface for one invocation.
//
// Endpoint: GET /api/observability/invocations/:invocationId
// Returns: { invocation, toolCalls, parent, children: [{ ..., grandchildren }] }
//
// Sections (cards): header → trace tree → tool waterfall → prompt → response
// → judge → raw metadata (collapsed). Replay button posts to /replay; backend
// returns 501 currently, surfaced via a small toast.

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import {
  Card,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { CostChip } from '../../components/observability/CostChip';
import { PromptVersionChip } from '../../components/observability/PromptVersionChip';
import { ModeChip } from '../../components/observability/ModeChip';
import { TraceTree } from '../../components/observability/TraceTree';
import type { TraceNode } from '../../components/observability/TraceTree';
import { ToolWaterfall } from '../../components/observability/ToolWaterfall';
import type { ToolCall } from '../../components/observability/ToolWaterfall';
import { GuardrailRuleBadge } from '../../components/observability/GuardrailRuleBadge';

// The "invocation" payload is intentionally permissive — Agent A's backend
// returns every column from invocation_traces, so we type the known fields
// and leave the rest as `unknown` for the raw-metadata viewer.
interface InvocationRow {
  invocationId: string;
  agentId: string;
  agentName?: string | null;
  templateId?: string | null;
  prompt?: string | null;
  response?: string | null;
  promptSnippet?: string | null;
  responseSnippet?: string | null;
  judgeScore?: number | null;
  judgeRationale?: string | null;
  schemaValid?: boolean | null;
  guardrailAction?: string | null;
  durationMs?: number | null;
  totalCostUsd?: number | null;
  estCostUsd?: number | null;
  promptVersion?: string | null;
  modelId?: string | null;
  parentInvocationId?: string | null;
  ts?: string;
  startedAt?: string;
  [key: string]: unknown;
}

interface ParentSummary {
  invocationId: string;
  agentId: string;
  agentName?: string | null;
  ts?: string;
  judgeScore?: number | null;
  durationMs?: number | null;
  totalCostUsd?: number | null;
}

interface ChildSummary extends ParentSummary {
  grandchildren?: ChildSummary[];
}

interface DetailResponse {
  invocation: InvocationRow;
  toolCalls: ToolCall[];
  parent: ParentSummary | null;
  children: ChildSummary[];
}

const fmtDur = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
};

const judgeTone = (v: number | null | undefined) => {
  if (v == null) return 'neutral' as const;
  if (v >= 0.75) return 'success' as const;
  if (v >= 0.55) return 'warning' as const;
  return 'danger' as const;
};

function childToNode(c: ChildSummary): TraceNode {
  return {
    invocationId: c.invocationId,
    agentId: c.agentId,
    agentName: c.agentName ?? undefined,
    judgeScore: c.judgeScore ?? null,
    durationMs: c.durationMs ?? null,
    totalCostUsd: c.totalCostUsd ?? null,
    ts: c.ts,
    children: (c.grandchildren ?? []).map(childToNode),
  };
}

function InvocationDetailPage() {
  const params = useParams<{ invocationId: string }>();
  const invocationId = params.invocationId ?? '';

  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail pages fetch only on mount — no polling.
  useEffect(() => {
    if (!invocationId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/observability/invocations/${encodeURIComponent(invocationId)}`, {
      credentials: 'include',
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((j: DetailResponse) => {
        if (!cancelled) setDetail(j);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Fetch failed');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invocationId]);

  const [toast, setToast] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  async function onReplay() {
    if (!invocationId) return;
    setReplayLoading(true);
    try {
      const res = await fetch(
        `/api/observability/invocations/${encodeURIComponent(invocationId)}/replay`,
        { method: 'POST', credentials: 'include' },
      );
      if (res.status === 501) {
        setToast('Replay coming soon');
      } else if (!res.ok) {
        setToast(`Replay failed: ${res.status} ${res.statusText}`);
      } else {
        setToast('Replay queued.');
      }
    } catch (e) {
      setToast(`Replay failed: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setReplayLoading(false);
      setTimeout(() => setToast(null), 3500);
    }
  }

  const [saveOpen, setSaveOpen] = useState(false);

  if (!invocationId) {
    return (
      <ErrorBlock title="Missing invocation id" detail="No id in the URL." />
    );
  }
  if (loading && !detail) {
    return (
      <div style={pageStyle}>
        <Card padding="md">
          <div style={{ padding: 24, color: 'var(--color-text-tertiary)', fontSize: 12 }}>
            Loading invocation…
          </div>
        </Card>
      </div>
    );
  }
  if (error || !detail) {
    return (
      <ErrorBlock
        title="Could not load invocation"
        detail={
          error ??
          'The backend may not have the detail endpoint yet, or this invocation has not been indexed.'
        }
        invocationId={invocationId}
      />
    );
  }

  const inv = detail.invocation ?? ({} as InvocationRow);
  const toolCalls = Array.isArray(detail.toolCalls) ? detail.toolCalls : [];
  const parent = detail.parent ?? null;
  const childrenNodes: TraceNode[] = Array.isArray(detail.children)
    ? detail.children.map(childToNode)
    : [];

  const agentName = inv.agentName ?? inv.agentId ?? 'unknown agent';
  const ts = inv.ts ?? inv.startedAt ?? null;
  const totalCost = inv.totalCostUsd ?? null;
  const prompt =
    (inv.prompt as string | undefined) ??
    (inv.promptSnippet as string | undefined) ??
    '';
  const response =
    (inv.response as string | undefined) ??
    (inv.responseSnippet as string | undefined) ??
    '';

  const modeFromTemplate =
    typeof inv.templateId === 'string' && inv.templateId.startsWith('test:')
      ? 'sim'
      : null;

  const currentNode: TraceNode = {
    invocationId,
    agentId: inv.agentId ?? '',
    agentName: typeof inv.agentName === 'string' ? inv.agentName : undefined,
    judgeScore: inv.judgeScore ?? null,
    durationMs: inv.durationMs ?? null,
    totalCostUsd: totalCost,
    ts: ts ?? undefined,
  };

  const parentNode: TraceNode | null = parent
    ? {
        invocationId: parent.invocationId,
        agentId: parent.agentId,
        agentName: parent.agentName ?? undefined,
        judgeScore: parent.judgeScore ?? null,
        durationMs: parent.durationMs ?? null,
        totalCostUsd: parent.totalCostUsd ?? null,
        ts: parent.ts,
      }
    : null;

  const hasTrace = parentNode != null || childrenNodes.length > 0;

  return (
    <div style={pageStyle}>
      {toast && <div style={toastStyle}>{toast}</div>}

      <Card padding="md">
        <div style={headerRow}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <h2 style={h2title}>{agentName}</h2>
              {ts && (
                <span style={subdued}>
                  {new Date(ts).toLocaleString()}
                </span>
              )}
            </div>
            <div style={monoLine}>{invocationId}</div>
            <div style={chipRow}>
              <span style={chipLabel}>judge</span>
              <Chip tone={judgeTone(inv.judgeScore)} size="xs">
                {inv.judgeScore != null && Number.isFinite(inv.judgeScore)
                  ? Number(inv.judgeScore).toFixed(2)
                  : '—'}
              </Chip>
              <SchemaChip valid={inv.schemaValid ?? null} />
              {inv.guardrailAction && (
                <Chip tone="warning" size="xs">
                  {String(inv.guardrailAction)}
                </Chip>
              )}
              {modeFromTemplate && <ModeChip mode={modeFromTemplate} />}
              <CostChip cost={totalCost} />
              <PromptVersionChip promptVersion={inv.promptVersion ?? null} />
              {inv.modelId && (
                <span style={monoInline} title="model id">
                  {String(inv.modelId)}
                </span>
              )}
              <span style={subduedSmall}>· duration {fmtDur(inv.durationMs)}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            <Link to="/observability/invocations/search" style={btnLink}>
              ← Back to search
            </Link>
            <div style={btnGroup}>
              <button
                type="button"
                onClick={onReplay}
                disabled={replayLoading}
                style={{ ...btnPrimary, opacity: replayLoading ? 0.6 : 1 }}
                title="Replay this invocation (backend may return 501 — replay coming soon)"
              >
                {replayLoading ? 'Replaying…' : 'Replay'}
              </button>
              <button
                type="button"
                onClick={() => setSaveOpen(true)}
                style={btnSecondary}
              >
                + Save as test case
              </button>
            </div>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>Trace chain</h2>
        </div>
        {hasTrace ? (
          <TraceTree
            parent={parentNode}
            current={currentNode}
            children={childrenNodes}
            currentInvocationId={invocationId}
          />
        ) : (
          <EmptyState text="This invocation has no recorded parent or child invocations yet." />
        )}
      </Card>

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>
            Tool calls{' '}
            <span style={hint}>
              {toolCalls.length} call{toolCalls.length === 1 ? '' : 's'}
            </span>
          </h2>
        </div>
        <ToolWaterfall toolCalls={toolCalls} />
      </Card>

      <MemoryOperationsCard invocationId={invocationId} />

      {inv.guardrailAction && inv.guardrailAction !== 'NONE' && (
        <GuardrailTraceCard invocationId={invocationId} />
      )}

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>Prompt</h2>
        </div>
        {prompt ? (
          <pre style={detailPre}>{prompt}</pre>
        ) : (
          <EmptyState text="No prompt text captured for this invocation." />
        )}
      </Card>

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>Response</h2>
        </div>
        {response ? (
          <pre style={detailPre}>{response}</pre>
        ) : (
          <EmptyState text="No response text captured for this invocation." />
        )}
      </Card>

      <Card padding="md">
        <div style={headerRow}>
          <h2 style={h2}>Judge</h2>
        </div>
        <div style={judgeRow}>
          <Chip tone={judgeTone(inv.judgeScore)} size="sm">
            {inv.judgeScore != null && Number.isFinite(inv.judgeScore)
              ? Number(inv.judgeScore).toFixed(2)
              : '—'}
          </Chip>
          {inv.judgeRationale ? (
            <p style={judgePara}>{inv.judgeRationale}</p>
          ) : (
            <span style={subduedSmall}>(no rationale recorded)</span>
          )}
        </div>
      </Card>

      <RawMetadataCard invocation={inv} />

      {saveOpen && (
        <SaveAsTestCaseModal
          prompt={prompt}
          response={response}
          onClose={() => setSaveOpen(false)}
        />
      )}
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

// Sprint 4 (M11) — what AgentCore Memory ops happened during this invocation?
// Fetched on mount. Empty state when no memory events recorded for the row.
interface MemoryEventRow {
  memoryEventId: string;
  kind: string;
  sessionId: string | null;
  queryText: string | null;
  resultCount: number | null;
  durationMs: number | null;
  retrievedSummary: string | null;
  errored: boolean;
  errorMessage: string | null;
  ts: string;
}

function MemoryOperationsCard({ invocationId }: { invocationId: string }) {
  const [events, setEvents] = useState<MemoryEventRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    fetch(
      `/api/observability/memory/events?invocationId=${encodeURIComponent(invocationId)}&limit=50`,
      { credentials: 'include' },
    )
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((j: { events?: MemoryEventRow[] }) => {
        if (!cancelled) setEvents(j.events ?? []);
      })
      .catch(() => { if (!cancelled) setEvents([]); });
    return () => { cancelled = true; };
  }, [invocationId]);

  const count = events?.length ?? 0;
  return (
    <Card padding="md">
      <div style={headerRow}>
        <h2 style={h2}>
          Memory operations{' '}
          <span style={hint}>
            {events == null ? 'loading…' : `${count} op${count === 1 ? '' : 's'}`}
          </span>
        </h2>
      </div>
      {events == null ? (
        <div style={loadingHint}>Loading…</div>
      ) : events.length === 0 ? (
        <EmptyState text="No memory operations recorded for this invocation." />
      ) : (
        <div style={memoryList}>
          {events.map((e) => (
            <div key={e.memoryEventId} style={memoryRow}>
              <div style={memoryRowHeader}>
                <Chip
                  tone={
                    e.errored
                      ? 'danger'
                      : e.kind === 'retrieve' && e.resultCount === 0
                        ? 'warning'
                        : 'neutral'
                  }
                  size="xs"
                >
                  {e.kind}
                </Chip>
                <span style={subduedSmall}>
                  {e.resultCount == null ? '—' : `${e.resultCount} result${e.resultCount === 1 ? '' : 's'}`}
                </span>
                <span style={subduedSmall}>·</span>
                <span style={subduedSmall}>
                  {e.durationMs == null ? '—' : `${e.durationMs}ms`}
                </span>
                {e.sessionId && (
                  <>
                    <span style={subduedSmall}>·</span>
                    <span style={subduedSmall}>session {e.sessionId}</span>
                  </>
                )}
              </div>
              {e.queryText && (
                <div style={memoryQuery}>{e.queryText}</div>
              )}
              {e.retrievedSummary && (
                <pre style={memoryPre}>{e.retrievedSummary}</pre>
              )}
              {e.errored && e.errorMessage && (
                <pre style={{ ...memoryPre, color: 'var(--color-danger, #ef4444)' }}>
                  {e.errorMessage}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Sprint 4 (M12) — guardrail rule trace: only rendered when the invocation's
// guardrailAction is non-NONE. Fetches per-rule rows so the operator can see
// *which* rules fired + on what substring.
interface GuardrailInterventionRow {
  interventionId: string;
  ruleName: string;
  ruleCategory: string | null;
  severity: string | null;
  action: string;
  matchedText: string | null;
  ts: string;
}

function GuardrailTraceCard({ invocationId }: { invocationId: string }) {
  const [rows, setRows] = useState<GuardrailInterventionRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    fetch(
      `/api/observability/guardrails-detail/interventions?invocationId=${encodeURIComponent(invocationId)}&limit=50`,
      { credentials: 'include' },
    )
      .then((r) => (r.ok ? r.json() : { interventions: [] }))
      .then((j: { interventions?: GuardrailInterventionRow[] }) => {
        if (!cancelled) setRows(j.interventions ?? []);
      })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [invocationId]);

  return (
    <Card padding="md">
      <div style={headerRow}>
        <h2 style={h2}>
          Guardrail trace{' '}
          <span style={hint}>
            {rows == null ? 'loading…' : `${rows.length} rule${rows.length === 1 ? '' : 's'} fired`}
          </span>
        </h2>
      </div>
      {rows == null ? (
        <div style={loadingHint}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState text="The invocation was intervened on, but no rule-level breakdown was captured." />
      ) : (
        <div style={memoryList}>
          {rows.map((r) => (
            <div key={r.interventionId} style={memoryRow}>
              <div style={memoryRowHeader}>
                <GuardrailRuleBadge
                  ruleName={r.ruleName}
                  action={r.action}
                  severity={r.severity}
                />
                {r.ruleCategory && (
                  <span style={subduedSmall}>{r.ruleCategory}</span>
                )}
                {r.severity && (
                  <span style={subduedSmall}>severity {r.severity}</span>
                )}
              </div>
              {r.matchedText && (
                <pre style={memoryPre}>{r.matchedText}</pre>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function SchemaChip({ valid }: { valid: boolean | null }) {
  if (valid == null) {
    return (
      <Chip tone="neutral" size="xs">
        schema —
      </Chip>
    );
  }
  return valid ? (
    <Chip tone="success" size="xs">
      ✓ schema
    </Chip>
  ) : (
    <Chip tone="danger" size="xs">
      ✗ schema
    </Chip>
  );
}

function RawMetadataCard({ invocation }: { invocation: InvocationRow }) {
  const [open, setOpen] = useState(false);
  const json = useMemo(() => {
    try {
      return JSON.stringify(invocation, null, 2);
    } catch {
      return '{}';
    }
  }, [invocation]);
  return (
    <Card padding="md">
      <div style={headerRow}>
        <h2 style={h2}>
          <button
            onClick={() => setOpen((v) => !v)}
            style={collapseBtn}
            aria-expanded={open}
          >
            {open ? '▾' : '▸'} Raw metadata
          </button>{' '}
          <span style={hint}>full invocation_traces row · JSON</span>
        </h2>
      </div>
      {open && <pre style={detailPre}>{json}</pre>}
    </Card>
  );
}

function SaveAsTestCaseModal({
  prompt,
  response,
  onClose,
}: {
  prompt: string;
  response: string;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={overlayStyle}>
      <div onClick={(e) => e.stopPropagation()} style={modalStyle}>
        <div style={modalHeader}>
          <h3 style={modalTitle}>Save as test case</h3>
          <button onClick={onClose} style={closeBtn} aria-label="Close">
            ×
          </button>
        </div>
        <div style={modalBody}>
          <p style={modalHint}>
            Sprint 3 will wire this to the harness test suite. For now, edit and copy
            the prompt + expected response below.
          </p>
          <label style={modalFieldLabel}>PROMPT</label>
          <textarea
            defaultValue={prompt}
            style={modalTextarea}
            rows={6}
          />
          <label style={modalFieldLabel}>EXPECTED RESPONSE</label>
          <textarea
            defaultValue={response}
            style={modalTextarea}
            rows={8}
          />
        </div>
      </div>
    </div>
  );
}

function ErrorBlock({
  title,
  detail,
  invocationId,
}: {
  title: string;
  detail: string;
  invocationId?: string;
}) {
  return (
    <div style={pageStyle}>
      <Card padding="md">
        <div style={headerRow}>
          <div>
            <h2 style={h2title}>{title}</h2>
            {invocationId && (
              <div style={monoLine}>id: {invocationId}</div>
            )}
            <div style={{ ...subdued, marginTop: 4 }}>{detail}</div>
          </div>
          <Link to="/observability/invocations/search" style={btnLink}>
            ← Back to search
          </Link>
        </div>
      </Card>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        fontSize: 12,
        color: 'var(--color-text-tertiary)',
      }}
    >
      {text}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const pageStyle: CSSProperties = {
  padding: 24,
  display: 'flex',
  flexDirection: 'column',
  gap: 24,
};

const headerRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  marginBottom: 12,
  gap: 12,
  flexWrap: 'wrap',
};

const h2: CSSProperties = { fontSize: 14, fontWeight: 600, margin: 0 };
const h2title: CSSProperties = { fontSize: 18, fontWeight: 600, margin: 0 };
const hint: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontWeight: 400,
};

const subdued: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const subduedSmall: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
};

const monoLine: CSSProperties = {
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  color: 'var(--color-text-tertiary)',
  wordBreak: 'break-all',
};

const monoInline: CSSProperties = {
  fontFamily: 'ui-monospace, monospace',
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
};

const chipRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const chipLabel: CSSProperties = {
  fontSize: 10,
  color: 'var(--color-text-tertiary)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};

const judgeRow: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
};

const judgePara: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  lineHeight: 1.5,
};

const btnLink: CSSProperties = {
  padding: '2px 8px',
  fontSize: 12,
  color: 'var(--color-primary, #6366f1)',
  textDecoration: 'none',
};

const btnGroup: CSSProperties = {
  display: 'flex',
  gap: 6,
};

const btnPrimary: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  fontWeight: 500,
  background: 'var(--color-primary, #6366f1)',
  color: '#fff',
  border: '1px solid var(--color-primary, #6366f1)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const btnSecondary: CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
  background: 'var(--color-surface)',
  color: 'var(--color-text-secondary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  cursor: 'pointer',
};

const collapseBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  margin: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--color-text-primary)',
  cursor: 'pointer',
};

const detailPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '10px 12px',
  borderRadius: 4,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  maxHeight: 360,
  overflowY: 'auto',
};

const loadingHint: CSSProperties = {
  padding: 16,
  fontSize: 12,
  color: 'var(--color-text-tertiary)',
};

const memoryList: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const memoryRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-bg)',
};

const memoryRowHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
};

const memoryQuery: CSSProperties = {
  fontSize: 12,
  color: 'var(--color-text-secondary)',
  fontStyle: 'italic',
};

const memoryPre: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  margin: 0,
  padding: '8px 10px',
  borderRadius: 3,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  maxHeight: 200,
  overflowY: 'auto',
};

const toastStyle: CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  zIndex: 1100,
  padding: '10px 14px',
  fontSize: 12,
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
};

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 24,
};

const modalStyle: CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  minWidth: 480,
  maxWidth: 760,
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
};

const modalHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid var(--color-border)',
};

const modalTitle: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 };

const closeBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 20,
  lineHeight: 1,
  color: 'var(--color-text-tertiary)',
  cursor: 'pointer',
  padding: '0 4px',
};

const modalBody: CSSProperties = {
  padding: 16,
  overflowY: 'auto',
  fontSize: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const modalHint: CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontStyle: 'italic',
};

const modalFieldLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-text-tertiary)',
  letterSpacing: 0.5,
  textTransform: 'uppercase',
};

const modalTextarea: CSSProperties = {
  fontFamily: '"Fira Code", "Cascadia Code", monospace',
  fontSize: 11.5,
  padding: '8px 10px',
  border: '1px solid var(--color-border)',
  borderRadius: 4,
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  resize: 'vertical',
};

export default InvocationDetailPage;
