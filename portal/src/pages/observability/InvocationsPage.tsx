import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  CatalogGrid,
  Card,
  Chip,
  CodeBlock,
  CollapsibleSection,
  EmptyState,
  Inline,
  InlineAlert,
  InlinePlaceholder,
  MetaLine,
  PageSection,
  SectionLabel,
  Select,
  Stack,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { CostChip } from '../../components/observability/CostChip';
import { PromptVersionChip } from '../../components/observability/PromptVersionChip';
import { T } from './Text';
import {
  applyFiltersToParams,
  firstSentence,
  parseAgentFilter,
  parseStatusFilter,
  type StatusFilter,
} from './invocationsFilters';

interface SandboxExecution {
  code: string;
  output: string;
  durationMs: number;
  sessionId: string;
  timestamp: string;
  error?: string;
}

interface Invocation {
  id: string;
  agentId: string;
  agentName: string;
  startedAt: string;
  durationMs: number;
  promptSnippet: string;
  responseSnippet: string;
  guardrailIntervened: boolean;
  runtimeSessionId?: string;
  error?: string;
  sandboxExecutions?: SandboxExecution[];
  // Sprint 1 cost + provenance fields (nullable until Agent A's migration lands).
  inputTokens?: number | null;
  outputTokens?: number | null;
  estCostUsd?: number | null;
  judgeCostUsd?: number | null;
  totalCostUsd?: number | null;
  promptVersion?: string | null;
  modelId?: string | null;
}

/** Just enough of GET /api/agents to populate the "All agents" filter from
 *  the fleet registry — not from whatever happens to be in the live tail,
 *  which is empty on a fresh dev:mock boot (DEFECTS.md #7). */
interface AgentRegistryEntry {
  id: string;
  name: string;
}

interface BedrockInvocation {
  requestId: string;
  timestamp: string;
  agent: string;
  modelId: string;
  operation: string;
  promptSnippet: string;
  responseSnippet: string;
  inputTokens: number;
  outputTokens: number;
  intervened: boolean;
  interventions: Array<{ source: 'INPUT' | 'OUTPUT'; policyType: string; detail: string }>;
}

function InvocationsPage() {
  const { data: recent } = useFetch<{ invocations: Invocation[] }>(
    '/api/observability/recent-invocations?limit=50',
    5000,
  );
  const { data: bedrock } = useFetch<{ entries: BedrockInvocation[] }>(
    '/api/observability/bedrock-invocations?limit=20&sinceMin=60',
    20000,
  );
  // The fleet registry, not the tail: on a fresh dev:mock boot (or any
  // moment with no traffic yet) the tail is empty, but the "All agents"
  // filter should still list every deployed agent (DEFECTS.md #7).
  const { data: registry } = useFetch<AgentRegistryEntry[]>('/api/agents', 60000);

  // Both filters live in the URL, not local state — a link that already
  // knows what it wants to show (Health's "Read the failures on …", the
  // Architecture graph, an agent detail page) lands pre-filtered, and
  // changing a filter (including Clear filters) writes straight back so
  // `location.search` always describes what's on screen: a reload or a
  // shared link reproduces the same view instead of snapping back to
  // unfiltered (DEFECTS.md #26). Accepts both `agentId` (existing links) and
  // `agent` (Health's wording) on read; writes only the canonical `agentId`.
  const [searchParams, setSearchParams] = useSearchParams();
  const agentFilter = parseAgentFilter(searchParams);
  const statusFilter = parseStatusFilter(searchParams);
  const setAgentFilter = useCallback(
    (next: string) => {
      setSearchParams((prev) => applyFiltersToParams(prev, next, parseStatusFilter(prev)), { replace: true });
    },
    [setSearchParams],
  );
  const setStatusFilter = useCallback(
    (next: StatusFilter) => {
      setSearchParams((prev) => applyFiltersToParams(prev, parseAgentFilter(prev), next), { replace: true });
    },
    [setSearchParams],
  );

  const allInvocations = recent?.invocations ?? [];

  // The tail's `agentName` is not trustworthy on its own — a real trace with
  // no display name falls back to the raw id server-side (trace-sink.ts
  // `agentName = input.agentName || agentId`), which is how "Supervisor" and
  // "orgiq-supervisor" could both show up as agents (DEFECTS.md #16).
  // `agentId` is always the real registry id, so resolve every invocation
  // (and every incoming `?agentId=` link, which some callers seed with the
  // id and some with the display name) to the registry's id and key the
  // Select and the filter on that — one entry per agent, ever.
  const registryById = useMemo(
    () => new Map((registry ?? []).map((a) => [a.id, a.name] as const)),
    [registry],
  );
  const registryIdByName = useMemo(
    () => new Map((registry ?? []).map((a) => [a.name, a.id] as const)),
    [registry],
  );
  const resolveAgentKey = useCallback(
    (rawId: string | undefined, rawName: string | undefined): string => {
      if (rawId && registryById.has(rawId)) return rawId;
      if (rawName && registryIdByName.has(rawName)) return registryIdByName.get(rawName)!;
      return rawId || rawName || 'unknown';
    },
    [registryById, registryIdByName],
  );

  const agentOptions = useMemo(() => {
    const byId = new Map<string, string>();
    (registry ?? []).forEach((a) => byId.set(a.id, a.name));
    // Belt-and-suspenders: an agent that has traffic but somehow isn't in the
    // registry response should still be selectable, under its own key.
    allInvocations.forEach((i) => {
      const key = resolveAgentKey(i.agentId, i.agentName);
      if (!byId.has(key)) byId.set(key, i.agentName || i.agentId || key);
    });
    return Array.from(byId.entries())
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [registry, allInvocations, resolveAgentKey]);

  // Seeded from the URL as whatever string arrived (id or display name);
  // resolved to a registry id so it lines up with agentOptions/filtering
  // regardless of which form the link used.
  const resolvedAgentFilter = useMemo(
    () => (agentFilter === 'all' ? 'all' : resolveAgentKey(agentFilter, agentFilter)),
    [agentFilter, resolveAgentKey],
  );

  const filtered = useMemo(() => {
    return allInvocations.filter((inv) => {
      if (resolvedAgentFilter !== 'all' && resolveAgentKey(inv.agentId, inv.agentName) !== resolvedAgentFilter) {
        return false;
      }
      if (statusFilter === 'ok' && (inv.error || inv.guardrailIntervened)) return false;
      if (statusFilter === 'blocked' && !inv.guardrailIntervened) return false;
      if (statusFilter === 'error' && !inv.error) return false;
      return true;
    });
  }, [allInvocations, resolvedAgentFilter, statusFilter, resolveAgentKey]);

  const filtersActive = resolvedAgentFilter !== 'all' || statusFilter !== 'all';
  const clearFilters = useCallback(() => {
    setSearchParams((prev) => applyFiltersToParams(prev, 'all', 'all'), { replace: true });
  }, [setSearchParams]);

  const intervenedCount = filtered.filter((i) => i.guardrailIntervened).length;

  return (
    <PageSection
      title="Recent Activity"
      description="Live · last 50 invocations · 5s refresh"
      actions={
        <Inline gap="sm" align="center">
          <Link
            to="/admin/observability/invocations/search"
            className="mr-[10px] text-[12px] text-[var(--color-primary)] no-underline"
          >
            Search & triage →
          </Link>
          <Select
            value={resolvedAgentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            size="sm"
            options={[
              { value: 'all', label: 'All agents' },
              ...agentOptions.map((o) => ({ value: o.id, label: o.label })),
            ]}
          />
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            size="sm"
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'ok', label: 'OK' },
              { value: 'blocked', label: 'Blocked' },
              { value: 'error', label: 'Error' },
            ]}
          />
          <T className="text-[11px] text-[var(--color-text-tertiary)]">{intervenedCount} intervened</T>
        </Inline>
      }
    >
      <Card padding="md">
        {filtered.length === 0 ? (
          allInvocations.length === 0 ? (
            <InlinePlaceholder align="center" size="sm">
              No invocations yet. Send a message via the Agent Tools page and it'll appear here
              within 5 seconds.
            </InlinePlaceholder>
          ) : (
            <EmptyState
              title="No invocations match"
              description="No invocations match the current filters."
              {...(filtersActive ? { actionLabel: 'Clear filters', onAction: clearFilters } : {})}
            />
          )
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Prompt ver.</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Response</TableTh>
                <TableTh>Duration</TableTh>
                <TableTh>Cost</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((inv) => (
                <TableRow key={inv.id}>
                  <TableTd className="whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
                    <Link
                      to={`/admin/observability/invocations/${encodeURIComponent(inv.id)}`}
                      className="text-[var(--color-text-tertiary)] no-underline hover:text-[var(--color-primary)] hover:underline"
                    >
                      {new Date(inv.startedAt).toLocaleTimeString()}
                    </Link>
                  </TableTd>
                  <TableTd className="whitespace-nowrap text-[12px] font-medium">
                    {registryById.get(resolveAgentKey(inv.agentId, inv.agentName)) ?? inv.agentName}
                  </TableTd>
                  <TableTd className="whitespace-nowrap">
                    <PromptVersionChip promptVersion={inv.promptVersion} />
                  </TableTd>
                  <TableTd className="max-w-[280px] truncate text-[12px]" title={inv.promptSnippet}>
                    {inv.promptSnippet}
                  </TableTd>
                  <TableTd
                    className="max-w-[320px] text-[12px] text-[var(--color-text-secondary)]"
                    title={inv.error ? `error: ${inv.error}` : inv.responseSnippet}
                  >
                    {inv.error ? (
                      <T className="text-[var(--color-danger)]">error: {firstSentence(inv.error)}</T>
                    ) : (
                      firstSentence(inv.responseSnippet)
                    )}
                  </TableTd>
                  <TableTd className="text-[11px] text-[var(--color-text-tertiary)]">
                    {(inv.durationMs / 1000).toFixed(1)}s
                  </TableTd>
                  <TableTd className="whitespace-nowrap">
                    <CostChip cost={inv.totalCostUsd} />
                  </TableTd>
                  <TableTd>
                    {inv.error ? (
                      <Chip tone="danger" size="xs">
                        error
                      </Chip>
                    ) : inv.guardrailIntervened ? (
                      <Chip tone="warning" size="xs">
                        blocked
                      </Chip>
                    ) : (
                      <Chip tone="success" size="xs">
                        ok
                      </Chip>
                    )}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <CodeInterpreterTraces invocations={filtered} />

      <Card padding="md">
        <Inline align="center" justify="between" className="mb-3">
          <SectionLabel as="div">
            Bedrock Invocations{' '}
            <T className="text-[11px] font-normal text-[var(--color-text-tertiary)]">
              from /orgiq/bedrock-invocations · ~30s lag · full guardrail trace
            </T>
          </SectionLabel>
          <T className="text-[11px] text-[var(--color-text-tertiary)]">
            {bedrock?.entries.filter((e) => e.intervened).length ?? 0} intervened in last hour
          </T>
        </Inline>
        {(bedrock?.entries ?? []).length === 0 ? (
          <InlinePlaceholder align="center" size="sm">
            No Bedrock calls in the last hour. Invoke an agent and wait ~30s.
          </InlinePlaceholder>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>When</TableTh>
                <TableTh>Agent</TableTh>
                <TableTh>Op</TableTh>
                <TableTh>Prompt</TableTh>
                <TableTh>Tokens</TableTh>
                <TableTh>Status</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {(bedrock?.entries ?? []).map((b) => (
                <TableRow key={b.requestId}>
                  <TableTd className="whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
                    {new Date(b.timestamp).toLocaleTimeString()}
                  </TableTd>
                  <TableTd className="whitespace-nowrap text-[12px] font-medium">{b.agent}</TableTd>
                  <TableTd className="font-mono text-[11px] text-[var(--color-text-tertiary)]">
                    {b.operation}
                  </TableTd>
                  <TableTd className="max-w-[320px] truncate text-[12px]" title={b.promptSnippet}>
                    {b.promptSnippet}
                  </TableTd>
                  <TableTd className="text-[11px] text-[var(--color-text-tertiary)]">
                    {b.inputTokens}↓ / {b.outputTokens}↑
                  </TableTd>
                  <TableTd>
                    {b.intervened ? (
                      <span
                        title={b.interventions
                          .map((i) => `${i.source}: ${i.policyType}/${i.detail}`)
                          .join('\n')}
                      >
                        <Chip tone="warning" size="xs">
                          {b.interventions[0]?.detail || 'blocked'}
                        </Chip>
                      </span>
                    ) : (
                      <Chip tone="success" size="xs">
                        ok
                      </Chip>
                    )}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </PageSection>
  );
}

// ─── Code Interpreter Traces ──────────────────────────────────────────────────

function CodeInterpreterTraces({ invocations }: { invocations: Invocation[] }) {
  const traced = invocations.filter((i) => (i.sandboxExecutions?.length ?? 0) > 0);
  const totalExecs = traced.reduce((n, i) => n + (i.sandboxExecutions?.length ?? 0), 0);

  return (
    <Card padding="md" className="mb-6">
      <Inline gap="sm" align="center" className="mb-3">
        <SectionLabel as="div">Code Interpreter Traces</SectionLabel>
        <T className="text-[11px] text-[var(--color-text-tertiary)]">
          invocations that triggered run_in_sandbox · live ring buffer
        </T>
        {traced.length > 0 && (
          <T className="ml-auto text-[11px] font-semibold text-[var(--color-primary)]">
            {traced.length} invocation{traced.length !== 1 ? 's' : ''} · {totalExecs} execution
            {totalExecs !== 1 ? 's' : ''}
          </T>
        )}
      </Inline>

      {traced.length === 0 ? (
        <InlinePlaceholder align="center" size="sm">
          No Code Interpreter executions yet. Ask the scoring or graph-builder agent a
          computational question (e.g. "compute PageRank" or "run expertise scoring 5 different
          ways") and executions will appear here.
        </InlinePlaceholder>
      ) : (
        <Stack gap="sm">
          {traced.map((inv) => {
            const execCount = inv.sandboxExecutions?.length ?? 0;
            return (
              <CollapsibleSection
                key={inv.id}
                title={
                  <MetaLine
                    items={[
                      <T className="whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
                        {new Date(inv.startedAt).toLocaleTimeString()}
                      </T>,
                      <T className="whitespace-nowrap rounded-full bg-[var(--color-surface-hover)] px-[7px] py-[1px] text-[11px] font-semibold text-[var(--color-primary)]">
                        {inv.agentName.replace('orgiq-', '')}
                      </T>,
                      <T className="max-w-[360px] truncate text-[12px]">{inv.promptSnippet}</T>,
                    ]}
                  />
                }
                badge={
                  <Inline gap="sm" align="center">
                    <T className="whitespace-nowrap rounded-full bg-[var(--color-primary)] px-2 py-[2px] text-[11px] font-semibold text-white">
                      {execCount} sandbox run{execCount !== 1 ? 's' : ''}
                    </T>
                    <T className="whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
                      {(inv.durationMs / 1000).toFixed(1)}s total
                    </T>
                  </Inline>
                }
              >
                <Stack gap="sm">
                  {(inv.sandboxExecutions ?? []).map((exec, idx) => (
                    <CollapsibleSection
                      key={`${inv.id}-${idx}`}
                      title={
                        <MetaLine
                          items={[
                            <Chip tone={exec.error ? 'danger' : 'success'} size="xs">
                              run {idx + 1}
                            </Chip>,
                            <T className="max-w-[420px] truncate font-mono text-[11px] text-[var(--color-text-secondary)]">
                              {exec.code
                                .trim()
                                .split('\n')
                                .find((l) => l.trim() && !l.startsWith('#')) ??
                                exec.code.trim().slice(0, 80)}
                            </T>,
                            <T className="whitespace-nowrap text-[11px] text-[var(--color-text-tertiary)]">
                              {exec.durationMs}ms · {exec.sessionId.slice(-8)}
                            </T>,
                          ]}
                        />
                      }
                    >
                      <CatalogGrid columns={2} dense>
                        <Stack gap="xs">
                          <SectionLabel as="div">INPUT — generated code</SectionLabel>
                          <CodeBlock
                            code={exec.code}
                            language="text"
                            theme="light"
                            className="max-h-[300px] overflow-y-auto"
                          />
                        </Stack>
                        <Stack gap="xs">
                          <SectionLabel as="div">OUTPUT{exec.error ? ' — error' : ''}</SectionLabel>
                          {exec.error ? (
                            <InlineAlert tone="error">{exec.output || '(no output)'}</InlineAlert>
                          ) : (
                            <CodeBlock
                              code={exec.output || '(no output)'}
                              language="text"
                              theme="light"
                              className="max-h-[300px] overflow-y-auto"
                            />
                          )}
                        </Stack>
                      </CatalogGrid>
                    </CollapsibleSection>
                  ))}
                </Stack>
              </CollapsibleSection>
            );
          })}
        </Stack>
      )}
    </Card>
  );
}

export default InvocationsPage;
