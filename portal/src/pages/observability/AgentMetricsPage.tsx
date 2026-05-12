import { useMemo } from 'react';
import {
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

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
    <div style={{ padding: 24 }}>
      <Card padding="md">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>
            Per-Agent Metrics{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              derived from recent invocations (live) + Bedrock log (~30s lag, 60min window)
            </span>
          </h2>
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            {rows.length} agent{rows.length !== 1 ? 's' : ''}
          </span>
        </div>

        {rows.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              fontSize: 12,
              color: 'var(--color-text-tertiary)',
            }}
          >
            No agent activity in the recent window. Invoke an agent to populate this view.
          </div>
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
                    <TableTd style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>
                      {r.agentName}
                    </TableTd>
                    <TableTd style={{ fontSize: 12 }}>{r.invocations}</TableTd>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {r.invocations > 0 ? `${(r.avgLatencyMs / 1000).toFixed(2)}s` : '—'}
                    </TableTd>
                    <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                      {r.tokensIn + r.tokensOut > 0
                        ? `${r.tokensIn.toLocaleString()} / ${r.tokensOut.toLocaleString()}`
                        : '—'}
                    </TableTd>
                    <TableTd style={{ fontSize: 12 }}>
                      <span style={{ color: r.errors > 0 ? 'var(--color-danger, #dc2626)' : undefined }}>
                        {r.errors}
                      </span>
                      {r.invocations > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 6 }}>
                          ({(errRate * 100).toFixed(0)}%)
                        </span>
                      )}
                    </TableTd>
                    <TableTd style={{ fontSize: 12 }}>
                      {r.blocked}
                      {r.invocations > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 6 }}>
                          ({(blockedRate * 100).toFixed(0)}%)
                        </span>
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
    </div>
  );
}

export default AgentMetricsPage;
