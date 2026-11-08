import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { type SubNavItem, activeNavItemClassName, inactiveNavItemClassName } from '@connorhoehn/ui-components/shared';
import { BuildSectionLayout } from '../../components/shell/BuildSectionLayout';
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

  // Four questions, not eighteen links: is it healthy, is it being used
  // safely, what ran, what did it cost. Everything else is a drill-in on one
  // of those and stays hidden until asked for — eighteen equal-weight links
  // read as a pile of dashboards.
  //
  // Safety was originally filed under Health, which put an approval queue and
  // an access log inside a health section and produced the breadcrumb
  // "Operate › Health › Approval Queue". A fleet can be entirely healthy while
  // handing someone data they should not have; those are different questions
  // and the nav now says so.
  // On-Call sits with the primaries: it is the one live-incident surface in
  // the product, and an alarm page should not need a disclosure to reach.
  const primary: SubNavItem[] = [
    // "Overview", not "Health". The section itself is Health, and naming its
    // first page the same thing printed the word three times down one rail —
    // once as the parent nav item, once as the group heading, once as the row.
    { group: 'Health', path: 'summary',     label: 'Overview' },
    { group: 'Health', path: 'oncall',      label: 'On-Call' },
    { group: 'Runs',   path: 'invocations', label: 'Runs',
      ...(invocationCount ? { count: invocationCount } : {}) },
    { group: 'Cost',   path: 'cost',        label: 'Cost' },
  ];

  // Drill-ins, grouped under the question they answer.
  const drillIns: SubNavItem[] = [
    { group: 'Health', path: 'quality',         label: 'Quality' },
    { group: 'Health', path: 'drift',           label: 'Drift' },

    // Safety is its own question, not a kind of health. A queue of decisions
    // waiting on a person, a log of who was refused, and what the guardrails
    // stopped are about whether the fleet is being used safely — a fleet can
    // be perfectly healthy and still be handing someone data they should not
    // have. Filing them under Health produced "Operate › Health › Approval
    // Queue", which reads as a claim that an approval is a health metric.
    { group: 'Safety', path: 'guardrail-rules', label: 'Guardrails' },
    { group: 'Safety', path: 'approvals',       label: 'Approvals' },
    { group: 'Safety', path: 'authz',           label: 'Access log' },

    { group: 'Runs', path: 'invocations/search', label: 'Search' },
    { group: 'Runs', path: 'tools',              label: 'Tool Calls' },
    { group: 'Runs', path: 'sessions',           label: 'Sessions' },
    { group: 'Runs', path: 'capability-events',  label: 'Capability Events' },
    { group: 'Runs', path: 'memory',             label: 'Memory' },
    { group: 'Runs', path: 'harness',            label: 'Harness' },
    { group: 'Runs', path: 'calibration',        label: 'Calibration' },
    { group: 'Runs', path: 'model-compare',      label: 'Model Compare' },

    { group: 'Cost', path: 'traffic', label: 'Traffic' },
    { group: 'Cost', path: 'agents',  label: 'Agent Metrics' },
  ];

  // Interleave so each drill-in sits under its own question rather than in a
  // trailing block — SubNavLayout groups by first appearance of the heading.
  // Collapsed, the primaries carry no group: "HEALTH / Health · RUNS / Runs
  // · COST / Cost" was three headings over three identically named rows.
  // The headings earn their place only once the drill-ins sit under them.
  const items: SubNavItem[] = showAll
    ? (['Health', 'Safety', 'Runs', 'Cost'] as const).flatMap((g) => [
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
    <BuildSectionLayout
      // "Health", not "Operate": the shell's Operate group also holds
      // Architecture, Knowledge and Capabilities, none of which are here, and
      // the breadcrumb for every page in this rail already reads Operate › Health.
      title="Observability"
      items={items}
      titleAction={<ObservabilityHelpButton />}
      storageKey="obs"
      contentLabel="Health"
      renderNavItem={(item, children) => (
        <NavLink
          to={item.path}
          className={({ isActive }) => (isActive ? activeNavItemClassName : inactiveNavItemClassName)}
        >
          {children}
        </NavLink>
      )}
    >
      <Outlet />
    </BuildSectionLayout>
  );
}

// Reproduces SubNavLayout's own default active/inactive nav-item look
// (see the library's `renderNavItem` doc comment) as Tailwind classes on
// NavLink's `className` prop instead of a computed `style` object — a real
// router integration still needs `renderNavItem`, but nothing here needs an
// inline style to get it.

export default ObservabilityLayout;
