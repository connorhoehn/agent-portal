// Budgets — two reports about the same money, behind one nested rail.
//
// This page used to stack everything on one scroll: four tall KPI cards, two
// spend breakdowns, the per-initiative allocation ledger, AND the per-sprint
// grants table. They answer different questions for different moments — "what
// is each initiative allowed to spend this month" is a planning question, "who
// holds an envelope on which sprint" is a cadence question — so they are two
// reports you switch between, not one page you scroll through.
//
// The rail carries a count badge per report because the counts ARE the reason
// you pick one: nine initiatives and four grants is a different afternoon from
// nine and forty.

import { useMemo } from 'react';
import { NavLink, useSearchParams } from 'react-router';
import {
  LoadingState,
  PageSection,
  Stack,
  StatStrip,
  SubNavLayout,
  type SubNavItem,
  activeNavItemClassName,
  inactiveNavItemClassName,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { InitiativesReport } from './InitiativesReport';
import { SprintsReport } from './SprintsReport';
import {
  maintenanceStats, maintenanceTitle, mergeInitiativesWithBudgets, remainingHint, remainingTitle, usd,
} from './budgetsFormat';
import type { BudgetRow, BudgetSummary, GrantRow, InitiativeOption } from './types';

const MONTH_LABEL = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

// Reproduces SubNavLayout's own default active/inactive nav-item look (see
// the library's `renderNavItem` doc comment, and its `activeNavItemStyle`
// export) as Tailwind classes instead of a computed `style` object.

export default function BudgetsPage() {
  const { can, ready } = useCapabilities();
  // Reads are open to the leadership tier; only the allocation writes are
  // gated. program-owner now holds ManageBudgets — a program owner runs the
  // delivery program, so setting its ceiling is theirs.
  const canManage = ready && can('ManageBudgets');

  const [params, setParams] = useSearchParams();
  const report = params.get('report') === 'sprints' ? 'sprints' : 'initiatives';

  const { data, error, degraded, refresh } =
    useFetch<{ budgets: BudgetRow[]; summary: BudgetSummary }>('/api/budgets', 30_000);
  const budgetsFailure = error ?? degraded;
  const { data: grantData, error: grantError } =
    useFetch<{ grants: GrantRow[] }>('/api/budgets/grants', 60_000);
  // The full initiative roster — `/api/budgets` on its own only returns rows
  // with an allocation or spend (program-owner DEFECTS #7), which left an
  // initiative with neither invisible to the one page that could set its
  // first budget. `?limit=100` matches the seed's 14 `p-*` initiatives and
  // the same call ProjectsPage/FirstBudgetForm already make.
  const { data: initiativesData } =
    useFetch<InitiativeOption[]>('/api/graph/projects?limit=100', 60_000);

  const rawBudgets = useMemo(() => data?.budgets ?? [], [data]);
  const budgets = useMemo(
    () => initiativesData ? mergeInitiativesWithBudgets(initiativesData, rawBudgets) : rawBudgets,
    [initiativesData, rawBudgets],
  );
  const grants = useMemo(() => grantData?.grants ?? [], [grantData]);
  const summary = data?.summary;

  const maint = summary
    ? maintenanceStats(summary.totalSpentThisPeriodUsd, summary.totalMaintenanceUsd)
    : null;

  const items: SubNavItem[] = [
    {
      path: '/admin/budgets',
      label: 'Initiatives',
      hint: 'Monthly allocation per initiative',
      group: 'Reports',
      ...(budgets.length > 0 ? { count: budgets.length } : {}),
    },
    {
      // Labelled "Sprints", not "Sprint envelopes": the rail names the thing
      // you are looking at, and the report itself is free to use the domain
      // word where it is the precise one.
      path: '/admin/budgets?report=sprints',
      label: 'Sprints',
      hint: 'Envelopes granted against a sprint',
      group: 'Reports',
      ...(grants.length > 0 ? { count: grants.length } : {}),
    },
  ];

  const body = !data && !budgetsFailure ? (
    <LoadingState label="Loading budgets…" />
  ) : budgetsFailure && budgets.length === 0 ? (
    <UnavailableNotice
      error={budgetsFailure}
      what="budgets"
      source="Budgets are read from Aurora"
      onRetry={refresh}
    />
  ) : (
    <PageSection
      title={report === 'sprints' ? 'Sprints' : 'Initiatives'}
      description={report === 'sprints'
        ? 'Budget envelopes granted to an SME for one sprint, and what the initiative actually spent inside that window.'
        : `Monthly agent-spend allocations per initiative, against actuals from bot and marketplace runs · ${MONTH_LABEL}`}
    >
      {/* One compact strip rather than four tall cards: these are the frame
          for the report below, not the content. */}
      {summary && maint && (
        <StatStrip
          aria-label="Budget rollup"
          items={[
            { label: 'Allocated', value: usd(summary.totalAllocatedUsd), hint: MONTH_LABEL },
            {
              label: 'Spent this period',
              value: usd(summary.totalSpentThisPeriodUsd),
              hint: `${summary.byTrigger.reduce((n, t) => n + t.runCount, 0)} runs`,
            },
            {
              label: 'Remaining',
              value: usd(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd),
              ...(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd < 0
                ? { tone: 'danger' as const } : {}),
              hint: remainingHint(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd),
            },
            {
              label: 'Maintenance floor',
              value: usd(summary.totalMaintenanceUsd),
              hint: maint.hint,
            },
          ]}
        />
      )}

      <Stack gap="none" className="mt-4">
        {report === 'sprints' ? (
          <SprintsReport grants={grants} error={grantError} hasData={grantData != null} canManage={canManage} />
        ) : (
          <InitiativesReport
            budgets={budgets}
            summary={summary}
            error={error}
            hasData={data != null}
            canManage={canManage}
            refresh={refresh}
            initiatives={initiativesData}
          />
        )}
      </Stack>
    </PageSection>
  );

  return (
    <SubNavLayout
      title="Budgets"
      items={items}
      storageKey="budgets-subnav"
      contentAs="section"
      contentLabel="Budgets"
      renderNavItem={(item, children) => {
        // Both reports live at the same path and differ only by ?report=, so
        // an exact-path match would light both. Compare the search instead.
        const wantsSprints = item.path.includes('report=sprints');
        const isActive = wantsSprints === (report === 'sprints');
        return (
          <NavLink
            to={item.path}
            onClick={(e) => {
              // Keep it a param change rather than a navigation, so the two
              // fetches above are not remounted every time you switch report.
              e.preventDefault();
              const next = new URLSearchParams(params);
              if (wantsSprints) next.set('report', 'sprints'); else next.delete('report');
              setParams(next, { replace: true });
            }}
            className={isActive ? activeNavItemClassName : inactiveNavItemClassName}
          >
            {children}
          </NavLink>
        );
      }}
    >
      {body}
    </SubNavLayout>
  );
}

// Re-exported so the old deep imports keep resolving.
export { maintenanceTitle, remainingTitle };
