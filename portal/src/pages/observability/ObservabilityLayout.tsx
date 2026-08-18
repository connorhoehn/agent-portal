import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
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
  const [showAll, setShowAll] = useState(false);

  const invocationCount = recent?.invocations.length;
  const errorCount = summary?.totalErrors24h;

  // Three questions, not five categories: is it healthy, what ran, what did it
  // cost. Everything else is a drill-in on one of those and stays hidden until
  // asked for — eighteen equal-weight links read as a pile of dashboards.
  const primary: SubNavItem[] = [
    { group: 'Health', path: 'summary',     label: 'Health',   hint: 'Errors, alarms, quality, drift' },
    { group: 'Runs',   path: 'invocations', label: 'Runs',     hint: 'Every agent call, newest first',
      ...(invocationCount ? { count: invocationCount } : {}) },
    { group: 'Cost',   path: 'cost',        label: 'Cost',     hint: 'Spend, traffic, per-agent burn' },
  ];

  // Drill-ins, grouped under the question they answer.
  const drillIns: SubNavItem[] = [
    { group: 'Health', path: 'oncall',          label: 'On-Call',         hint: 'Live alarms + incident timeline' },
    { group: 'Health', path: 'quality',         label: 'Quality',         hint: 'Judge scores + feedback' },
    { group: 'Health', path: 'drift',           label: 'Drift',           hint: 'Schema + judge + embedding' },
    { group: 'Health', path: 'guardrail-rules', label: 'Guardrail Rules', hint: 'Per-rule intervention detail' },
    { group: 'Health', path: 'approvals',       label: 'Approval Queue',  hint: 'Pending HITL decisions' },
    { group: 'Health', path: 'authz',           label: 'Authz Log',       hint: 'Live AVP decisions' },

    { group: 'Runs', path: 'invocations/search', label: 'Search',            hint: 'Filter by prompt / agent / score' },
    { group: 'Runs', path: 'sessions',           label: 'Sessions',          hint: 'Chat thread replay' },
    { group: 'Runs', path: 'capability-events',  label: 'Capability Events', hint: 'Browser + code interpreter' },
    { group: 'Runs', path: 'memory',             label: 'Memory',            hint: 'Memory ops + cold sessions' },
    { group: 'Runs', path: 'harness',            label: 'Harness',           hint: 'Replay test set + view runs' },
    { group: 'Runs', path: 'calibration',        label: 'Calibration',       hint: 'Judge vs human MAE' },
    { group: 'Runs', path: 'model-compare',      label: 'Model Compare',     hint: 'Side-by-side run delta' },

    { group: 'Cost', path: 'traffic', label: 'Traffic',       hint: 'RPS + heatmap + top users' },
    { group: 'Cost', path: 'agents',  label: 'Agent Metrics', hint: 'Per-agent CloudWatch stats' },
  ];

  // Interleave so each drill-in sits under its own question rather than in a
  // trailing block — SubNavLayout groups by first appearance of the heading.
  const items: SubNavItem[] = showAll
    ? (['Health', 'Runs', 'Cost'] as const).flatMap((g) => [
        ...primary.filter((i) => i.group === g),
        ...drillIns.filter((i) => i.group === g),
      ])
    : [...primary];

  // Last, under its own heading, so the three questions stay the first thing
  // read. Power controls exist; they just do not go first.
  items.push({
    group: 'More',
    path: 'toggle-detail',
    label: showAll ? 'Hide detail views' : `Show ${drillIns.length} detail views`,
    onClick: () => setShowAll((v) => !v),
  });

  // Surface the error count on Health when there is something to see.
  if (errorCount && errorCount > 0) {
    const i = items.findIndex((it) => it.path === 'summary');
    if (i >= 0) items[i] = { ...items[i], count: errorCount } as SubNavItem;
  }

  return (
    <SubNavLayout
      title="Operate"
      items={items}
      titleAction={<ObservabilityHelpButton />}
      storageKey="obs"
      renderNavItem={(item, children, baseStyle) => (
        <NavLink
          to={item.path}
          style={({ isActive }) =>
            isActive
              ? { ...baseStyle, borderLeft: '3px solid var(--color-primary)', background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }
              : baseStyle
          }
        >
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </SubNavLayout>
  );
}

export default ObservabilityLayout;
