import { SubNavLayout, type SubNavItem } from '../../components/shell/SubNavLayout';
import { useFetch } from '../../hooks/useFetch';
import { ObservabilityHelpButton } from './ObservabilityHelp';

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

  // Grouped sub-nav. Categories mirror the help panel so the mental model
  // is consistent: Operate / Triage / Quality / Eval / Governance. Harness
  // gets its own group because it's a workflow surface (run + diff +
  // promote) more than a passive observability surface.
  const items: SubNavItem[] = [
    // Operate — daily health + cost
    { group: 'Operate', path: 'oncall',            label: 'On-Call',           hint: 'Live alarms + incident timeline' },
    { group: 'Operate', path: 'summary',           label: 'Summary',           hint: 'Health overview' },
    { group: 'Operate', path: 'cost',              label: 'Cost',              hint: 'Spend + deploy markers' },
    { group: 'Operate', path: 'traffic',           label: 'Traffic',           hint: 'RPS + heatmap + top users' },
    { group: 'Operate', path: 'agents',            label: 'Agent Metrics',     hint: 'Per-agent CloudWatch stats' },

    // Triage — find that one failure
    { group: 'Triage',  path: 'invocations',       label: 'Recent',            hint: 'Last 50 agent calls', count: invocationCount },
    { group: 'Triage',  path: 'invocations/search',label: 'Search',            hint: 'Filter by prompt / agent / score' },
    { group: 'Triage',  path: 'capability-events', label: 'Capability Events', hint: 'Browser + code interpreter' },
    { group: 'Triage',  path: 'sessions',          label: 'Sessions',          hint: 'Chat thread replay' },
    { group: 'Triage',  path: 'memory',            label: 'Memory',            hint: 'Memory ops + cold sessions' },

    // Quality — model output health
    { group: 'Quality', path: 'drift',             label: 'Drift',             hint: 'Schema + judge + embedding' },
    { group: 'Quality', path: 'quality',           label: 'Quality',           hint: 'Judge scores + feedback' },
    { group: 'Quality', path: 'guardrail-rules',   label: 'Guardrail Rules',   hint: 'Per-rule intervention detail' },

    // Eval — pre-deploy + judge sanity
    { group: 'Eval',    path: 'harness',           label: 'Harness',           hint: 'Replay test set + view runs' },
    { group: 'Eval',    path: 'calibration',       label: 'Calibration',       hint: 'Judge vs human MAE' },
    { group: 'Eval',    path: 'model-compare',     label: 'Model Compare',     hint: 'Side-by-side run delta' },

    // Governance — who saw + who approved
    { group: 'Governance', path: 'approvals',      label: 'Approval Queue',    hint: 'Pending HITL decisions' },
    { group: 'Governance', path: 'authz',          label: 'Authz Log',         hint: 'Live AVP decisions' },
  ];

  // Surface error count on the On-Call tab when present.
  if (errorCount && errorCount > 0) {
    items[0] = { ...items[0], count: errorCount };
  }

  return (
    <SubNavLayout
      title="Observability"
      items={items}
      titleAction={<ObservabilityHelpButton />}
      storageKey="obs"
    />
  );
}

export default ObservabilityLayout;
