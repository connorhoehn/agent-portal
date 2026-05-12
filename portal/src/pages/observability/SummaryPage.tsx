import { Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

interface ObsSummary {
  totalInvocations24h: number;
  totalErrors24h: number;
  totalTokens24h: number;
  avgLatencyMs: number;
  successRate: string;
  traceCount: number;
}

interface GuardrailMetrics {
  totalInvocations: number;
  totalInterventions: number;
  interventionRate: string;
  series: Array<{ timestamp: string; invocations: number; interventions: number }>;
}

function SummaryPage() {
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30000);
  const { data: guardrail } = useFetch<GuardrailMetrics>(
    '/api/capabilities/guardrail/metrics?hours=6',
    60000,
  );

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 16,
          marginBottom: 24,
        }}
      >
        <StatCard label="Invocations (24h)" value={summary?.totalInvocations24h.toLocaleString() ?? '—'} />
        <StatCard label="Avg Latency" value={summary ? `${(summary.avgLatencyMs / 1000).toFixed(1)}s` : '—'} />
        <StatCard label="Tokens (24h)" value={summary ? `${(summary.totalTokens24h / 1000).toFixed(0)}k` : '—'} />
        <StatCard label="Success Rate" value={summary ? `${summary.successRate}%` : '—'} accent />
        <StatCard
          label="Errors (24h)"
          value={String(summary?.totalErrors24h ?? 0)}
          danger={!!summary && summary.totalErrors24h > 0}
        />
      </div>

      <Card padding="md">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Guardrail Activity (6h){' '}
            <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              from AWS/Bedrock metrics
            </span>
          </h2>
          <div style={{ display: 'flex', gap: 20, fontSize: 12 }}>
            <span>
              <span style={{ color: 'var(--color-text-tertiary)' }}>Invocations: </span>
              <b>{guardrail?.totalInvocations ?? 0}</b>
            </span>
            <span>
              <span style={{ color: 'var(--color-text-tertiary)' }}>Interventions: </span>
              <b
                style={{
                  color: (guardrail?.totalInterventions ?? 0) > 0 ? '#dc2626' : undefined,
                }}
              >
                {guardrail?.totalInterventions ?? 0}
              </b>
            </span>
            <span>
              <span style={{ color: 'var(--color-text-tertiary)' }}>Rate: </span>
              <b>{guardrail?.interventionRate ?? '0.0'}%</b>
            </span>
          </div>
        </div>
        <GuardrailSparkline series={guardrail?.series ?? []} />
      </Card>
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          marginTop: 4,
          color: danger ? 'var(--color-danger)' : accent ? 'var(--color-success)' : undefined,
        }}
      >
        {value}
      </div>
    </Card>
  );
}

function GuardrailSparkline({
  series,
}: {
  series: Array<{ timestamp: string; invocations: number; interventions: number }>;
}) {
  const width = 800;
  const height = 60;
  const padding = 2;
  const maxVal = Math.max(1, ...series.map((p) => Math.max(p.invocations, p.interventions)));
  const points = (key: 'invocations' | 'interventions') =>
    series
      .map((p, i) => {
        const x = padding + (i / Math.max(series.length - 1, 1)) * (width - padding * 2);
        const y = height - padding - (p[key] / maxVal) * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  if (series.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          color: 'var(--color-text-tertiary)',
          fontSize: 12,
          textAlign: 'center',
        }}
      >
        No guardrail activity in the last 6h.
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: 60, display: 'block' }}
    >
      <polyline
        fill="none"
        stroke="var(--color-primary, #6366f1)"
        strokeWidth="1.5"
        points={points('invocations')}
      />
      <polyline fill="none" stroke="#dc2626" strokeWidth="1.5" points={points('interventions')} />
    </svg>
  );
}

export default SummaryPage;
