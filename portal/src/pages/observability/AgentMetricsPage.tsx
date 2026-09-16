import { useMemo } from 'react';
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
  PageSection,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { T } from './Text';

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
  const { data: recent } = useFetch<{ invocations: Invocation[] }>(
    '/api/observability/recent-invocations?limit=50',
    5000,
  );
  const { data: bedrock } = useFetch<{ entries: BedrockInvocation[] }>(
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

  return (
    <PageSection
      title="Per-Agent Metrics"
      description="Derived from recent invocations (live) + Bedrock log (~30s lag, 60min window)"
      actions={
        <T className="text-[11px] text-[var(--color-text-tertiary)]">
          {rows.length} agent{rows.length !== 1 ? 's' : ''}
        </T>
      }
    >
      <Card padding="md">
        {rows.length === 0 ? (
          <InlinePlaceholder align="center" className="p-6 text-[12px]">
            No agent activity in the recent window. Invoke an agent to populate this view.
          </InlinePlaceholder>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Agent</TableTh>
                <TableTh>Invocations</TableTh>
                <TableTh>Avg Latency</TableTh>
                <TableTh>Tokens (in / out)</TableTh>
                <TableTh>Errors</TableTh>
                <TableTh>Blocked</TableTh>
                <TableTh>Health</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const errRate = r.invocations === 0 ? 0 : r.errors / r.invocations;
                const blockedRate = r.invocations === 0 ? 0 : r.blocked / r.invocations;
                const healthy = errRate === 0 && blockedRate < 0.1;
                return (
                  <TableRow key={r.agentName}>
                    <TableTd className="text-[12px] font-medium whitespace-nowrap">
                      {r.agentName}
                    </TableTd>
                    <TableTd className="text-[12px]">{r.invocations}</TableTd>
                    <TableTd className="text-[11px] text-[var(--color-text-tertiary)]">
                      {r.invocations > 0 ? `${(r.avgLatencyMs / 1000).toFixed(2)}s` : '—'}
                    </TableTd>
                    <TableTd className="text-[11px] text-[var(--color-text-tertiary)]">
                      {r.tokensIn + r.tokensOut > 0
                        ? `${r.tokensIn.toLocaleString()} / ${r.tokensOut.toLocaleString()}`
                        : '—'}
                    </TableTd>
                    <TableTd className="text-[12px]">
                      <T className={r.errors > 0 ? 'text-[var(--color-danger)]' : ''}>
                        {r.errors}
                      </T>
                      {r.invocations > 0 && (
                        <T className="text-[11px] text-[var(--color-text-tertiary)] ml-1.5">
                          ({(errRate * 100).toFixed(0)}%)
                        </T>
                      )}
                    </TableTd>
                    <TableTd className="text-[12px]">
                      {r.blocked}
                      {r.invocations > 0 && (
                        <T className="text-[11px] text-[var(--color-text-tertiary)] ml-1.5">
                          ({(blockedRate * 100).toFixed(0)}%)
                        </T>
                      )}
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
    </PageSection>
  );
}

export default AgentMetricsPage;
