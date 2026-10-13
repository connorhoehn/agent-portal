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

import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useSearchParams } from 'react-router';
import {
  CollectionToolbar,
  LoadingState,
  PageSection,
  Stack,
  StatStrip,
  type SubNavItem,
  activeNavItemClassName,
  inactiveNavItemClassName,
} from '@connorhoehnslalom/ui-components/shared';
import { BuildSectionLayout } from '../../components/shell/BuildSectionLayout';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { InitiativesReport } from './InitiativesReport';
import { SprintsReport } from './SprintsReport';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { initiativeBudgetsCommandAdapter, matchesBudget, matchesGrant, sprintEnvelopesCommandAdapter } from './budgetsCommands';
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
  const { data: grantData, error: grantError, refresh: refreshGrants } =
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

  // One controlled search shared by the toolbar and the composer; switching
  // report clears it so a sprint query never silently narrows the ledger.
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const shownBudgets = budgets.filter((row) => matchesBudget(row, query));
  const shownGrants = grants.filter((row) => matchesGrant(row, query));
  const adapter = report === 'sprints'
    ? sprintEnvelopesCommandAdapter({ setQuery, refresh: refreshGrants })
    : initiativeBudgetsCommandAdapter({
      setQuery, refresh, rows: shownBudgets, open: (id) => navigate(`/iq/projects/${id}`),
    });

  const maint = summary
    ? maintenanceStats(summary.totalSpentThisPeriodUsd, summary.totalMaintenanceUsd)
    : null;

  const items: SubNavItem[] = [
    {
      path: '/admin/budgets',
      label: 'Initiatives',
      ...(budgets.length > 0 ? { count: budgets.length } : {}),
    },
    {
      // Labelled "Sprints", not "Sprint envelopes": the rail names the thing
      // you are looking at, and the report itself is free to use the domain
      // word where it is the precise one.
      path: '/admin/budgets?report=sprints',
      label: 'Sprints',
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
      <Stack gap="md" className="min-w-0" data-collection-command-boundary="embedded">
      {/* One line of stats at the app's body step, not four tall cards: these
          are the frame for the report below, not the content. The hints that
          used to sit under each card value are the clusters' tooltips. */}
      {summary && maint && (
        <StatStrip
          aria-label="Budget rollup"
          variant="line"
          items={[
            { label: 'allocated', value: usd(summary.totalAllocatedUsd), title: `Allocated for ${MONTH_LABEL}` },
            {
              label: 'spent this period',
              value: usd(summary.totalSpentThisPeriodUsd),
              title: `${summary.byTrigger.reduce((n, t) => n + t.runCount, 0)} runs this period`,
            },
            {
              label: summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd < 0 ? 'over allocation' : 'remaining',
              value: usd(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd),
              ...(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd < 0
                ? { tone: 'danger' as const } : {}),
              title: `${remainingHint(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd)}. ${remainingTitle(summary.totalMaintenanceUsd, summary.totalSpentThisPeriodUsd, MONTH_LABEL)}`,
            },
            {
              label: 'maintenance floor',
              value: usd(summary.totalMaintenanceUsd),
              title: `${maint.hint}. ${maintenanceTitle(maint.floorIsAllSpend, MONTH_LABEL)}`,
            },
          ]}
        />
      )}

      <CollectionToolbar
        label={report === 'sprints' ? 'Sprint envelope filters' : 'Initiative budget filters'}
        search={report === 'sprints'
          ? { value: query, onChange: setQuery, placeholder: 'Search initiative, sprint or SME', 'aria-label': 'Search sprint envelopes' }
          : { value: query, onChange: setQuery, placeholder: 'Search initiatives', 'aria-label': 'Search initiative budgets' }}
        summary={report === 'sprints'
          ? `${shownGrants.length} of ${grants.length} envelopes`
          : `${shownBudgets.length} of ${budgets.length} initiatives`}
        onRefresh={report === 'sprints' ? refreshGrants : refresh}
      />

      <Stack gap="none">
        {report === 'sprints' ? (
          <SprintsReport grants={grants} error={grantError} hasData={grantData != null} canManage={canManage} refresh={refreshGrants} query={query} />
        ) : (
          <InitiativesReport
            budgets={budgets}
            summary={summary}
            error={error}
            hasData={data != null}
            canManage={canManage}
            refresh={refresh}
            initiatives={initiativesData}
            query={query}
          />
        )}
      </Stack>
      <CollectionCommandHost key={report} adapter={adapter} />
      </Stack>
    </PageSection>
  );

  return (
    <BuildSectionLayout
      title="Budgets"
      items={items}
      storageKey="budgets-subnav"
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
              if (wantsSprints !== (report === 'sprints')) setQuery('');
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
    </BuildSectionLayout>
  );
}

// Re-exported so the old deep imports keep resolving.
export { maintenanceTitle, remainingTitle };
