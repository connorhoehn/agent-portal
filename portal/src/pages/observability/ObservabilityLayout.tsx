import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { SubNavLayout, type SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { ObservabilityHelpButton } from './ObservabilityHelp';

/** Every detail view's path segment — the list `showAll` opens for on arrival. */
const DRILL_IN_PATHS = [
  'quality', 'drift', 'guardrail-rules', 'approvals', 'authz',
  'invocations/search', 'tools', 'sessions', 'capability-events', 'memory', 'harness', 'calibration', 'model-compare',
  'traffic', 'agents',
];

interface ObsSummary {
  totalInvocations24h: number;
  totalErrors24h: number;
}

interface RecentInvocation {
  id: string;
  guardrailIntervened: boolean;
}

function ObservabilityLayout() {
  // Lightweight polling for nav badges. Same endpoints, same interval, as
  // the sub-pages that also read them (SummaryPage, InvocationsPage) —
  // `share: true` collapses concurrent polls into one request; a bare URL
  // match does nothing for two independent `fetch()` calls on its own.
  const { data: summary } = useFetch<ObsSummary>('/api/observability/summary', 30_000, { share: true });
  const { data: recent } = useFetch<{ invocations: RecentInvocation[] }>(
    '/api/observability/recent-invocations?limit=50',
    5_000,
    { share: true },
  );
  // Open the detail views when the page IS one — a deep link from ⌘K, a
  // breadcrumb or a bookmark used to land on a rail with nothing lit.
  const { pathname } = useLocation();
  const [showAll, setShowAll] = useState(
    () => DRILL_IN_PATHS.some((p) => pathname === `/admin/observability/${p}` || pathname.startsWith(`/admin/observability/${p}/`)),
  );

  const invocationCount = recent?.invocations.length;
  const errorCount = summary?.totalErrors24h;

  // Three questions, not five categories: is it healthy, what ran, what did it
  // cost. Everything else is a drill-in on one of those and stays hidden until
  // asked for — eighteen equal-weight links read as a pile of dashboards.
  // On-Call sits with the primaries: it is the one live-incident surface in
  // the product, and an alarm page should not need a disclosure to reach.
  const primary: SubNavItem[] = [
    { group: 'Health', path: 'summary',     label: 'Health',   hint: 'Errors, alarms, quality, drift' },
    { group: 'Health', path: 'oncall',      label: 'On-Call',  hint: 'Live alarms + incident timeline' },
    { group: 'Runs',   path: 'invocations', label: 'Runs',     hint: 'Every agent call, newest first',
      ...(invocationCount ? { count: invocationCount } : {}) },
    { group: 'Cost',   path: 'cost',        label: 'Cost',     hint: 'Spend, traffic, per-agent burn' },
  ];

  // Drill-ins, grouped under the question they answer.
  const drillIns: SubNavItem[] = [
    { group: 'Health', path: 'quality',         label: 'Quality',         hint: 'Judge scores + feedback' },
    { group: 'Health', path: 'drift',           label: 'Drift',           hint: 'Schema + judge + embedding' },
    { group: 'Health', path: 'guardrail-rules', label: 'Guardrail Rules', hint: 'Per-rule intervention detail' },
    { group: 'Health', path: 'approvals',       label: 'Approval Queue',  hint: 'Pending HITL decisions' },
    { group: 'Health', path: 'authz',           label: 'Authz Log',       hint: 'Live AVP decisions' },

    { group: 'Runs', path: 'invocations/search', label: 'Search',            hint: 'Filter by prompt / agent / score' },
    { group: 'Runs', path: 'tools',              label: 'Tool Calls',        hint: 'Per-tool latency + failures' },
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
  // Collapsed, the primaries carry no group: "HEALTH / Health · RUNS / Runs
  // · COST / Cost" was three headings over three identically named rows.
  // The headings earn their place only once the drill-ins sit under them.
  const items: SubNavItem[] = showAll
    ? (['Health', 'Runs', 'Cost'] as const).flatMap((g) => [
        ...primary.filter((i) => i.group === g),
        ...drillIns.filter((i) => i.group === g),
      ])
    : primary.map(({ group: _group, ...rest }) => rest);

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
      // "Health", not "Operate": the shell's Operate group also holds
      // Architecture, Knowledge and Capabilities, none of which are here, and
      // the breadcrumb for every page in this rail already reads Operate › Health.
      title="Health"
      items={items}
      titleAction={<ObservabilityHelpButton />}
      storageKey="obs"
      contentAs="section"
      contentLabel="Health"
      renderNavItem={(item, children) => (
        <NavLink
          to={item.path}
          className={({ isActive }) => navItemClassName(isActive)}
        >
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </SubNavLayout>
  );
}

// Reproduces SubNavLayout's own default active/inactive nav-item look
// (see the library's `renderNavItem` doc comment) as Tailwind classes on
// NavLink's `className` prop instead of a computed `style` object — a real
// router integration still needs `renderNavItem`, but nothing here needs an
// inline style to get it.
function navItemClassName(isActive: boolean): string {
  return isActive
    ? 'block px-[14px] py-2 border-l-[3px] border-l-primary bg-surface-hover text-text-primary no-underline cursor-pointer'
    : 'block px-[14px] py-2 border-l-[3px] border-transparent text-text-secondary no-underline cursor-pointer';
}

export default ObservabilityLayout;
