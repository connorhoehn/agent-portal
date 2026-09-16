import type React from 'react';
import { Link } from 'react-router';
import {
  Card, Inline, KPIGrid, LineChart, LoadingState, NotificationCenter, PageSection, SectionLabel, Stack, StatCard,
  StatStrip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { formatTokenCount } from '../../lib/format';
import { T } from './Text';

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
  /** 'unknown' means the probe could not run — not that things are fine. */
  severity: 'ok' | 'warning' | 'critical' | 'unknown' | string;
  reason: string;
  affectedAgent: string | null;
}

interface Health {
  mocks: Record<string, boolean>;
  awsCredentials?: { ok: boolean; error?: string };
  datastore?: { ok: boolean; error?: string };
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
  /** The fleet read failed, so `agents` is an empty floor, not a reading. */
  fleetFailure?: string | null,
  /**
   * The fleet read is still in flight — a THIRD way `agents` can be an empty
   * floor rather than a reading, alongside failure and degradation. Without
   * this the loading instant reads exactly like a healthy empty fleet: "Nothing
   * needs you. All 0 deployed agents are healthy" — told to the operator before
   * anything has actually loaded. Callers must not derive next-steps at all
   * while this is true.
   */
  stillLoading?: boolean,
): NextStep[] {
  const steps: NextStep[] = [];

  if (stillLoading) return steps;

  // Say this first and let it stand alone. Every other step below is derived
  // from a runtime list, and with a failed read that list is empty — which
  // would otherwise produce the single worst sentence on this page: "Nothing
  // needs you. All 0 deployed agents are healthy."
  if (fleetFailure) {
    return [{
      label: 'Find out why the agent fleet cannot be listed',
      detail: `${fleetFailure}. Until this read succeeds, "deployed", "healthy" and "idle" `
        + 'on this page are unknown rather than zero.',
      to: '/iq/agents',
      urgent: true,
    }];
  }

  if (health?.datastore?.ok === false && health?.awsCredentials?.ok !== false) {
    // Only when credentials are fine — an expired session explains a dead
    // database, and reporting both would send someone down two paths at once.
    steps.push({
      label: 'Aurora is unreachable',
      detail:
        `${health.datastore.error ?? 'The cluster did not answer'}. Trace, quality and ` +
        `evaluation history all live there, so those panels are unknown rather than empty.`,
      to: '/admin/observability/summary',
      urgent: true,
    });
  }

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
      // Invocations seeds its filters from the query (`invocationsFilters.ts`),
      // so the link lands on the failures it names, not on the full tail.
      to: failing.length === 1
        ? `/admin/observability/invocations?status=error&agentId=${encodeURIComponent(failing[0].id)}`
        : '/admin/observability/invocations?status=error',
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
  // Same URL + interval as ObservabilityLayout's nav-badge poll —
  // `share: true` collapses the two into one request per tick.
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30000, { share: true });
  const { data: guardrail } = useFetch<GuardrailMetrics>(
    '/api/capabilities/guardrail/metrics?hours=6',
    60000,
  );
  // `{ agents, degraded?, error? }` — an object since a bare array could not
  // carry the marker. This is the page that most needs it: "Deployed agents 0"
  // and a green "Nothing needs you / All 0 deployed agents are healthy" is the
  // quiet-system illusion in its purest form.
  const {
    data: agentsResp, error: agentsError, degraded: agentsDegraded, isLoading: agentsLoading, refresh: refreshAgents,
  } = useFetch<{ agents: AgentRuntime[] }>('/api/agents', 60000);
  const agents = agentsResp?.agents;
  const fleetFailure = agentsError ?? agentsDegraded;
  const { data: alarmData } = useFetch<{ alarms: Alarm[] }>(
    '/api/observability/oncall/alarms',
    30000,
  );
  const { data: health } = useFetch<Health>('/api/health', 60000);

  const runtimes = agents ?? [];
  const alarms = alarmData?.alarms ?? [];
  const healthy = runtimes.filter((a) => a.status === 'healthy').length;
  const firing = alarms.filter((a) => a.severity !== 'ok');
  // The fleet read has not resolved (no data yet) and has not errored either —
  // distinct from "resolved and empty". Only this state may not answer with a
  // reassurance.
  const fleetStillLoading = agentsLoading && agents === undefined && !fleetFailure;
  const steps = deriveNextSteps(alarms, runtimes, summary ?? null, health ?? null, fleetFailure, fleetStillLoading);

  // With no usable credentials every AWS-backed panel comes back empty, and an
  // empty result is indistinguishable from a healthy one unless we say so. A
  // green "0 firing / all signals within thresholds" during an outage is worse
  // than no panel at all — it actively tells you not to look.
  // Blind covers both ways of not knowing: no credentials, or no database.
  // A degraded fleet read is a third way of not knowing, alongside no
  // credentials and no database — and it must dash the same numbers, or the
  // page derives "Nothing needs you" from a runtime list it never got.
  const blind = health?.awsCredentials?.ok === false
    || health?.datastore?.ok === false
    || fleetFailure != null;
  const dash = (v: React.ReactNode): React.ReactNode => (blind ? '—' : v);

  return (
    <PageSection
      title="Health"
      description="What is deployed, whether it is working, and what needs you next."
    >
      {fleetFailure && (
        <UnavailableNotice
          error={fleetFailure}
          what="the agent fleet"
          source="Runtimes are listed live from the AgentCore control plane"
          onRetry={refreshAgents}
          className="mb-4"
        />
      )}

      {/* ── Right now ─────────────────────────────────────────────────── */}
      <Inline gap="md" wrap={false} className="items-stretch [&>*]:flex-1">
        <StatCard
          label="Deployed agents"
          value={runtimes.length || '—'}
          hint={(
            <Stack gap="none">
              <T>{blind ? 'unknown' : `${healthy} healthy${runtimes.length > healthy ? ` · ${runtimes.length - healthy} not` : ''}`}</T>
              <T className="text-xs text-text-tertiary" wrap>
                {blind
                  ? 'Cannot list runtimes while the backend is unreachable.'
                  : 'Live from AgentCore Runtime, not a static list.'}
              </T>
            </Stack>
          )}
        />

        <StatCard
          label="Alarms"
          value={dash(firing.length)}
          danger={!blind && firing.length > 0}
          hint={(
            <Stack gap="none">
              <T>firing</T>
              <T className="text-xs text-text-tertiary" wrap>
                {blind
                  ? 'Cannot evaluate alarms while the backend is unreachable.'
                  : alarms[0]?.reason ?? 'No alarm evaluation yet.'}
              </T>
            </Stack>
          )}
        />

        <StatCard
          label="Errors (24h)"
          title="Real system errors from AgentCore runtimes (CloudWatch SystemErrors). This is a failure count, not answer quality — a low judge score is a weak answer to a request that still succeeded and is tracked separately on Quality / On-Call."
          value={dash(summary?.totalErrors24h ?? 0)}
          danger={!blind && (summary?.totalErrors24h ?? 0) > 0}
          hint={(
            <Stack gap="none">
              <T>{blind ? 'no data' : `of ${summary?.totalInvocations24h ?? 0} runs`}</T>
              <T className="text-xs text-text-tertiary">System failures, not answer quality.</T>
              <Link to="/admin/observability/invocations?status=error" className="text-xs text-primary hover:underline">
                Open Runs →
              </Link>
            </Stack>
          )}
        />
      </Inline>

      {/* ── Fleet ──────────────────────────────────────────────────────── */}
      {!blind && runtimes.length > 0 && (
        <Card padding="md">
          <SectionLabel as="div">Fleet</SectionLabel>
          {/* mdColumns: this page lives inside ObservabilityLayout's nested
              rail, narrower at the md band than a full-width page. */}
          <KPIGrid columns={4} mdColumns={2} className="mt-3">
            {runtimes.map((a) => (
              <StatCard
                key={a.id}
                label={a.name}
                value={a.invocationsLast24h}
                danger={a.errorsLast24h > 0}
                hint={`p50 ${a.latencyP50Ms}ms${a.errorsLast24h > 0 ? ` · ${a.errorsLast24h} errors` : ''}`}
              />
            ))}
          </KPIGrid>
        </Card>
      )}

      {/* ── What to do next ───────────────────────────────────────────── */}
      <Card padding="md">
        <SectionLabel as="div">What to do next</SectionLabel>
        {fleetStillLoading ? (
          <Stack gap="none" className="mt-3">
            <LoadingState label="Checking fleet health…" />
          </Stack>
        ) : (
        <Stack gap="sm" className="mt-3">
          {steps.map((s) => (
            <Link
              key={s.label}
              to={s.to}
              className="flex items-start gap-3 rounded-md border border-[var(--color-border)] p-3 no-underline hover:bg-[var(--color-surface-hover)]"
            >
              <T
                as="div"
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                  s.urgent ? 'bg-danger' : 'bg-[var(--color-text-tertiary)]'
                }`}
              />
              <Stack gap="none">
                <T as="div" className="text-sm font-medium text-[var(--color-text-primary)]">
                  {s.label}
                </T>
                <T as="div" className="text-xs text-[var(--color-text-secondary)]" wrap>{s.detail}</T>
              </Stack>
            </Link>
          ))}
        </Stack>
        )}
      </Card>

      {/* ── Alarms, in full ────────────────────────────────────────────── */}
      {!blind && (
        <Card padding="md">
          <SectionLabel as="div">Alarms</SectionLabel>
          <Stack gap="none" className="mt-3">
            <NotificationCenter
              items={alarms.map((a) => ({
                id: a.name,
                title: a.name,
                body: a.reason,
                category: a.affectedAgent ?? undefined,
                // No server-side read/unread state exists for an alarm — the
                // best honest signal is severity: a resolved ('ok') alarm
                // reads as read, a firing one as unread, so the badge count
                // matches the firing count above rather than every alarm ever
                // evaluated.
                read: a.severity === 'ok',
              }))}
            />
          </Stack>
        </Card>
      )}

      {/* ── Raw numbers, below the fold of the decision ───────────────── */}
      <StatStrip
        aria-label="24h rollup"
        items={[
          { label: 'Invocations (24h)', value: summary?.totalInvocations24h.toLocaleString() ?? '—' },
          { label: 'Avg Latency', value: summary ? `${(summary.avgLatencyMs / 1000).toFixed(1)}s` : '—' },
          { label: 'Tokens (24h, account)', value: summary ? formatTokenCount(summary.totalTokens24h, { compact: true }) : '—' },
          { label: 'Success Rate', value: summary ? `${summary.successRate}%` : '—', tone: 'accent' },
          {
            label: 'Errors (24h)',
            value: blind ? '—' : String(summary?.totalErrors24h ?? 0),
            hint: 'System errors, not answer quality',
            ...(!blind && !!summary && summary.totalErrors24h > 0 ? { tone: 'danger' as const } : {}),
          },
        ]}
      />

      <Card padding="md">
        <Inline align="center" justify="between" className="mb-3">
          <Inline align="baseline" gap="xs">
            <T as="div" className="text-sm font-semibold">Guardrail Activity (6h)</T>
            <T className="text-xs font-normal text-[var(--color-text-tertiary)]">
              from AWS/Bedrock metrics
            </T>
          </Inline>
          <Inline gap="lg" className="text-xs">
            <T>
              <T className="text-[var(--color-text-tertiary)]">Invocations: </T>
              <T className="font-semibold">{blind ? '—' : guardrail?.totalInvocations ?? 0}</T>
            </T>
            <T>
              <T className="text-[var(--color-text-tertiary)]">Interventions: </T>
              <T className={`font-semibold ${!blind && (guardrail?.totalInterventions ?? 0) > 0 ? 'text-red-600' : ''}`}>
                {blind ? '—' : guardrail?.totalInterventions ?? 0}
              </T>
            </T>
            <T>
              <T className="text-[var(--color-text-tertiary)]">Rate: </T>
              <T className="font-semibold">{blind ? '—' : `${guardrail?.interventionRate ?? '0.0'}%`}</T>
            </T>
          </Inline>
        </Inline>
        {(guardrail?.series.length ?? 0) === 0 ? (
          <T as="div" className="p-4 text-center text-xs text-[var(--color-text-tertiary)]">
            No guardrail activity in the last 6h.
          </T>
        ) : (
          <LineChart
            height={140}
            series={[
              {
                label: 'Invocations',
                data: (guardrail?.series ?? []).map((p) => ({ x: p.timestamp, y: p.invocations })),
              },
              {
                label: 'Interventions',
                data: (guardrail?.series ?? []).map((p) => ({ x: p.timestamp, y: p.interventions })),
                color: 'var(--color-danger)',
              },
            ]}
            xFormat={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          />
        )}
      </Card>
    </PageSection>
  );
}

export default SummaryPage;
