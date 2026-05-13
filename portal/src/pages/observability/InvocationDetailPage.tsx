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
import { SaveAsTestCaseModal } from '../../components/observability/SaveAsTestCaseModal';

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

  const [toast, setToast] = useState<React.ReactNode | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  async function onReplay() {
    if (!invocationId) return;
    setReplayLoading(true);
    try {
      const res = await fetch(
        `/api/observability/invocations/${encodeURIComponent(invocationId)}/replay`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status === 200 && typeof (body as { invocationId?: unknown }).invocationId === 'string') {
        const newId = (body as { invocationId: string }).invocationId;
        const dur = Number((body as { durationMs?: unknown }).durationMs) || 0;
        setToast(
          <span>
            Replayed in {(dur / 1000).toFixed(1)}s ·{' '}
            <Link to={`/observability/invocations/${newId}`} style={btnLink}>
              open replay →
            </Link>
          </span>,
        );
      } else if (res.status === 501) {
        setToast('Replay coming soon');
      } else {
        const msg = (body as { message?: string; error?: string }).message
          ?? (body as { error?: string }).error
          ?? `${res.status} ${res.statusText}`;
        setToast(`Replay failed: ${msg}`);
      }
    } catch (e) {
      setToast(`Replay failed: ${e instanceof Error ? e.message : 'unknown'}`);
    } finally {
      setReplayLoading(false);
      setTimeout(() => setToast(null), 6500);
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

      <SaveAsTestCaseModal
        invocation={{
          invocationId,
          agentId: inv.agentId ?? '',
          templateId: inv.templateId ?? null,
          prompt,
          response,
        }}
        isOpen={saveOpen}
        onClose={() => setSaveOpen(false)}
        onSuccess={(testId) =>
          setToast(
            <span>
              Test case <strong>{testId}</strong> saved.{' '}
              <Link to="/observability/harness" style={btnLink}>
                View in harness →
              </Link>
            </span>,
          )
        }
      />
    </div>
  );
}

// ── sub-components ────────────────────────────────────────────────────────────

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


export default InvocationDetailPage;
