// People report — each person's own monthly agent budget (DE-54), across every
// initiative, against what they spent or hold this month (GET /api/user-budgets).
// Read-only here: setting a person's budget stays where it was (the voice
// navigator and the API), and a person never raises their own.
//
// Each row carries its threshold mark, by the rule the bell announces 50 / 80 /
// 100 % with (learning loop, lane B); a person spending with no budget is a
// blind spot, as on Initiatives.

import {
  Card,
  CardHeader,
  Chip,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Inline,
  T,
} from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { usd } from './budgetsFormat';
import { ThresholdCell } from './ThresholdCell';
import { passesThresholdFilter, type ThresholdFilter } from './thresholdModel';
import type { UserBudgetRow } from './types';

export function matchesPerson(row: Pick<UserBudgetRow, 'displayName' | 'userId'>, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [row.displayName, row.userId].some((v) => (v ?? '').toLowerCase().includes(q));
}

const peopleColumns = (thresholds?: readonly number[]): DataTableColumn<UserBudgetRow>[] => [
  {
    key: 'person',
    header: 'Person',
    render: (u) => (
      <Inline align="center" gap="sm" wrap={false} className="min-w-0">
        <T className="truncate" title={u.note ?? undefined}>{u.displayName ?? u.userId}</T>
        {u.allocatedUsd == null && (
          <Chip tone="warning" size="xs" title="Spending with no budget of their own">blind spot</Chip>
        )}
      </Inline>
    ),
  },
  {
    key: 'budget',
    header: 'Budget',
    numeric: true,
    render: (u) => (u.allocatedUsd == null
      ? <T tone="tertiary" title="No monthly budget">—</T>
      : <T tabular title={u.effectiveHardCapUsd != null ? `Hard cap ${usd(u.effectiveHardCapUsd)}` : undefined}>{usd(u.allocatedUsd)}</T>),
  },
  { key: 'spent', header: 'Spent', numeric: true, sortable: true, compare: (a, b) => a.spentUsd - b.spentUsd, render: (u) => <T tabular>{usd(u.spentUsd)}</T> },
  {
    key: 'held',
    header: 'Held',
    numeric: true,
    priority: 3,
    render: (u) => <T tabular tone={u.heldUsd ? undefined : 'tertiary'} title="Forecast p75 reserved by their runs in flight">{u.heldUsd ? usd(u.heldUsd) : '—'}</T>,
  },
  {
    key: 'left',
    header: 'Left',
    numeric: true,
    render: (u) => (u.remainingUsd == null
      ? <T tone="tertiary">—</T>
      : <T tabular tone={u.remainingUsd <= 0 ? 'danger' : undefined}>{usd(u.remainingUsd)}</T>),
  },
  {
    key: 'threshold',
    header: 'Threshold',
    sortable: true,
    compare: (a, b) => (a.threshold?.percent ?? -1) - (b.threshold?.percent ?? -1),
    render: (u) => <ThresholdCell mark={u.threshold} thresholds={thresholds} what="monthly budget" />,
  },
];

export interface PeopleReportProps {
  people: UserBudgetRow[];
  error: string | null;
  hasData: boolean;
  refresh?: () => void;
  query?: string;
  thresholds?: readonly number[];
  thresholdFilter?: ThresholdFilter;
  /** The person a bell item opened (`?row=`), highlighted. */
  selectedKey?: string | null;
}

export function PeopleReport({
  people, error, hasData, refresh, query = '', thresholds, thresholdFilter = 'all', selectedKey = null,
}: PeopleReportProps) {
  if (error) {
    return <UnavailableNotice error={error} what="people's budgets" source="User budgets are read from Aurora" onRetry={refresh} />;
  }
  if (hasData && people.length === 0) {
    return <EmptyState title="No personal budgets yet" description="Nobody holds a monthly budget of their own, and nobody spent this month without one." />;
  }
  const shown = people.filter((u) => matchesPerson(u, query) && passesThresholdFilter(u.threshold, thresholdFilter, thresholds));
  const withBudget = people.filter((u) => u.allocatedUsd != null).length;
  return (
    <Card padding="none" className="overflow-x-auto">
      <CardHeader
        inset
        title="People"
        subtitle="Each person's own monthly budget, across every initiative, against what they spent or hold this month."
        action={<T size="xs" tone="tertiary" tabular>{people.length} people · {withBudget} with a budget</T>}
      />
      <DataTable
        data-testid="budgets-people-table"
        frameless
        narrow
        responsiveColumns
        data={shown}
        columns={peopleColumns(thresholds)}
        keyField={(u) => u.userId}
        selectedKey={selectedKey}
        emptyMessage={thresholdFilter === 'near' ? 'Nobody is near or at their cap.' : 'No person matches this search.'}
      />
    </Card>
  );
}
