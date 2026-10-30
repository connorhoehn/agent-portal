// One initiative's spend report (DE-53), opened from the Budgets list rail:
// the allocation, the maintenance floor funded first, what is left for
// discretionary work, who is spending it and under which envelope, and
// whether each open item fits what is left — in that order, table-first.
// Holds and run outcomes are disclosed on demand.
//
// Reads GET /api/spend/report?initiativeId=…&groupBy=actor (routes/spend-report.ts).
// Unknown costs read "unknown", never $0; withheld figures are the lock.

import { Link } from 'react-router';
import {
  Chip,
  CollapsibleSection,
  DataTable,
  type DataTableColumn,
  Inline,
  LoadingState,
  PageSection,
  Stack,
  StatStrip,
  StatusPill,
  T,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { LockedFigure } from '../projects/BudgetAccess';
import { ago, budgetPeriodLabel, modelLabelFor, usd } from './budgetsFormat';
import { SpendFigureCell } from './SpendGroupTable';
import {
  basisLabel, envelopeBurn, fitPill, moneyOrDash, peopleWithEnvelopes, remainingTone, spendReportUrl,
  type PersonEnvelopeRow,
} from './spendReportModel';
import type { InitiativeSpend, OpenItemFit, SpendHoldView, SpendReport } from './types';
import { absoluteTime } from '../../lib/relativeTime';

const MONTH_LABEL = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

function AllocationStrip({ ini }: { ini: InitiativeSpend }) {
  const a = ini.allocation;
  const r = ini.reserve;
  if (!a || !r) {
    return ini.budgetAccess ? (
      <Inline gap="sm" align="center" wrap>
        <LockedFigure lock={ini.budgetAccess} />
        <T size="sm" tone="secondary">{ini.budgetAccess.reason}</T>
      </Inline>
    ) : null;
  }
  const remainingToneValue = remainingTone(r.discretionaryRemainingUsd, a.allocatedUsd);
  const held = r.floorHeldUsd + r.discretionaryHeldUsd;
  return (
    <StatStrip
      aria-label="Allocation, floor and discretionary money"
      variant="line"
      items={[
        {
          label: 'allocated',
          value: a.allocatedUsd == null ? 'unallocated' : usd(a.allocatedUsd),
          ...(a.allocatedUsd == null ? { tone: 'danger' as const } : {}),
          title: a.effectiveHardCapUsd != null ? `Monthly allocation for ${MONTH_LABEL}; hard cap ${usd(a.effectiveHardCapUsd)}` : `Monthly allocation for ${MONTH_LABEL}`,
        },
        ...(budgetPeriodLabel(a).betweenSprints
          ? [{ label: 'period', value: 'between sprints', title: 'No sprint is open, so this sprint allocation is not in force; the spend shown is the calendar month’s' }]
          : budgetPeriodLabel(a).key ? [{ label: 'period', value: budgetPeriodLabel(a).key as string, title: 'The budget period this allocation is in force for' }] : []),
        {
          label: 'maintenance floor',
          value: r.reserveUsd == null ? usd(r.floorSpentUsd) : `${usd(r.floorSpentUsd)} of ${usd(r.reserveUsd)}`,
          title: `Essential bots’ scheduled spend against the reserve, funded before any discretionary work. Trailing 30 days: ${usd(r.maintenance30dUsd)} over ${r.maintenance30dRuns} runs.`,
        },
        { label: 'discretionary spent', value: usd(r.discretionarySpentUsd), title: 'Every person, job and box dispatch this month' },
        ...(held > 0 ? [{ label: 'held', value: usd(held), title: 'Forecast p75 reserved by dispatches still in flight' }] : []),
        {
          label: (r.discretionaryRemainingUsd ?? 0) < 0 ? 'discretionary over' : 'discretionary left',
          value: r.discretionaryRemainingUsd == null ? '—' : usd(Math.abs(r.discretionaryRemainingUsd)),
          ...(remainingToneValue === 'danger' ? { tone: 'danger' as const } : {}),
          title: 'Allocation minus the floor, discretionary spend and holds: what new work is judged against',
        },
        ...(a.unknownCount > 0 ? [{ label: 'unknown cost', value: `${a.unknownCount} ${a.unknownCount === 1 ? 'entry' : 'entries'}`, tone: 'danger' as const, title: 'Entries whose cost was never recorded — counted, never summed as $0' }] : []),
      ]}
    />
  );
}

function PeopleTable({ rows, lock }: { rows: PersonEnvelopeRow[]; lock: InitiativeSpend['budgetAccess'] }) {
  const columns: DataTableColumn<PersonEnvelopeRow>[] = [
    {
      key: 'person',
      header: 'Person',
      render: (r) => <T tone={r.id === '__none' ? 'secondary' : undefined} className="truncate">{r.name}</T>,
    },
    {
      key: 'spent',
      header: 'Spent this month',
      numeric: true,
      render: (r) => r.spend
        ? <SpendFigureCell knownUsd={r.spend.knownUsd} unknownCount={r.spend.unknownCount} lock={lock} />
        : <T tone="tertiary">—</T>,
    },
    {
      key: 'envelope',
      header: 'Envelope',
      render: (r) => r.envelope ? (
        <Inline gap="sm" align="center" wrap={false} className="min-w-0">
          <T className="truncate" title={r.envelope.startsOn ? `${r.envelope.startsOn} → ${r.envelope.endsOn ?? 'open'}` : 'Standing grant'}>
            {r.envelope.sprintName ?? 'Standing grant'}
          </T>
          {r.envelope.sprintStatus && r.envelope.sprintStatus !== 'active' && <Chip tone="neutral" size="xs">{r.envelope.sprintStatus}</Chip>}
          {r.otherEnvelopes > 0 && <Chip tone="neutral" size="xs" title="Envelopes on other sprints">+{r.otherEnvelopes}</Chip>}
        </Inline>
      ) : <T tone="tertiary">none</T>,
    },
    {
      key: 'granted',
      header: 'Granted',
      numeric: true,
      render: (r) => <T tabular tone={r.envelope ? undefined : 'tertiary'}>{r.envelope ? usd(r.envelope.allocatedUsd) : '—'}</T>,
    },
    {
      key: 'burn',
      header: 'Envelope burn',
      numeric: true,
      render: (r) => {
        if (!r.envelope) return <T tone="tertiary">—</T>;
        const b = envelopeBurn(r.envelope);
        return <T tabular tone={b.text === 'unknown' ? 'secondary' : undefined} title={b.title}>{b.text}{b.unknown ? ` + ${b.unknown}` : ''}</T>;
      },
    },
    {
      key: 'left',
      header: 'Envelope left',
      numeric: true,
      render: (r) => {
        if (!r.envelope || r.envelope.remainingUsd == null) return <T tone="tertiary">—</T>;
        const tone = remainingTone(r.envelope.remainingUsd, r.envelope.allocatedUsd);
        return <T tabular className={tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : undefined}>{usd(r.envelope.remainingUsd)}</T>;
      },
    },
  ];
  return (
    <DataTable
      data-testid="initiative-spend-people"
      aria-label="People and envelopes"
      data={rows}
      columns={columns}
      keyField={(r) => r.id}
      emptyMessage="Nobody has spent on this initiative this month, and nobody holds an envelope on it."
    />
  );
}

function OpenWorkTable({ ini }: { ini: InitiativeSpend }) {
  const hasAllocation = ini.allocation?.allocatedUsd != null;
  const columns: DataTableColumn<OpenItemFit>[] = [
    {
      key: 'item',
      header: 'Open item',
      render: (i) => (
        <Link
          to={`/iq/projects/${encodeURIComponent(ini.id)}?tab=work&item=${encodeURIComponent(i.id)}`}
          className="truncate text-text-primary no-underline hover:text-primary hover:underline"
          title={i.key ?? i.id}
        >
          {i.title}
        </Link>
      ),
    },
    { key: 'priority', header: 'Priority', render: (i) => <T tone="secondary">{i.priority}</T> },
    { key: 'points', header: 'Points', numeric: true, render: (i) => <T tabular tone={i.storyPoints == null ? 'tertiary' : undefined}>{i.storyPoints ?? '—'}</T> },
    { key: 'model', header: 'Model', render: (i) => <T tone="secondary" className="truncate">{i.model ? modelLabelFor(i.model) : '—'}</T> },
    {
      key: 'p75',
      header: 'Forecast p75',
      numeric: true,
      render: (i) => i.p75Usd === undefined && ini.budgetAccess
        ? <LockedFigure lock={ini.budgetAccess} />
        : <T tabular tone={i.p75Usd == null ? 'tertiary' : undefined} title={`Basis: ${basisLabel(i.basis)}`}>{moneyOrDash(i.p75Usd)}</T>,
    },
    {
      key: 'fit',
      header: 'Fit',
      render: (i) => {
        const pill = fitPill(i, hasAllocation);
        if (!pill) return ini.budgetAccess ? <LockedFigure lock={ini.budgetAccess} /> : <T tone="tertiary">—</T>;
        return (
          <T as="span" title={`${pill.title}${i.aheadUsd ? ` Ahead of it: ${usd(i.aheadUsd)}.` : ''}`}>
            <StatusPill state={pill.state} label={pill.label} size="sm" />
          </T>
        );
      },
    },
  ];
  const f = ini.forecast;
  const missing = f.unestimatedSizedItems + f.unsizedItems;
  return (
    <Stack gap="sm">
      <DataTable
        data-testid="initiative-spend-open-work"
        aria-label="Open work against the discretionary remainder"
        data={f.items}
        columns={columns}
        keyField={(i) => i.id}
        emptyMessage="No open items on this initiative."
      />
      {(f.mixedModels || missing > 0) && (
        <T size="xs" tone="secondary">
          {f.mixedModels && f.models ? `Forecasts are per model, not blended: ${f.models.map((m) => `${m.model ? modelLabelFor(m.model) : 'model not recorded'} ${usd(m.p75Usd)}`).join(' · ')}. ` : ''}
          {missing > 0 ? `${missing} open ${missing === 1 ? 'item has' : 'items have'} no estimate and ${missing === 1 ? 'is' : 'are'} not in the total.` : ''}
        </T>
      )}
    </Stack>
  );
}

function HoldsTable({ holds }: { holds: SpendHoldView[] }) {
  const columns: DataTableColumn<SpendHoldView>[] = [
    { key: 'source', header: 'Dispatch', render: (h) => <T>{h.source.replace(/_/g, ' ')}{h.essential ? ' · floor' : ''}</T> },
    { key: 'actor', header: 'By', render: (h) => <T tone={h.actorName ? undefined : 'tertiary'}>{h.actorName ?? h.actorId ?? 'scheduled'}</T> },
    { key: 'amount', header: 'Held (p75)', numeric: true, render: (h) => <T tabular>{usd(h.amountUsd)}</T> },
    { key: 'since', header: 'Since', render: (h) => <T tone="tertiary" title={absoluteTime(h.createdAt)}>{ago(h.createdAt)}</T> },
  ];
  return <DataTable data-testid="initiative-spend-holds" aria-label="Open spend holds" data={holds} columns={columns} keyField={(h) => h.id} />;
}

function RunsTable({ runs }: { runs: InitiativeSpend['runs'] }) {
  type Row = InitiativeSpend['runs']['byTrigger'][number];
  const columns: DataTableColumn<Row>[] = [
    { key: 'trigger', header: 'Trigger', render: (r) => <T>{r.trigger}</T> },
    { key: 'done', header: 'Done', numeric: true, render: (r) => <T tabular>{r.done}</T> },
    { key: 'failed', header: 'Failed', numeric: true, render: (r) => <T tabular className={r.failed > 0 ? 'text-danger' : undefined}>{r.failed}</T> },
    { key: 'skipped', header: 'Skipped', numeric: true, render: (r) => <T tabular>{r.skipped}</T> },
    { key: 'running', header: 'Running', numeric: true, render: (r) => <T tabular>{r.running}</T> },
  ];
  return <DataTable data-testid="initiative-spend-runs" aria-label="Run outcomes by trigger" data={runs.byTrigger} columns={columns} keyField={(r) => r.trigger} emptyMessage="No runs this month." />;
}

export function InitiativeSpendReport({ initiativeId, fallbackName }: { initiativeId: string; fallbackName: string | null }) {
  const { data, error, refresh } = useFetch<SpendReport>(spendReportUrl('actor', 'month', initiativeId), 30_000);
  if (error && !data) {
    return <UnavailableNotice error={error} what="the spend report" source="Spend is read from the spend ledger" onRetry={refresh} />;
  }
  const ini = data?.initiative;
  if (!ini) return <LoadingState label="Loading the spend report…" />;
  const lock = ini.budgetAccess ?? data?.budgetAccess;
  const name = ini.name ?? fallbackName ?? ini.id;
  const people = peopleWithEnvelopes(ini.people, ini.envelopes);
  const runNote = [
    ini.runs.overRunBudget > 0 ? `${ini.runs.overRunBudget} over run budget` : null,
    ini.runs.skippedForBudget > 0 ? `${ini.runs.skippedForBudget} skipped by a budget gate` : null,
  ].filter(Boolean).join(' · ');
  return (
    <Stack gap="lg" className="min-w-0" data-testid="initiative-spend-report">
      <PageSection
        title={name}
        description={`Agent spend for ${MONTH_LABEL}: the allocation, the maintenance floor funded first, then what is left for discretionary work.`}
        actions={(
          <Link to={`/iq/projects/${encodeURIComponent(ini.id)}`} className="text-primary no-underline hover:underline">
            Open initiative
          </Link>
        )}
      >
        <AllocationStrip ini={ini} />
      </PageSection>

      <PageSection title="People and envelopes" count={people.filter((r) => r.id !== '__none').length}>
        <PeopleTable rows={people} lock={lock} />
      </PageSection>

      <PageSection
        title="Open work"
        description="Each open item’s p75 against the discretionary money left, after every higher-priority item ahead of it."
        count={ini.forecast.items.length}
      >
        <OpenWorkTable ini={ini} />
      </PageSection>

      {ini.holds.count > 0 && (
        <CollapsibleSection title="Money in flight" badge={<Chip tone="neutral" size="xs">{ini.holds.count}</Chip>} defaultOpen={false} storageKey="budgets.initiative-spend.holds">
          <HoldsTable holds={ini.holds.items} />
        </CollapsibleSection>
      )}

      <CollapsibleSection
        title="Run outcomes this month"
        badge={<Chip tone={runNote ? 'warning' : 'neutral'} size="xs">{runNote || `${ini.runs.total} runs`}</Chip>}
        defaultOpen={false}
        storageKey="budgets.initiative-spend.runs"
      >
        <RunsTable runs={ini.runs} />
      </CollapsibleSection>
    </Stack>
  );
}
