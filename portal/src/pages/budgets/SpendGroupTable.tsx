// The spend report grouped by person, model, source or trigger — one
// DataTable over GET /api/spend/report. The initiative grouping is the
// allocation ledger (InitiativesReport.tsx), because an initiative row carries
// its allocation, floor and discretionary remainder, which no other grouping has.
//
// Unknown costs are a chip beside the dollars, never a $0; a withheld figure is
// the lock, never a zero.

import { useEffect, useState } from 'react';
import {
  Chip,
  DataTable,
  type DataTableColumn,
  Inline,
  PageSection,
  Stack,
  T,
} from '@connorhoehn/ui-components/shared';
import { RecordLink } from '../decisions/RecordLink';
import { LockedFigure } from '../projects/BudgetAccess';
import { usd } from './budgetsFormat';
import { SpendEntriesTable } from './SpendEntriesTable';
import { botHref, groupLabel, moneyOrDash, periodHeading, remainingTone, spendFigure } from './spendReportModel';
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

export function SpendGroupTable({ groups, groupBy, period, lock, query, botId }: {
  groups: SpendGroup[];
  groupBy: SpendGroupBy;
  period: SpendPeriod;
  lock: BudgetAccessLock | undefined;
  query: string;
  botId?: string | null;
}) {
  // The group whose entries are open below the table. Tied to the view, so changing the
  // grouping or the period closes it instead of showing another group's rows under it.
  const [opened, setOpened] = useState<string | null>(null);
  const viewKey = (g: SpendGroup) => `${groupBy}|${period}|${g.key ?? ''}`;
  const q = query.trim().toLowerCase();
  const shown = groups.filter((g) => !q || groupLabel(g, groupBy).toLowerCase().includes(q) || (g.key ?? '').toLowerCase().includes(q));
  const withBudget = groupBy === 'actor';
  const columns: DataTableColumn<SpendGroup>[] = [
    {
      key: 'label',
      header: GROUP_HEADINGS[groupBy],
      render: (g) => {
        const name = <T tone={g.key == null ? 'secondary' : undefined} title={g.key ?? undefined} className="truncate">{groupLabel(g, groupBy)}</T>;
        const href = groupBy === 'bot' ? botHref(g.key) : null;
        return href ? <RecordLink to={href} title="Open this bot">{name}</RecordLink> : name;
      },
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
      // The secondary figures give way as the table narrows (ui-components 2.516.0): Entries, Burn,
      // Held, then Projected; the group, its spend and Budget left never hide.
      priority: 5,
      sortable: true,
      compare: (a, b) => a.entries - b.entries,
      render: (g) => <T tabular>{g.entries}</T>,
    },
    {
      key: 'burn',
      header: 'Burn / day',
      numeric: true,
      priority: 4,
      render: (g) => <Money value={g.burnPerDay7d} lock={lock} />,
    },
    {
      key: 'projected',
      header: 'Projected month-end',
      numeric: true,
      priority: 2,
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
      priority: 3,
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
  const openGroup = groups.find((g) => viewKey(g) === opened);
  // A long list of groups pushes the opened group's entries below the fold: bring them up when a group opens.
  useEffect(() => {
    if (!opened) return;
    const frame = requestAnimationFrame(() => document.querySelector('[data-testid="spend-entries-section"]')?.scrollIntoView({ block: 'start' }));
    return () => cancelAnimationFrame(frame);
  }, [opened]);
  return (
    <Stack gap="lg" className="min-w-0">
      <DataTable
        data-testid="spend-group-table"
        responsiveColumns
        hiddenColumnsControl="header"
        aria-label={`Spend by ${GROUP_HEADINGS[groupBy].toLowerCase()}`}
        data={shown}
        columns={columns}
        keyField={(g) => g.key ?? '__unattributed'}
        selectedKey={openGroup ? openGroup.key ?? '__unattributed' : null}
        onRowClick={(g) => setOpened((cur) => (cur === viewKey(g) ? null : viewKey(g)))}
        emptyMessage={q ? 'Nothing matches this search.' : 'No spend recorded in this window.'}
      />
      {openGroup && (
        <PageSection
          title={`Entries: ${groupLabel(openGroup, groupBy)}`}
          description={`What the ${openGroup.entries} ${openGroup.entries === 1 ? 'entry' : 'entries'} in this group are, newest first.`}
          count={openGroup.entries}
          data-testid="spend-entries-section"
        >
          <SpendEntriesTable groupBy={groupBy} groupKey={openGroup.key} period={period} botId={botId} lock={lock} />
        </PageSection>
      )}
    </Stack>
  );
}

const GROUP_HEADINGS: Readonly<Record<SpendGroupBy, string>> = {
  initiative: 'Initiative',
  actor: 'Person',
  model: 'Model',
  source: 'Source',
  trigger: 'Trigger',
  bot: 'Bot',
};
