import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';
import { useFetch } from '../../hooks/useFetch';

interface ObsSummary {
  totalInvocations24h: number;
  totalErrors24h: number;
}

interface RecentInvocation {
  id: string;
  guardrailIntervened: boolean;
}

function ObservabilityLayout() {
  // Lightweight polling for nav badges. Same endpoints the sub-pages hit,
  // so the browser cache de-dupes — no extra network cost.
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30_000);
  const { data: recent } = useFetch<{ invocations: RecentInvocation[] }>(
    '/api/observability/recent-invocations?limit=50',
    10_000,
  );

  const invocationCount = recent?.invocations.length;
  const errorCount = summary?.totalErrors24h;

  const items: SubNavItem[] = [
    { path: 'oncall',             label: 'On-Call',           hint: 'Live alarms + incident timeline' },
    { path: 'summary',            label: 'Summary',           hint: 'Health overview' },
    { path: 'invocations',        label: 'Recent',            hint: 'Last 50 agent calls', count: invocationCount },
    { path: 'invocations/search', label: 'Search',            hint: 'Triage by prompt / agent / score' },
    { path: 'capability-events',  label: 'Capability Events', hint: 'Browser & code' },
    { path: 'agents',            label: 'Agent Metrics',     hint: 'Per-agent stats' },
    { path: 'sessions',          label: 'Sessions',          hint: 'Chat threads' },
    { path: 'authz',             label: 'Authz Log',         hint: 'Live AVP decisions' },
    { path: 'memory',            label: 'Memory',            hint: 'Memory ops + cold sessions' },
    { path: 'guardrail-rules',   label: 'Guardrail Rules',   hint: 'Per-rule intervention details' },
    { path: 'drift',             label: 'Drift',             hint: 'Schema + judge + embedding drift' },
    { path: 'quality',           label: 'Quality',           hint: 'Judge scores + feedback' },
    { path: 'cost',              label: 'Cost',              hint: 'Spend by agent + deploy markers' },
    { path: 'approvals',         label: 'Approval Queue',    hint: 'Pending HITL decisions' },
    { path: 'harness',           label: 'Harness',           hint: 'Replay test set + view runs' },
    { path: 'calibration',       label: 'Calibration',       hint: 'Judge vs human MAE drift' },
    { path: 'model-compare',     label: 'Model Compare',     hint: 'Side-by-side run delta' },
  ];

  // Surface error count on the On-Call tab when present (it's items[0]; the
  // operator should see the badge on the operational tab first).
  if (errorCount && errorCount > 0) {
    items[0] = { ...items[0], count: errorCount };
  }

  return <SubNavLayout title="Observability" items={items} />;
}

export default ObservabilityLayout;
