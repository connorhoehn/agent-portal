import { useMemo, useState } from 'react';
import {
  Card,
  InlinePlaceholder,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
  Inline,
  PageSection,
  SearchInput, T,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { formatTokenCount } from '../../lib/format';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { ObservabilityCommandSection } from './ObservabilityCommandSection';
import { OBSERVABILITY_GRAMMARS, matchesAny } from './observabilityCommands';

interface Invocation {
  id: string;
  agentId: string;
  agentName: string;
  durationMs: number;
  guardrailIntervened: boolean;
  error?: string;
}

interface BedrockInvocation {
  requestId: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  intervened: boolean;
}

interface AgentRow {
  agentName: string;
  invocations: number;
  errors: number;
  blocked: number;
  avgLatencyMs: number;
  tokensIn: number;
  tokensOut: number;
}

function AgentMetricsPage() {
  const { data: recent, refresh: refreshRecent } = useFetch<{ invocations: Invocation[] }>(
    '/api/observability/recent-invocations?limit=50',
    5000,
  );
  const { data: bedrock, refresh: refreshBedrock } = useFetch<{ entries: BedrockInvocation[] }>(
    '/api/observability/bedrock-invocations?limit=100&sinceMin=60',
    20000,
  );

  const rows = useMemo<AgentRow[]>(() => {
    const map = new Map<string, AgentRow>();

    for (const inv of recent?.invocations ?? []) {
      const r = map.get(inv.agentName) ?? {
        agentName: inv.agentName,
        invocations: 0,
        errors: 0,
        blocked: 0,
        avgLatencyMs: 0,
        tokensIn: 0,
        tokensOut: 0,
      };
      r.invocations += 1;
      if (inv.error) r.errors += 1;
      if (inv.guardrailIntervened) r.blocked += 1;
      // Running average of latency
      r.avgLatencyMs = r.avgLatencyMs + (inv.durationMs - r.avgLatencyMs) / r.invocations;
      map.set(inv.agentName, r);
    }

    for (const b of bedrock?.entries ?? []) {
      const key = b.agent;
      const r =
        map.get(key) ??
        ({
          agentName: key,
          invocations: 0,
          errors: 0,
          blocked: 0,
          avgLatencyMs: 0,
          tokensIn: 0,
          tokensOut: 0,
        } satisfies AgentRow);
      r.tokensIn += b.inputTokens;
      r.tokensOut += b.outputTokens;
      map.set(key, r);
    }

    return Array.from(map.values()).sort((a, b) => b.invocations - a.invocations);
  }, [recent, bedrock]);

  const [query, setQuery] = useState('');
  const visible = rows.filter((r) => matchesAny(query, r.agentName));
  const adapter = collectionCommandAdapter(OBSERVABILITY_GRAMMARS.agents, {
    setQuery,
    refresh: () => { refreshRecent(); refreshBedrock(); },
    scopeNote: 'Search matches agent names in the metrics derived from recent invocations and the Bedrock log. Refresh rereads both. Nothing here invokes or changes an agent.',
  });

  return (
    <PageSection
      title="Per-Agent Metrics"
      description="Derived from recent invocations (live) + Bedrock log (~30s lag, 60min window)"
      actions={
        <Inline gap="sm" align="center">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="Search agents"
            aria-label="Search agents"
            className="w-[200px]"
          />
          <T size="xs" className="text-[var(--color-text-tertiary)]">
            {query.trim() ? `${visible.length} of ${rows.length}` : rows.length} agent{rows.length !== 1 ? 's' : ''}
          </T>
        </Inline>
      }
    >
      <ObservabilityCommandSection adapter={adapter}>
      <Card padding="md">
        {visible.length === 0 ? (
          <InlinePlaceholder align="center" className="text-xs p-6">
            {rows.length === 0
              ? 'No agent activity in the recent window. Invoke an agent to populate this view.'
              : 'No agents match the current search.'}
          </InlinePlaceholder>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh numeric>Invocations</TableTh>
                <TableTh numeric>Avg Latency</TableTh>
                <TableTh numeric>Tokens (in / out)</TableTh>
                <TableTh numeric>Errors</TableTh>
                <TableTh numeric>Blocked</TableTh>
                <TableTh>Health</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((r) => {
                const errRate = r.invocations === 0 ? 0 : r.errors / r.invocations;
                const blockedRate = r.invocations === 0 ? 0 : r.blocked / r.invocations;
                const healthy = errRate === 0 && blockedRate < 0.1;
                return (
                  <TableRow key={r.agentName}>
                    <TableTd className="whitespace-nowrap">
                      {r.agentName}
                    </TableTd>
                    <TableTd numeric>{r.invocations}</TableTd>
                    <TableTd numeric className="text-[var(--color-text-tertiary)]">
                      {r.invocations > 0 ? `${(r.avgLatencyMs / 1000).toFixed(2)}s` : '—'}
                    </TableTd>
                    <TableTd numeric className="text-[var(--color-text-tertiary)]">
                      {r.tokensIn + r.tokensOut > 0
                        ? `${formatTokenCount(r.tokensIn)} / ${formatTokenCount(r.tokensOut)}`
                        : '—'}
                    </TableTd>
                    <TableTd numeric title={r.invocations > 0 ? `${(errRate * 100).toFixed(0)}% of invocations` : undefined}>
                      <T size="sm" className={r.errors > 0 ? 'text-[var(--color-danger)]' : ''}>
                        {r.errors}
                      </T>
                    </TableTd>
                    <TableTd numeric title={r.invocations > 0 ? `${(blockedRate * 100).toFixed(0)}% of invocations` : undefined}>
                      {r.blocked}
                    </TableTd>
                    <TableTd>
                      {r.invocations === 0 ? (
                        <Chip tone="neutral" size="xs">
                          idle
                        </Chip>
                      ) : healthy ? (
                        <Chip tone="success" size="xs">
                          healthy
                        </Chip>
                      ) : errRate > 0 ? (
                        <Chip tone="danger" size="xs">
                          errors
                        </Chip>
                      ) : (
                        <Chip tone="warning" size="xs">
                          guardrails
                        </Chip>
                      )}
                    </TableTd>
                  </TableRow>
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

export default AgentMetricsPage;
