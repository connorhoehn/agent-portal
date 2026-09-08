// The same sprints as the cards, scannable by column.
//
// With the org-wide scope a release manager reads every initiative's sprints at
// once; sorting by spend-vs-envelope or by window is a table job the card grid
// can't do. Row click selects, same as a card — the detail below is shared.

import { useMemo } from 'react';
import { Button, Chip, DataTable, Inline } from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { dateRange, isOverEnvelope, sprintHealth, STATUS_TONE, usd } from './sprintFormat';
import { T } from './Text';
import type { Sprint } from './types';

/** Health sorts hottest-first: over-envelope, off-track, at-risk, on-track,
 *  then sprints with nothing to judge. */
const HEALTH_RANK: Record<string, number> = {
  over_envelope: 0, off_track: 1, at_risk: 2, on_track: 3,
};
const healthRank = (s: Sprint) => {
  const h = sprintHealth(s);
  return h ? HEALTH_RANK[h.key]! : 4;
};

/** Right-aligned figures are only comparable down a column when the digits
 *  line up, which needs tabular numerals. */
const NUM = 'tabular-nums whitespace-nowrap';

/** Built per-render (not a module-level const) so the name cell's Button can
 *  close over `onSelect` — a real focusable control, not just the row's
 *  onClick: DataTable's row-click is a bare <tr onClick> with no keyboard
 *  access, so this is the one Enter/Space-activatable path into a sprint. */
function columnsFor(onSelect: (id: string) => void): DataTableColumn<Sprint>[] {
  return [
  {
    key: 'name', header: 'Sprint', sortable: true,
    render: (s) => (
      <Inline gap="xs" wrap={false}>
        <Button
          variant="ghost"
          size="sm"
          className="justify-start px-0 py-0 border-0 h-fit min-w-0 truncate font-semibold"
          title={s.name}
          onClick={(e) => { e.stopPropagation(); onSelect(s.id); }}
        >
          {s.name}
        </Button>
        <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="sm">{s.status}</Chip>
      </Inline>
    ),
  },
  {
    key: 'health', header: 'Health', sortable: true,
    compare: (a, b) => healthRank(a) - healthRank(b),
    render: (s) => {
      const h = sprintHealth(s);
      return h
        ? <Chip tone={h.tone} size="sm" dot="static">{h.label}</Chip>
        : <T className="text-text-tertiary">—</T>;
    },
  },
  {
    key: 'orgProjectName', header: 'Initiative', sortable: true,
    render: (s) => <T>{s.orgProjectName ?? '—'}</T>,
  },
  {
    key: 'stewardName', header: 'Steward', sortable: true,
    render: (s) => <T>{s.stewardName ?? '—'}</T>,
  },
  {
    key: 'startsOn', header: 'Window', sortable: true,
    compare: (a, b) => String(a.startsOn ?? '').localeCompare(String(b.startsOn ?? '')),
    render: (s) => <T className="whitespace-nowrap">{dateRange(s)}</T>,
  },
  {
    key: 'pointsDone', header: 'Points', align: 'right', sortable: true,
    compare: (a, b) => (a.pointsDone / Math.max(a.pointsTotal, 1)) - (b.pointsDone / Math.max(b.pointsTotal, 1)),
    render: (s) => <T className={NUM}>{s.pointsDone} / {s.pointsTotal}</T>,
  },
  {
    key: 'estimatedCostUsd', header: 'Planned', align: 'right', sortable: true,
    render: (s) => <T className={NUM}>{usd(s.estimatedCostUsd)}</T>,
  },
  {
    key: 'grantedUsd', header: 'Envelope', align: 'right', sortable: true,
    render: (s) => <T className={NUM}>{s.grantCount > 0 ? usd(s.grantedUsd) : '—'}</T>,
  },
  {
    key: 'initiativeSpendInWindowUsd', header: 'Spend in window', align: 'right', sortable: true,
    render: (s) => (
      <T className={isOverEnvelope(s) ? `${NUM} text-danger` : NUM}>
        {usd(s.initiativeSpendInWindowUsd)}
      </T>
    ),
  },
  ];
}

export function SprintTable({ sprints, onSelect }: {
  sprints: Sprint[]; onSelect: (id: string) => void;
}) {
  const columns = useMemo(() => columnsFor(onSelect), [onSelect]);
  return (
    <DataTable<Sprint>
      data={sprints}
      columns={columns}
      keyField={(s) => s.id}
      onRowClick={(s) => onSelect(s.id)}
      searchable={sprints.length > 8}
      searchPlaceholder="Filter sprints…"
      pageSize={25}
      emptyMessage="No sprints"
    />
  );
}
