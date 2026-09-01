// The same sprints as the cards, scannable by column.
//
// With the org-wide scope a release manager reads every initiative's sprints at
// once; sorting by spend-vs-envelope or by window is a table job the card grid
// can't do. Row click selects, same as a card — the detail below is shared.

import { Chip, DataTable, Inline } from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { dateRange, isOverEnvelope, STATUS_TONE, usd } from './sprintFormat';
import type { Sprint } from './types';

/** Right-aligned figures are only comparable down a column when the digits
 *  line up, which needs tabular numerals. */
const NUM = 'tabular-nums whitespace-nowrap';

const COLUMNS: DataTableColumn<Sprint>[] = [
  {
    key: 'name', header: 'Sprint', sortable: true,
    render: (s) => (
      <Inline gap="xs" wrap={false}>
        <span className="font-semibold min-w-0 truncate">{s.name}</span>
        <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>
      </Inline>
    ),
  },
  {
    key: 'orgProjectName', header: 'Initiative', sortable: true,
    render: (s) => <span>{s.orgProjectName ?? '—'}</span>,
  },
  {
    key: 'stewardName', header: 'Steward', sortable: true,
    render: (s) => <span>{s.stewardName ?? '—'}</span>,
  },
  {
    key: 'startsOn', header: 'Window', sortable: true,
    compare: (a, b) => String(a.startsOn ?? '').localeCompare(String(b.startsOn ?? '')),
    render: (s) => <span className="whitespace-nowrap">{dateRange(s)}</span>,
  },
  {
    key: 'pointsDone', header: 'Points', align: 'right', sortable: true,
    compare: (a, b) => (a.pointsDone / Math.max(a.pointsTotal, 1)) - (b.pointsDone / Math.max(b.pointsTotal, 1)),
    render: (s) => <span className={NUM}>{s.pointsDone} / {s.pointsTotal}</span>,
  },
  {
    key: 'estimatedCostUsd', header: 'Planned', align: 'right', sortable: true,
    render: (s) => <span className={NUM}>{usd(s.estimatedCostUsd)}</span>,
  },
  {
    key: 'grantedUsd', header: 'Envelope', align: 'right', sortable: true,
    render: (s) => <span className={NUM}>{s.grantCount > 0 ? usd(s.grantedUsd) : '—'}</span>,
  },
  {
    key: 'initiativeSpendInWindowUsd', header: 'Spend in window', align: 'right', sortable: true,
    render: (s) => (
      <span className={isOverEnvelope(s) ? `${NUM} text-danger` : NUM}>
        {usd(s.initiativeSpendInWindowUsd)}
      </span>
    ),
  },
];

export function SprintTable({ sprints, onSelect }: {
  sprints: Sprint[]; onSelect: (id: string) => void;
}) {
  return (
    <DataTable<Sprint>
      data={sprints}
      columns={COLUMNS}
      keyField={(s) => s.id}
      onRowClick={(s) => onSelect(s.id)}
      searchable={sprints.length > 8}
      searchPlaceholder="Filter sprints…"
      pageSize={25}
      emptyMessage="No sprints"
    />
  );
}
