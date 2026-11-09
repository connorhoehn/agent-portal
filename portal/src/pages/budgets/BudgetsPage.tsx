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
//
// The Initiatives report rolls money up and down through the layout cascade
// (docs/layout-cascade.md): its list rail holds "All spend" and every
// initiative. "All spend" is one table with a group selector — the allocation
// ledger by initiative, or the spend ledger by person, model, source or
// trigger (GET /api/spend/report) — and selecting an initiative in the rail
// (or its name in the ledger) drills into that initiative's report:
// allocation → floor vs discretionary → people and envelopes → open work with
// fit. State lives in the URL (?group=&period=&initiative=) so a view links.

import { useMemo, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router';
import {
  Chip,
  CollectionToolbar,
  GroupedList,
  LoadingState,
  PageSection,
  Stack,
  StatStrip,
  T,
  type SubNavItem,
  activeNavItemClassName,
  inactiveNavItemClassName,
} from '@connorhoehn/ui-components/shared';
import { BuildSectionLayout } from '../../components/shell/BuildSectionLayout';
import { useShellBreadcrumbItems } from '../../components/shell/Breadcrumbs';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useCapabilities } from '../../lib/capabilities';
import { InitiativesReport } from './InitiativesReport';
import { SprintsReport } from './SprintsReport';
import { SpendGroupTable } from './SpendGroupTable';
import { InitiativeSpendReport } from './InitiativeSpendReport';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { initiativeBudgetsCommandAdapter, matchesBudget, matchesGrant, sprintEnvelopesCommandAdapter } from './budgetsCommands';
import {
  maintenanceStats, maintenanceTitle, mergeInitiativesWithBudgets, remainingHint, remainingTitle, usd,
} from './budgetsFormat';
import {
  GROUP_OPTIONS, OVERVIEW_ROW_ID, PERIOD_OPTIONS, budgetRailRows, mergeInitiativeLedger, parseGroupBy, parsePeriod,
  spendFigure, spendReportUrl,
} from './spendReportModel';
import type { BudgetRow, BudgetSummary, GrantRow, InitiativeOption, SpendGroupBy, SpendPeriod, SpendReport } from './types';

const MONTH_LABEL = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

const GROUP_NOUN: Readonly<Record<SpendGroupBy, string>> = {
  initiative: 'initiatives', actor: 'people', model: 'models', source: 'sources', trigger: 'triggers',
};

export default function BudgetsPage() {
  const { can, ready } = useCapabilities();
  // Reads are open to the leadership tier; only the allocation writes are
  // gated. program-owner now holds ManageBudgets — a program owner runs the
  // delivery program, so setting its ceiling is theirs.
  const canManage = ready && can('ManageBudgets');

  const [params, setParams] = useSearchParams();
  const report = params.get('report') === 'sprints' ? 'sprints' : 'initiatives';
  const groupBy = parseGroupBy(params.get('group'));
  const period = parsePeriod(params.get('period'));
  const initiativeId = report === 'initiatives' ? params.get('initiative') : null;

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
  // The spend ledger, grouped — only while the overview is on screen; the
  // drill-in reads its own initiative-scoped report.
  const { data: spend, error: spendError, refresh: refreshSpend } = useFetch<SpendReport>(
    report === 'initiatives' && !initiativeId ? spendReportUrl(groupBy, period) : null,
    30_000,
  );

  const rawBudgets = useMemo(() => data?.budgets ?? [], [data]);
  const budgets = useMemo(
    () => initiativesData ? mergeInitiativesWithBudgets(initiativesData, rawBudgets) : rawBudgets,
    [initiativesData, rawBudgets],
  );
  const ledger = useMemo(
    () => mergeInitiativeLedger(budgets, groupBy === 'initiative' ? spend?.groups ?? [] : []),
    [budgets, groupBy, spend],
  );
  const grants = useMemo(() => grantData?.grants ?? [], [grantData]);
  const summary = data?.summary;

  // One controlled search shared by the toolbar and the composer; switching
  // report clears it so a sprint query never silently narrows the ledger.
  const [query, setQuery] = useState('');
  const shownBudgets = budgets.filter((row) => matchesBudget(row, query));
  const shownGrants = grants.filter((row) => matchesGrant(row, query));

  // The phone form (under 40rem of the frame): the report or one initiative's report fills the
  // width under "‹ All initiatives"; that control shows the rail as the list, and choosing a row
  // goes back to the report (walk, 9 November: two rails filled 390 px, the table off-screen).
  const [narrowList, setNarrowList] = useState(false);
  const setView = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v == null) next.delete(k); else next.set(k, v); }
    setParams(next, { replace: true });
  };
  const openInitiative = (id: string | null) => { setNarrowList(false); setView({ initiative: id && id !== OVERVIEW_ROW_ID ? id : null }); };
  const reportHref = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('initiative', id);
    return `/admin/budgets?${next}`;
  };

  const adapter = report === 'sprints'
    ? sprintEnvelopesCommandAdapter({ setQuery, refresh: refreshGrants })
    : initiativeBudgetsCommandAdapter({
      setQuery, refresh: () => { refresh(); refreshSpend(); }, rows: shownBudgets, open: (id) => openInitiative(id),
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

  // ── The list rail (Initiatives report only) ──
  const railRows = budgetRailRows(budgets, summary ? { allocated: summary.totalAllocatedUsd, spent: summary.totalSpentThisPeriodUsd } : null);
  const selected = initiativeId ? budgets.find((b) => b.orgProjectId === initiativeId) ?? null : null;
  const baseTrail = useShellBreadcrumbItems();
  const trail = initiativeId
    ? [...baseTrail, { label: 'Initiatives', href: '/admin/budgets', onClick: (e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); openInitiative(null); } },
      { label: selected?.orgProjectName ?? initiativeId }]
    : undefined;

  // ── The overview's one line of stats: the budget rollup by initiative, the ledger's totals otherwise ──
  const totalsFigure = spend ? spendFigure(spend.totals.knownUsd, spend.totals.unknownCount) : null;
  const stats = groupBy === 'initiative'
    ? (summary && maint && (
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
            value: usd(Math.abs(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd)),
            ...(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd < 0
              ? { tone: 'danger' as const } : {}),
            title: `${remainingHint(summary.totalAllocatedUsd - summary.totalSpentThisPeriodUsd)}. ${remainingTitle(summary.totalMaintenanceUsd, summary.totalSpentThisPeriodUsd, MONTH_LABEL)}`,
          },
          {
            label: 'maintenance floor',
            value: usd(summary.totalMaintenanceUsd),
            title: `${maint.hint}. ${maintenanceTitle(maint.floorIsAllSpend, MONTH_LABEL)}`,
          },
          ...(spend?.totals.projectedPeriodEndUsd !== undefined ? [{
            label: 'projected month-end',
            value: usd(spend.totals.projectedPeriodEndUsd),
            ...(spend.totals.projectedPeriodEndUsd > summary.totalAllocatedUsd ? { tone: 'danger' as const } : {}),
            title: 'Month-to-date ledger spend plus the 7-day burn over the days left in the month',
          }] : []),
        ]}
      />
    ))
    : (spend && (
      <StatStrip
        aria-label="Spend ledger totals"
        variant="line"
        items={[
          { label: PERIOD_OPTIONS.find((o) => o.value === period)?.label.toLowerCase() ?? 'spent', value: totalsFigure?.text ?? 'locked' },
          ...(spend.totals.unknownCount > 0 ? [{ label: 'unknown cost', value: `${spend.totals.unknownCount} entries`, tone: 'danger' as const, title: 'Entries whose cost was never recorded — counted, never summed as $0' }] : []),
          ...(spend.totals.burnPerDay7d !== undefined ? [{ label: 'burn / day', value: usd(spend.totals.burnPerDay7d), title: 'Known spend over the last seven days, per day' }] : []),
          ...(spend.totals.projectedPeriodEndUsd !== undefined ? [{ label: 'projected month-end', value: usd(spend.totals.projectedPeriodEndUsd), title: 'Month-to-date spend plus the 7-day burn over the days left in the month' }] : []),
          ...(spend.totals.heldUsd != null ? [{ label: 'held', value: usd(spend.totals.heldUsd), title: 'Forecast p75 reserved by dispatches still in flight' }] : []),
        ]}
      />
    ));

  const toolbar = (
    <CollectionToolbar
      label={report === 'sprints' ? 'Sprint envelope filters' : 'Spend filters'}
      search={report === 'sprints'
        ? { value: query, onChange: setQuery, placeholder: 'Search initiative, sprint or SME', 'aria-label': 'Search sprint envelopes' }
        : { value: query, onChange: setQuery, placeholder: `Search ${GROUP_NOUN[groupBy]}`, 'aria-label': `Search ${GROUP_NOUN[groupBy]}` }}
      {...(report === 'initiatives' ? {
        filters: [
          { id: 'group', label: 'Group by', value: groupBy, options: GROUP_OPTIONS.map((o) => ({ value: o.value, label: o.label })), emptyValue: 'initiative',
            onChange: (v: string) => setView({ group: v === 'initiative' ? null : v }) },
          // The initiative ledger is the budget period by definition; only the other cuts take a window.
          ...(groupBy === 'initiative' ? [] : [{ id: 'period', label: 'Period', value: period, options: PERIOD_OPTIONS.map((o) => ({ value: o.value, label: o.label })), emptyValue: 'month',
            onChange: (v: string) => setView({ period: v === 'month' ? null : (v as SpendPeriod) }) }]),
        ],
      } : {})}
      summary={report === 'sprints'
        ? `${shownGrants.length} of ${grants.length} envelopes`
        : groupBy === 'initiative'
          ? `${shownBudgets.length} of ${budgets.length} initiatives`
          : `${spend?.groups.length ?? 0} ${GROUP_NOUN[groupBy]}`}
      onRefresh={report === 'sprints' ? refreshGrants : () => { refresh(); refreshSpend(); }}
    />
  );

  const overviewTable = groupBy === 'initiative' ? (
    <InitiativesReport
      budgets={ledger}
      reportHref={reportHref}
      lock={spend?.budgetAccess}
      error={error}
      hasData={data != null}
      canManage={canManage}
      refresh={() => { refresh(); refreshSpend(); }}
      initiatives={initiativesData}
      query={query}
    />
  ) : spendError && !spend ? (
    <UnavailableNotice error={spendError} what="the spend report" source="Spend is read from the spend ledger" onRetry={refreshSpend} />
  ) : !spend ? (
    <LoadingState label="Loading spend…" />
  ) : (
    <SpendGroupTable groups={spend.groups} groupBy={groupBy} period={period} lock={spend.budgetAccess} query={query} />
  );

  const loadingOrFailed = !data && !budgetsFailure ? (
    <LoadingState label="Loading budgets…" />
  ) : budgetsFailure && budgets.length === 0 ? (
    <UnavailableNotice
      error={budgetsFailure}
      what="budgets"
      source="Budgets are read from Aurora"
      onRetry={refresh}
    />
  ) : null;

  const initiativesBody = loadingOrFailed ?? (initiativeId ? (
    <InitiativeSpendReport initiativeId={initiativeId} fallbackName={selected?.orgProjectName ?? null} />
  ) : (
    <>
      {stats}
      {toolbar}
      <Stack gap="none">{overviewTable}</Stack>
    </>
  ));

  const sprintsBody = loadingOrFailed ?? (
    <PageSection
      title="Sprints"
      description="Budget envelopes granted to an SME for one sprint, and what the initiative actually spent inside that window."
    >
      <Stack gap="md" className="min-w-0">
        {toolbar}
        <Stack gap="none">
          <SprintsReport grants={grants} error={grantError} hasData={grantData != null} canManage={canManage} refresh={refreshGrants} query={query} />
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
      {...(trail ? { breadcrumbs: trail } : {})}
      {...(report === 'initiatives' ? {
        list: {
          title: 'Initiatives',
          description: initiativeId
            ? `Spend report · ${MONTH_LABEL}`
            : `Monthly agent-spend allocations per initiative — the maintenance floor first, then discretionary money — against the spend ledger · ${MONTH_LABEL}`,
          rail: {
            label: 'budget views',
            body: (
              <GroupedList
                size="md"
                currentStyle="bar"
                groupHeading="label"
                groupCountAlign="end"
                hideEmptyGroups
                groups={[
                  { id: 'overview', title: 'Overview' },
                  { id: 'initiatives', title: 'Initiatives', count: budgets.length },
                ]}
                rows={railRows.map((r) => ({
                  id: r.id,
                  groupId: r.groupId,
                  title: r.title,
                  subline: r.subline,
                  ...(r.blindSpot ? { pill: <Chip tone="warning" size="md">blind spot</Chip> } : {}),
                }))}
                currentId={initiativeId ?? OVERVIEW_ROW_ID}
                onOpenRow={(row) => openInitiative(row.id)}
              />
            ),
            footer: <T size="sm" tone="secondary">{budgets.length} initiatives · {MONTH_LABEL}</T>,
          },
          footer: <CollectionCommandHost key={`${report}-${initiativeId ?? 'all'}`} inPlace adapter={adapter} />,
          narrow: { showing: narrowList ? 'list' : 'record', onBack: () => setNarrowList(true), backLabel: 'All initiatives' },
        },
      } : {})}
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
              if (wantsSprints) { next.set('report', 'sprints'); next.delete('initiative'); } else next.delete('report');
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
      {report === 'sprints' ? sprintsBody : initiativesBody}
    </BuildSectionLayout>
  );
}

// Re-exported so the old deep imports keep resolving.
export { maintenanceTitle, remainingTitle };
