// InvocationDetailPage — full triage surface for one invocation.
//
// Endpoint: GET /api/observability/invocations/:invocationId
// Returns: { invocation, toolCalls, parent, children: [{ ..., grandchildren }] }
//
// A DetailPage: the header carries the agent, the run's chips and its
// actions; each facet is a tab (trace chain, tool calls, memory, guardrails
// when one fired, prompt & response, judge, raw metadata) instead of eight
// stacked cards. The open tab is `?tab=` so a facet can be linked. Replay
// posts to /replay; backend returns 501 currently, surfaced via a small toast.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useCrumbLabel } from '../../lib/crumbLabels';
import {
  Button,
  Card,
  Chip,
  CodeBlock,
  DetailPage,
  DetailSection,
  ErrorState,
  Inline,
  InlineAlert,
  InlinePlaceholder,
  LoadingState,
  MetaLine,
  Stack,
  useToast, T,
  type DetailPageTab,
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

const SEARCH_PATH = '/admin/observability/invocations/search';

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
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const tab = search.get('tab') ?? undefined;
  const onTabChange = (id: string) => setSearch((prev) => {
    const next = new URLSearchParams(prev);
    next.set('tab', id);
    return next;
  }, { replace: true });
  const backToSearch = <Button variant="link" size="sm" onClick={() => navigate(SEARCH_PATH)}>← Back to search</Button>;

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
      <ErrorBlock title="Missing invocation id" detail="No id in the URL." actions={backToSearch} />
    );
  }
  if (loading && !detail) {
    return (
      <DetailPage title="Invocation" gutter="none" actions={backToSearch}>
        <LoadingState label="Loading invocation…" />
      </DetailPage>
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
        actions={backToSearch}
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

  const judgeLabel = inv.judgeScore != null && Number.isFinite(inv.judgeScore)
    ? Number(inv.judgeScore).toFixed(2)
    : '—';
  const showGuardrails = !!inv.guardrailAction && inv.guardrailAction !== 'NONE';

  const tabs: DetailPageTab[] = [
    {
      id: 'trace',
      label: 'Trace chain',
      content: hasTrace ? (
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
      ),
    },
    {
      id: 'tools',
      label: 'Tool calls',
      badge: toolCalls.length,
      content: <ToolWaterfall toolCalls={toolCalls} />,
    },
    { id: 'memory', label: 'Memory', content: <MemoryOperations invocationId={invocationId} /> },
    ...(showGuardrails
      ? [{ id: 'guardrails', label: 'Guardrails', content: <GuardrailTrace invocationId={invocationId} /> }]
      : []),
    {
      id: 'io',
      label: 'Prompt & response',
      content: (
        <Stack gap="none">
          <DetailSection title="Prompt" first>
            {prompt ? (
              <CodeBlock code={prompt} language="text" theme="light" className="max-h-[360px] overflow-y-auto" />
            ) : (
              <InlinePlaceholder align="center" size="sm">
                No prompt text captured for this invocation.
              </InlinePlaceholder>
            )}
          </DetailSection>
          <DetailSection title="Response">
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
          </DetailSection>
        </Stack>
      ),
    },
    {
      id: 'judge',
      label: 'Judge',
      content: (
        <Inline align="start" gap="sm">
          <Chip tone={judgeTone(inv.judgeScore)} size="sm">{judgeLabel}</Chip>
          {inv.judgeRationale ? (
            <T size="xs" as="div" tone="secondary" className="leading-normal">
              {inv.judgeRationale}
            </T>
          ) : (
            <T size="xs" tone="tertiary">(no rationale recorded)</T>
          )}
        </Inline>
      ),
    },
    { id: 'raw', label: 'Raw metadata', content: <RawMetadata invocation={inv} /> },
  ];

  return (
    <>
      <DetailPage
        title={agentName}
        gutter="none"
        data-testid="invocation-detail"
        badge={
          <Inline gap="xs" wrap align="center">
            <Chip tone={judgeTone(inv.judgeScore)} size="xs" title="judge score">judge {judgeLabel}</Chip>
            <SchemaChip valid={inv.schemaValid ?? null} />
            {inv.guardrailAction && (
              <Chip tone="warning" size="xs">
                {String(inv.guardrailAction)}
              </Chip>
            )}
            {modeFromTemplate && <ModeChip mode={modeFromTemplate} />}
            <CostChip cost={totalCost} />
            <PromptVersionChip promptVersion={inv.promptVersion ?? null} />
          </Inline>
        }
        meta={
          <MetaLine
            size="xs"
            items={[
              ...(ts ? [new Date(ts).toLocaleString()] : []),
              <T key="id" size="xs" tone="tertiary" className="break-all font-mono">{invocationId}</T>,
              ...(inv.modelId ? [<T key="model" size="xs" tone="tertiary" title="model id" className="font-mono">{String(inv.modelId)}</T>] : []),
              `duration ${fmtDur(inv.durationMs)}`,
            ]}
          />
        }
        actions={
          <>
            {backToSearch}
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
          </>
        }
        tabs={tabs}
        {...(tab ? { activeTab: tab } : {})}
        onTabChange={onTabChange}
      />

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
    </>
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

function MemoryOperations({ invocationId }: { invocationId: string }) {
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
    <Stack gap="sm">
      <T size="xs" tone="tertiary">
        {events == null ? 'loading…' : `${count} memory op${count === 1 ? '' : 's'}`}
      </T>
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
            <Card key={e.memoryEventId} padding="sm">
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
                  <T size="xs" tone="tertiary">
                    {e.resultCount == null ? '—' : `${e.resultCount} result${e.resultCount === 1 ? '' : 's'}`}
                  </T>
                  <T size="xs" tone="tertiary">·</T>
                  <T size="xs" tone="tertiary">
                    {e.durationMs == null ? '—' : `${e.durationMs}ms`}
                  </T>
                  {e.sessionId && (
                    <>
                      <T size="xs" tone="tertiary">·</T>
                      <T size="xs" tone="tertiary">session {e.sessionId}</T>
                    </>
                  )}
                </Inline>
                {e.queryText && (
                  <T size="xs" as="div" tone="secondary" className="italic">
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
    </Stack>
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

function GuardrailTrace({ invocationId }: { invocationId: string }) {
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
    <Stack gap="sm">
      <T size="xs" tone="tertiary">
        {rows == null ? 'loading…' : `${rows.length} guardrail rule${rows.length === 1 ? '' : 's'} fired`}
      </T>
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
            <Card key={r.interventionId} padding="sm">
              <Stack gap="xs">
                <Inline gap="sm" wrap align="center">
                  <GuardrailRuleBadge
                    ruleName={r.ruleName}
                    action={r.action}
                    severity={r.severity}
                  />
                  {r.ruleCategory && (
                    <T size="xs" tone="tertiary">{r.ruleCategory}</T>
                  )}
                  {r.severity && (
                    <T size="xs" tone="tertiary">severity {r.severity}</T>
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
    </Stack>
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

function RawMetadata({ invocation }: { invocation: InvocationRow }) {
  const json = useMemo(() => {
    try {
      return JSON.stringify(invocation, null, 2);
    } catch {
      return '{}';
    }
  }, [invocation]);
  return (
    <Stack gap="sm">
      <T size="xs" tone="tertiary">full invocation_traces row · JSON</T>
      <CodeBlock code={json} language="json" theme="light" />
    </Stack>
  );
}

function ErrorBlock({
  title,
  detail,
  invocationId,
  actions,
}: {
  title: string;
  detail: string;
  invocationId?: string;
  actions: ReactNode;
}) {
  return (
    <DetailPage title={title} gutter="none" actions={actions}>
      <ErrorState
        title={title}
        description={
          <Stack gap="xs">
            {invocationId && (
              <T size="xs" as="div" tone="tertiary" className="break-all font-mono">
                id: {invocationId}
              </T>
            )}
            <T size="xs" as="div" tone="secondary">{detail}</T>
          </Stack>
        }
      />
    </DetailPage>
  );
}

export default InvocationDetailPage;
