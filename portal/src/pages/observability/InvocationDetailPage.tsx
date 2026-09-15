// InvocationDetailPage — full triage surface for one invocation.
//
// Endpoint: GET /api/observability/invocations/:invocationId
// Returns: { invocation, toolCalls, parent, children: [{ ..., grandchildren }] }
//
// Sections (cards): header → trace tree → tool waterfall → prompt → response
// → judge → raw metadata (collapsed). Replay button posts to /replay; backend
// returns 501 currently, surfaced via a small toast.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useCrumbLabel } from '../../lib/crumbLabels';
import {
  Button,
  Card,
  Chip,
  CodeBlock,
  Inline,
  InlineAlert,
  InlinePlaceholder,
  PageSection,
  SectionLabel,
  Stack,
  useToast,
} from '@connorhoehnslalom/ui-components/shared';
import { CostChip } from '../../components/observability/CostChip';
import { PromptVersionChip } from '../../components/observability/PromptVersionChip';
import { ModeChip } from '../../components/observability/ModeChip';
import { TraceTree } from '../../components/observability/TraceTree';
import type { TraceNode } from '../../components/observability/TraceTree';
import { ToolWaterfall } from '../../components/observability/ToolWaterfall';
import type { ToolCall } from '../../components/observability/ToolWaterfall';
import { GuardrailRuleBadge } from '../../components/observability/GuardrailRuleBadge';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { readDegraded } from '../../lib/degraded';
import { SaveAsTestCaseModal } from '../../components/observability/SaveAsTestCaseModal';
import { T } from './Text';

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
  // The trail names the agent this run belongs to; the id stays in the URL.
  useCrumbLabel(invocationId, detail?.invocation?.agentName ?? undefined);

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

  const { toast } = useToast();
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
        toast(`Replayed in ${(dur / 1000).toFixed(1)}s — open replay: /admin/observability/invocations/${newId}`, { type: 'success' });
      } else if (res.status === 501) {
        toast('Replay coming soon');
      } else {
        const msg = (body as { message?: string; error?: string }).message
          ?? (body as { error?: string }).error
          ?? `${res.status} ${res.statusText}`;
        toast(`Replay failed: ${msg}`, { type: 'error' });
      }
    } catch (e) {
      toast(`Replay failed: ${e instanceof Error ? e.message : 'unknown'}`, { type: 'error' });
    } finally {
      setReplayLoading(false);
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
      <PageSection title="Invocation">
        <Card padding="md">
          <T className="text-[12px] text-[var(--color-text-tertiary)]">Loading invocation…</T>
        </Card>
      </PageSection>
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

  // The failure text lives on the errored tool call (invocation_traces has no
  // error column of its own — only tool_calls does, real path and mock alike;
  // see mockInvocationDetail in middleware/src/routes/invocations.ts), and
  // previously surfaced only as that bar's hover `title` — mouse-only, so a
  // keyboard or screen-reader user never saw it (DEFECTS.md #25). State it in
  // visible text above the response instead, on top of the existing red bar
  // and "✗ schema" badge, not in place of them.
  const failureMessage = toolCalls.find((t) => t.errored && t.errorMessage)?.errorMessage ?? null;

  return (
    <PageSection title={agentName}>

      <Card padding="md">
        <Inline align="start" justify="between" wrap gap="sm">
          <Stack gap="sm" className="min-w-0 flex-1">
            {ts && (
              <T className="text-[12px] text-[var(--color-text-secondary)]">
                {new Date(ts).toLocaleString()}
              </T>
            )}
            <T as="div" className="break-all font-mono text-[11px] text-[var(--color-text-tertiary)]">
              {invocationId}
            </T>
            <Inline gap="sm" wrap align="center">
              <T className="text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--color-text-tertiary)]">
                judge
              </T>
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
                <T title="model id" className="font-mono text-[11px] text-[var(--color-text-tertiary)]">
                  {String(inv.modelId)}
                </T>
              )}
              <T className="text-[11px] text-[var(--color-text-tertiary)]">
                · duration {fmtDur(inv.durationMs)}
              </T>
            </Inline>
          </Stack>
          <Stack gap="xs" align="end">
            <Link
              to="/admin/observability/invocations/search"
              className="px-2 py-[2px] text-[12px] text-[var(--color-primary)] no-underline"
            >
              ← Back to search
            </Link>
            <Inline gap="xs">
              <Button
                variant="primary"
                size="sm"
                onClick={onReplay}
                disabled={replayLoading}
                title="Replay this invocation (backend may return 501 — replay coming soon)"
              >
                {replayLoading ? 'Replaying…' : 'Replay'}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setSaveOpen(true)}>
                + Save as test case
              </Button>
            </Inline>
          </Stack>
        </Inline>
      </Card>

      <Card padding="md">
        <SectionLabel as="div" className="mb-3">Trace chain</SectionLabel>
        {hasTrace ? (
          <TraceTree
            parent={parentNode}
            current={currentNode}
            children={childrenNodes}
            currentInvocationId={invocationId}
          />
        ) : (
          <InlinePlaceholder align="center" size="sm">
            This invocation has no recorded parent or child invocations yet.
          </InlinePlaceholder>
        )}
      </Card>

      <Card padding="md">
        <SectionLabel as="div" className="mb-3">
          Tool calls{' '}
          <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
            {toolCalls.length} call{toolCalls.length === 1 ? '' : 's'}
          </T>
        </SectionLabel>
        <ToolWaterfall toolCalls={toolCalls} />
      </Card>

      <MemoryOperationsCard invocationId={invocationId} />

      {inv.guardrailAction && inv.guardrailAction !== 'NONE' && (
        <GuardrailTraceCard invocationId={invocationId} />
      )}

      <Card padding="md">
        <SectionLabel as="div" className="mb-3">Prompt</SectionLabel>
        {prompt ? (
          <CodeBlock code={prompt} language="text" theme="light" className="max-h-[360px] overflow-y-auto" />
        ) : (
          <InlinePlaceholder align="center" size="sm">
            No prompt text captured for this invocation.
          </InlinePlaceholder>
        )}
      </Card>

      <Card padding="md">
        <SectionLabel as="div" className="mb-3">Response</SectionLabel>
        {failureMessage && (
          <InlineAlert tone="error" className="mb-3">
            {failureMessage}
          </InlineAlert>
        )}
        {response ? (
          <CodeBlock code={response} language="text" theme="light" className="max-h-[360px] overflow-y-auto" />
        ) : (
          <InlinePlaceholder align="center" size="sm">
            No response text captured for this invocation.
          </InlinePlaceholder>
        )}
      </Card>

      <Card padding="md">
        <SectionLabel as="div" className="mb-3">Judge</SectionLabel>
        <Inline align="start" gap="sm">
          <Chip tone={judgeTone(inv.judgeScore)} size="sm">
            {inv.judgeScore != null && Number.isFinite(inv.judgeScore)
              ? Number(inv.judgeScore).toFixed(2)
              : '—'}
          </Chip>
          {inv.judgeRationale ? (
            <T as="div" className="text-[12px] leading-[1.5] text-[var(--color-text-secondary)]">
              {inv.judgeRationale}
            </T>
          ) : (
            <T className="text-[11px] text-[var(--color-text-tertiary)]">(no rationale recorded)</T>
          )}
        </Inline>
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
          toast(`Test case ${testId} saved. View in harness: /admin/observability/harness`, { type: 'success' })
        }
      />
    </PageSection>
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
  // Both ways of being blind, kept apart from the honest zero. This card used
  // to `.catch(() => setEvents([]))`, so a dead endpoint and an agent that
  // never touched memory rendered the identical sentence.
  const [failure, setFailure] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setFailure(null);
    fetch(
      `/api/observability/memory/events?invocationId=${encodeURIComponent(invocationId)}&limit=50`,
      { credentials: 'include' },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return (await r.json()) as { events?: MemoryEventRow[] };
      })
      .then((j) => {
        if (cancelled) return;
        setFailure(readDegraded(j));
        setEvents(j.events ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailure(e instanceof Error ? e.message : 'the request failed');
        setEvents([]);
      });
    return () => { cancelled = true; };
  }, [invocationId, reloadKey]);

  const count = events?.length ?? 0;
  return (
    <Card padding="md">
      <SectionLabel as="div" className="mb-3">
        Memory operations{' '}
        <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
          {events == null ? 'loading…' : `${count} op${count === 1 ? '' : 's'}`}
        </T>
      </SectionLabel>
      {failure ? (
        <UnavailableNotice
          error={failure}
          what="this invocation's memory operations"
          source="Memory events are projected into the Aurora observability tables"
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : events == null ? (
        <InlinePlaceholder align="center" size="sm">Loading…</InlinePlaceholder>
      ) : events.length === 0 ? (
        <InlinePlaceholder align="center" size="sm">
          No memory operations recorded for this invocation.
        </InlinePlaceholder>
      ) : (
        <Stack gap="sm">
          {events.map((e) => (
            <Card key={e.memoryEventId} padding="sm" className="bg-[var(--color-bg)]">
              <Stack gap="xs">
                <Inline gap="sm" wrap align="center">
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
                  <T className="text-[11px] text-[var(--color-text-tertiary)]">
                    {e.resultCount == null ? '—' : `${e.resultCount} result${e.resultCount === 1 ? '' : 's'}`}
                  </T>
                  <T className="text-[11px] text-[var(--color-text-tertiary)]">·</T>
                  <T className="text-[11px] text-[var(--color-text-tertiary)]">
                    {e.durationMs == null ? '—' : `${e.durationMs}ms`}
                  </T>
                  {e.sessionId && (
                    <>
                      <T className="text-[11px] text-[var(--color-text-tertiary)]">·</T>
                      <T className="text-[11px] text-[var(--color-text-tertiary)]">session {e.sessionId}</T>
                    </>
                  )}
                </Inline>
                {e.queryText && (
                  <T as="div" className="text-[12px] italic text-[var(--color-text-secondary)]">
                    {e.queryText}
                  </T>
                )}
                {e.retrievedSummary && (
                  <CodeBlock
                    code={e.retrievedSummary}
                    language="text"
                    theme="light"
                    className="max-h-[200px] overflow-y-auto"
                  />
                )}
                {e.errored && e.errorMessage && (
                  <InlineAlert tone="error">{e.errorMessage}</InlineAlert>
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
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
  // This card is only rendered for an invocation that WAS intervened on, so
  // "no rule-level breakdown was captured" is already an odd answer — reading
  // it when the query merely failed makes it a wrong one.
  const [failure, setFailure] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailure(null);
    fetch(
      `/api/observability/guardrails-detail/interventions?invocationId=${encodeURIComponent(invocationId)}&limit=50`,
      { credentials: 'include' },
    )
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return (await r.json()) as { interventions?: GuardrailInterventionRow[] };
      })
      .then((j) => {
        if (cancelled) return;
        setFailure(readDegraded(j));
        setRows(j.interventions ?? []);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFailure(e instanceof Error ? e.message : 'the request failed');
        setRows([]);
      });
    return () => { cancelled = true; };
  }, [invocationId, reloadKey]);

  return (
    <Card padding="md">
      <SectionLabel as="div" className="mb-3">
        Guardrail trace{' '}
        <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
          {rows == null ? 'loading…' : `${rows.length} rule${rows.length === 1 ? '' : 's'} fired`}
        </T>
      </SectionLabel>
      {failure ? (
        <UnavailableNotice
          error={failure}
          what="this invocation's guardrail breakdown"
          source="Interventions are read from the Aurora observability tables"
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      ) : rows == null ? (
        <InlinePlaceholder align="center" size="sm">Loading…</InlinePlaceholder>
      ) : rows.length === 0 ? (
        <InlinePlaceholder align="center" size="sm">
          The invocation was intervened on, but no rule-level breakdown was captured.
        </InlinePlaceholder>
      ) : (
        <Stack gap="sm">
          {rows.map((r) => (
            <Card key={r.interventionId} padding="sm" className="bg-[var(--color-bg)]">
              <Stack gap="xs">
                <Inline gap="sm" wrap align="center">
                  <GuardrailRuleBadge
                    ruleName={r.ruleName}
                    action={r.action}
                    severity={r.severity}
                  />
                  {r.ruleCategory && (
                    <T className="text-[11px] text-[var(--color-text-tertiary)]">{r.ruleCategory}</T>
                  )}
                  {r.severity && (
                    <T className="text-[11px] text-[var(--color-text-tertiary)]">severity {r.severity}</T>
                  )}
                </Inline>
                {r.matchedText && (
                  <CodeBlock
                    code={r.matchedText}
                    language="text"
                    theme="light"
                    className="max-h-[200px] overflow-y-auto"
                  />
                )}
              </Stack>
            </Card>
          ))}
        </Stack>
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
      <Inline align="center" gap="sm" className="mb-3">
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? '▾' : '▸'} Raw metadata
        </Button>
        <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
          full invocation_traces row · JSON
        </T>
      </Inline>
      {open && (
        <CodeBlock code={json} language="json" theme="light" className="max-h-[360px] overflow-y-auto" />
      )}
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
    <PageSection
      title={title}
      actions={
        <Link
          to="/admin/observability/invocations/search"
          className="px-2 py-[2px] text-[12px] text-[var(--color-primary)] no-underline"
        >
          ← Back to search
        </Link>
      }
    >
      <Card padding="md">
        {invocationId && (
          <T as="div" className="break-all font-mono text-[11px] text-[var(--color-text-tertiary)]">
            id: {invocationId}
          </T>
        )}
        <T as="div" className="mt-1 text-[12px] text-[var(--color-text-secondary)]">{detail}</T>
      </Card>
    </PageSection>
  );
}

export default InvocationDetailPage;
