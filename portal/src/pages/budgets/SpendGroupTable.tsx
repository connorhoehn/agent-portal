// The spend report grouped by person, model, source or trigger — one
// DataTable over GET /api/spend/report. The initiative grouping is the
// allocation ledger (InitiativesReport.tsx), because an initiative row carries
// its allocation, floor and discretionary remainder, which no other grouping has.
//
// Unknown costs are a chip beside the dollars, never a $0; a withheld figure is
// the lock, never a zero.

import {
  Chip,
  DataTable,
  type DataTableColumn,
  Inline,
  T,
} from '@connorhoehnslalom/ui-components/shared';
import { LockedFigure } from '../projects/BudgetAccess';
import { usd } from './budgetsFormat';
import { groupLabel, moneyOrDash, periodHeading, remainingTone, spendFigure } from './spendReportModel';
import type { BudgetAccessLock, SpendGroup, SpendGroupBy, SpendPeriod } from './types';

export function SpendFigureCell({ knownUsd, unknownCount, lock }: { knownUsd: number | undefined; unknownCount: number; lock: BudgetAccessLock | undefined }) {
  const fig = spendFigure(knownUsd, unknownCount);
  if (!fig) return lock ? <LockedFigure lock={lock} /> : <T tone="tertiary">—</T>;
  return (
    <Inline align="center" justify="end" gap="sm" wrap={false}>
      {fig.unknown && (
        <Chip tone="warning" size="xs" title="Entries whose cost was never recorded. Counted, never summed as $0.">{fig.unknown}</Chip>
      )}
      <T tabular tone={fig.text === 'unknown' ? 'secondary' : undefined}>{fig.text}</T>
    </Inline>
  );
}

function Money({ value, lock, tone }: { value: number | null | undefined; lock: BudgetAccessLock | undefined; tone?: 'danger' | 'warning' }) {
  if (value === undefined && lock) return <LockedFigure lock={lock} />;
  return <T tabular tone={value == null ? 'tertiary' : undefined} className={tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : undefined}>{moneyOrDash(value)}</T>;
}

export function SpendGroupTable({ groups, groupBy, period, lock, query }: {
  groups: SpendGroup[];
  groupBy: SpendGroupBy;
  period: SpendPeriod;
  lock: BudgetAccessLock | undefined;
  query: string;
}) {
  const q = query.trim().toLowerCase();
  const shown = groups.filter((g) => !q || groupLabel(g, groupBy).toLowerCase().includes(q) || (g.key ?? '').toLowerCase().includes(q));
  const withBudget = groupBy === 'actor';
  const columns: DataTableColumn<SpendGroup>[] = [
    {
      key: 'label',
      header: GROUP_HEADINGS[groupBy],
      render: (g) => (
        <T tone={g.key == null ? 'secondary' : undefined} title={g.key ?? undefined} className="truncate">{groupLabel(g, groupBy)}</T>
      ),
    },
    {
      key: 'known',
      header: periodHeading(period),
      numeric: true,
      sortable: true,
      compare: (a, b) => (a.knownUsd ?? 0) - (b.knownUsd ?? 0),
      render: (g) => <SpendFigureCell knownUsd={g.knownUsd} unknownCount={g.unknownCount} lock={lock} />,
    },
    {
      key: 'entries',
      header: 'Entries',
      numeric: true,
      sortable: true,
      compare: (a, b) => a.entries - b.entries,
      render: (g) => <T tabular>{g.entries}</T>,
    },
    {
      key: 'burn',
      header: 'Burn / day',
      numeric: true,
      render: (g) => <Money value={g.burnPerDay7d} lock={lock} />,
    },
    {
      key: 'projected',
      header: 'Projected month-end',
      numeric: true,
      sortable: true,
      compare: (a, b) => (a.projectedPeriodEndUsd ?? 0) - (b.projectedPeriodEndUsd ?? 0),
      render: (g) => {
        const over = g.allocatedUsd != null && g.projectedPeriodEndUsd != null && g.projectedPeriodEndUsd > g.allocatedUsd;
        return <Money value={g.projectedPeriodEndUsd} lock={lock} {...(over ? { tone: 'danger' as const } : {})} />;
      },
    },
    ...(groupBy === 'model' || groupBy === 'trigger' ? [] : [{
      key: 'held',
      header: 'Held',
      numeric: true,
      render: (g: SpendGroup) => <Money value={g.heldUsd} lock={lock} />,
    }]),
    ...(withBudget ? [{
      key: 'remaining',
      header: 'Budget left',
      numeric: true,
      render: (g: SpendGroup) => g.allocatedUsd == null
        ? (g.knownUsd === undefined && lock ? <LockedFigure lock={lock} /> : <T tone="tertiary" title="No user budget set: this person is unbraked">no budget</T>)
        : (
          <T tabular title={`${usd(g.allocatedUsd)} monthly user budget`}
            className={remainingTone(g.remainingUsd, g.allocatedUsd) === 'danger' ? 'text-danger' : remainingTone(g.remainingUsd, g.allocatedUsd) === 'warning' ? 'text-warning' : undefined}>
            {moneyOrDash(g.remainingUsd)}
          </T>
        ),
    }] : []),
  ];
  return (
    <DataTable
      data-testid="spend-group-table"
      aria-label={`Spend by ${GROUP_HEADINGS[groupBy].toLowerCase()}`}
      data={shown}
      columns={columns}
      keyField={(g) => g.key ?? '__unattributed'}
      emptyMessage={q ? 'Nothing matches this search.' : 'No spend recorded in this window.'}
    />
  );
}

const GROUP_HEADINGS: Readonly<Record<SpendGroupBy, string>> = {
  initiative: 'Initiative',
  actor: 'Person',
  model: 'Model',
  source: 'Source',
  trigger: 'Trigger',
};
