import type React from 'react';
import { Link } from 'react-router';
import { Card, PageSection, StatCard } from '@connorhoehnslalom/ui-components/shared';
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

interface AgentRuntime {
  id: string;
  name: string;
  status: string;
  errorsLast24h: number;
  invocationsLast24h: number;
  latencyP50Ms: number;
}

interface Alarm {
  name: string;
  severity: 'ok' | 'warning' | 'critical' | string;
  reason: string;
  affectedAgent: string | null;
}

interface Health {
  mocks: Record<string, boolean>;
  awsCredentials?: { ok: boolean; error?: string };
}

/** What the operator should do next, derived from live signals only. */
interface NextStep {
  label: string;
  detail: string;
  to: string;
  urgent: boolean;
}

function deriveNextSteps(
  alarms: Alarm[],
  agents: AgentRuntime[],
  summary: ObsSummary | null,
  health: Health | null,
): NextStep[] {
  const steps: NextStep[] = [];

  if (health?.awsCredentials?.ok === false) {
    steps.push({
      label: 'Refresh AWS credentials, then restart the middleware',
      detail:
        'Run aws-azure-login, then restart the middleware process. The re-login alone is not ' +
        'enough: the credentials file parse is memoized process-wide, so a long-running server ' +
        'keeps serving the expired session until it restarts.',
      to: '/admin/observability/summary',
      urgent: true,
    });
  }

  const firing = alarms.filter((a) => a.severity !== 'ok');
  if (firing.length > 0) {
    steps.push({
      label: `Investigate ${firing.length} firing alarm${firing.length === 1 ? '' : 's'}`,
      detail: firing.map((a) => a.reason).join(' · '),
      to: '/admin/observability/oncall',
      urgent: firing.some((a) => a.severity === 'critical'),
    });
  }

  const failing = agents.filter((a) => a.errorsLast24h > 0);
  if (failing.length > 0) {
    steps.push({
      label: `Read the failures on ${failing.map((a) => a.name).join(', ')}`,
      detail: `${failing.reduce((n, a) => n + a.errorsLast24h, 0)} errored invocations in the last 24h.`,
      to: '/admin/observability/invocations',
      urgent: true,
    });
  }

  // Invocations without traces is the ADOT failure mode from CLAUDE.md: the
  // runtime injects OTEL_PYTHON_CONFIGURATOR=aws_configurator, which only the
  // ADOT distro provides, so a vanilla distro exports no spans at all. The
  // agents still run and still bill — the evidence just never arrives, which
  // starves Runs, the span projector, and online evaluation.
  if (summary && summary.totalInvocations24h > 0 && summary.traceCount === 0) {
    steps.push({
      label: 'Agents ran but emitted no traces',
      detail:
        `${summary.totalInvocations24h} invocations in 24h and zero spans in X-Ray. Check that ` +
        `the agent images install aws-opentelemetry-distro rather than the vanilla distro, and ` +
        `that X-Ray Transaction Search is enabled on the account.`,
      to: '/admin/observability/invocations',
      urgent: false,
    });
  }

  if (agents.length > 0 && summary && summary.totalInvocations24h === 0) {
    steps.push({
      label: 'Nothing has run in 24h',
      detail: `${agents.length} runtimes are deployed but idle. Ask something to exercise them.`,
      to: '/iq/invoke',
      urgent: false,
    });
  }

  if (steps.length === 0) {
    steps.push({
      label: 'Nothing needs you',
      detail: `All ${agents.length} deployed agents are healthy and no alarms are firing.`,
      to: '/iq/work',
      urgent: false,
    });
  }

  return steps;
}

function SummaryPage() {
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30000);
  const { data: guardrail } = useFetch<GuardrailMetrics>(
    '/api/capabilities/guardrail/metrics?hours=6',
    60000,
  );
  const { data: agents } = useFetch<AgentRuntime[]>('/api/agents', 60000);
  const { data: alarmData } = useFetch<{ alarms: Alarm[] }>(
    '/api/observability/oncall/alarms',
    30000,
  );
  const { data: health } = useFetch<Health>('/api/health', 60000);

  const runtimes = agents ?? [];
  const alarms = alarmData?.alarms ?? [];
  const healthy = runtimes.filter((a) => a.status === 'healthy').length;
  const firing = alarms.filter((a) => a.severity !== 'ok');
  const steps = deriveNextSteps(alarms, runtimes, summary ?? null, health ?? null);

  // With no usable credentials every AWS-backed panel comes back empty, and an
  // empty result is indistinguishable from a healthy one unless we say so. A
  // green "0 firing / all signals within thresholds" during an outage is worse
  // than no panel at all — it actively tells you not to look.
  const blind = health?.awsCredentials?.ok === false;
  const dash = (v: React.ReactNode): React.ReactNode => (blind ? '—' : v);

  return (
    <PageSection
      title="Health"
      description="What is deployed, whether it is working, and what needs you next."
    >
      {/* ── Right now ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">
        <Card padding="md">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Deployed agents
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-semibold">{runtimes.length || '—'}</span>
            <span className="text-sm text-[var(--color-text-secondary)]">
              {blind ? 'unknown' : `${healthy} healthy${runtimes.length > healthy ? ` · ${runtimes.length - healthy} not` : ''}`}
            </span>
          </div>
          <div className="mt-2 text-xs text-[var(--color-text-tertiary)]">
            {blind
              ? 'Cannot list runtimes without credentials.'
              : 'Live from AgentCore Runtime, not a static list.'}
          </div>
        </Card>

        <Card padding="md">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Alarms
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={`text-3xl font-semibold ${!blind && firing.length ? 'text-red-600' : ''}`}
            >
              {dash(firing.length)}
            </span>
            <span className="text-sm text-[var(--color-text-secondary)]">firing</span>
          </div>
          <div className="mt-2 text-xs text-[var(--color-text-tertiary)]">
            {blind
              ? 'Cannot evaluate alarms without credentials.'
              : alarms[0]?.reason ?? 'No alarm evaluation yet.'}
          </div>
        </Card>

        <Card padding="md">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Errors (24h)
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span
              className={`text-3xl font-semibold ${!blind && summary?.totalErrors24h ? 'text-red-600' : ''}`}
            >
              {dash(summary?.totalErrors24h ?? 0)}
            </span>
            <span className="text-sm text-[var(--color-text-secondary)]">
              {blind ? 'no data' : `of ${summary?.totalInvocations24h ?? 0} runs`}
            </span>
          </div>
          <Link
            to="/admin/observability/invocations"
            className="mt-2 inline-block text-xs text-[var(--color-primary)] hover:underline"
          >
            Open Runs →
          </Link>
        </Card>
      </div>

      {/* ── What to do next ───────────────────────────────────────────── */}
      <Card padding="md">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-tertiary)]">
          What to do next
        </div>
        <div className="mt-3 flex flex-col gap-3">
          {steps.map((s) => (
            <Link
              key={s.label}
              to={s.to}
              className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-3 no-underline hover:bg-[var(--color-surface-hover)]"
            >
              <span
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                  s.urgent ? 'bg-red-500' : 'bg-[var(--color-text-tertiary)]'
                }`}
              />
              <span>
                <span className="block text-sm font-medium text-[var(--color-text-primary)]">
                  {s.label}
                </span>
                <span className="block text-xs text-[var(--color-text-secondary)]">{s.detail}</span>
              </span>
            </Link>
          ))}
        </div>
      </Card>

      {/* ── Raw numbers, below the fold of the decision ───────────────── */}
      <div className="grid grid-cols-5 gap-4">
        <StatCard label="Invocations (24h)" value={summary?.totalInvocations24h.toLocaleString() ?? '—'} />
        <StatCard label="Avg Latency" value={summary ? `${(summary.avgLatencyMs / 1000).toFixed(1)}s` : '—'} />
        <StatCard label="Tokens (24h, account)" value={summary ? `${(summary.totalTokens24h / 1000).toFixed(0)}k` : '—'} />
        <StatCard label="Success Rate" value={summary ? `${summary.successRate}%` : '—'} accent />
        <StatCard
          label="Errors (24h)"
          value={blind ? '—' : String(summary?.totalErrors24h ?? 0)}
          danger={!blind && !!summary && summary.totalErrors24h > 0}
        />
      </div>

      <Card padding="md">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            Guardrail Activity (6h){' '}
            <span className="text-xs font-normal text-[var(--color-text-tertiary)]">
              from AWS/Bedrock metrics
            </span>
          </h2>
          <div className="flex gap-5 text-xs">
            <span>
              <span className="text-[var(--color-text-tertiary)]">Invocations: </span>
              <b>{blind ? '—' : guardrail?.totalInvocations ?? 0}</b>
            </span>
            <span>
              <span className="text-[var(--color-text-tertiary)]">Interventions: </span>
              <b className={!blind && (guardrail?.totalInterventions ?? 0) > 0 ? 'text-red-600' : ''}>
                {blind ? '—' : guardrail?.totalInterventions ?? 0}
              </b>
            </span>
            <span>
              <span className="text-[var(--color-text-tertiary)]">Rate: </span>
              <b>{blind ? '—' : `${guardrail?.interventionRate ?? '0.0'}%`}</b>
            </span>
          </div>
        </div>
        <GuardrailSparkline series={guardrail?.series ?? []} />
      </Card>
    </PageSection>
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
      <div className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">
        No guardrail activity in the last 6h.
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block h-[60px] w-full"
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
