// The same sprints as the cards, scannable by column.
//
// With the org-wide scope a release manager reads every initiative's sprints at
// once; sorting by spend-vs-envelope or by window is a table job the card grid
// can't do. Row click selects, same as a card — the detail below is shared.

import { useMemo } from 'react';
import { ArrowRightIcon, Chip, DataTable, IconButton, T } from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { dateRange, isOverEnvelope, sprintHealth, STATUS_TONE, usd } from './sprintFormat';
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

/** One thing per cell (docs/layout-cascade.md "Tables"): health and status are
 *  columns of their own, the name is plain text, and the keyboard-reachable
 *  way into a sprint is the row's Open action — DataTable's row-click is a
 *  bare <tr onClick>. A table wider than the pane scrolls inside DataTable. */
function columnsFor(): DataTableColumn<Sprint>[] {
  return [
  {
    key: 'name', header: 'Sprint', sortable: true,
    render: (s) => (
      <T weight="medium" className="block max-w-[230px] truncate" title={[s.name, s.orgProjectName, s.stewardName].filter(Boolean).join(' · ')}>
        {s.name}
      </T>
    ),
  },
  {
    key: 'initiative', header: 'Initiative · steward',
    render: (s) => (
      <T size="xs" tone="tertiary" className="block max-w-[170px] truncate">
        {[s.orgProjectName, s.stewardName].filter(Boolean).join(' · ') || '—'}
      </T>
    ),
  },
  {
    key: 'health', header: 'Health', sortable: true,
    compare: (a, b) => healthRank(a) - healthRank(b),
    render: (s) => {
      const h = sprintHealth(s);
      return h
        ? <Chip tone={h.tone} size="xs" dot="static">{h.label}</Chip>
        : <T tone="tertiary">—</T>;
    },
  },
  {
    key: 'status', header: 'Status', sortable: true, width: '110px',
    compare: (a, b) => a.status.localeCompare(b.status),
    render: (s) => <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="xs">{s.status}</Chip>,
  },
  {
    key: 'startsOn', header: 'Window', numeric: true, sortable: true,
    compare: (a, b) => String(a.startsOn ?? '').localeCompare(String(b.startsOn ?? '')),
    render: (s) => <T tabular className="justify-end" title={`${s.pointsDone} / ${s.pointsTotal} pts`}>{dateRange(s)}</T>,
  },
  {
    key: 'points', header: 'Points', numeric: true,
    render: (s) => `${s.pointsDone} / ${s.pointsTotal}`,
  },
  {
    key: 'grantedUsd', header: 'Envelope', numeric: true, sortable: true,
    render: (s) => (
      <T tabular className="justify-end" title={`${usd(s.estimatedCostUsd)} planned`}>
        {s.grantCount > 0 ? usd(s.grantedUsd) : '—'}
      </T>
    ),
  },
  {
    key: 'initiativeSpendInWindowUsd', header: 'Spend in window', numeric: true, sortable: true,
    render: (s) => (
      <T tabular className={isOverEnvelope(s) ? 'justify-end text-danger' : 'justify-end'}>
        {usd(s.initiativeSpendInWindowUsd)}
      </T>
    ),
  },
  ];
}

export function SprintTable({ sprints, onSelect, emptyMessage = 'No sprints' }: {
  sprints: Sprint[]; onSelect: (id: string) => void; emptyMessage?: string;
}) {
  const columns = useMemo(() => columnsFor(), []);
  return (
    <DataTable<Sprint>
      data={sprints}
      columns={columns}
      keyField={(s) => s.id}
      onRowClick={(s) => onSelect(s.id)}
      rowActions={(s) => (
        <IconButton
          size="sm"
          icon={<ArrowRightIcon />}
          aria-label={`Open sprint ${s.name}`}
          title="Open sprint"
          onClick={() => onSelect(s.id)}
        />
      )}
      size="sm"
      pageSize={25}
      emptyMessage={emptyMessage}
    />
  );
}
