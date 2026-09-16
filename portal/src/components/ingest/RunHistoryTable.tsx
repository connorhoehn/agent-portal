import {
  Chip,
  DataTable,
  FilterChip,
  Inline,
} from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { absoluteTime, durationLabel } from '../../lib/relativeTime';
import { CRAWL_STATUS_TONE, durationOf, formatCost } from './types';
import type { CrawlSession, CrawlStatus, CrawlTarget } from './types';
import { Button } from './ui';

type Filter = 'all' | CrawlStatus;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export function RunHistoryTable({
  sessions,
  targets,
  filter,
  onFilter,
  onOpen,
}: {
  sessions: CrawlSession[];
  targets: CrawlTarget[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  onOpen: (id: string) => void;
}) {
  const targetsById = new Map(targets.map(t => [t.id, t] as const));
  const filtered = filter === 'all' ? sessions : sessions.filter(s => s.status === filter);

  const columns: DataTableColumn<CrawlSession>[] = [
    {
      key: 'startedAt',
      header: 'Started',
      className: 'text-[11px] text-text-tertiary whitespace-nowrap',
      render: (s) => absoluteTime(s.startedAt),
    },
    {
      key: 'target',
      header: 'Target',
      render: (s) => {
        const target = s.targetId ? targetsById.get(s.targetId) : null;
        return (
          <>
            <Inline gap="none"
              className="text-[12px] font-medium max-w-[280px] overflow-hidden truncate whitespace-nowrap"
              title={target?.label ?? s.startUrl}
            >
              {target?.label ?? '(ad-hoc)'}
            </Inline>
            <Inline gap="none"
              className="text-[10px] font-mono text-text-tertiary max-w-[280px] overflow-hidden truncate whitespace-nowrap"
              title={s.startUrl}
            >
              {s.startUrl}
            </Inline>
          </>
        );
      },
    },
    {
      key: 'mode',
      header: 'Mode',
      render: (s) => <Chip tone="neutral" size="xs">{s.mode}</Chip>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (s) => <Chip tone={CRAWL_STATUS_TONE[s.status]} size="xs">{s.status}</Chip>,
    },
    {
      key: 'duration',
      header: 'Duration',
      className: 'text-[11px] text-text-tertiary',
      render: (s) => durationLabel(durationOf(s)),
    },
    {
      key: 'pages',
      header: 'Pages',
      align: 'right',
      className: 'text-[12px] font-semibold',
      render: (s) => (
        <>
          {s.pages.length}
          <Inline as="span" gap="none" className="text-text-tertiary font-normal">
            {' / '}{s.maxPages}
          </Inline>
        </>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      className: 'text-[11px] text-text-secondary font-mono',
      render: (s) => formatCost(s.estimatedCostUsd),
    },
  ];

  return (
    <>
      <Inline gap="none" className="flex gap-1.5 mb-3 flex-wrap">
        {FILTERS.map(f => {
          const active = f.value === filter;
          // One-of-many status filter — FilterChip is exactly that shape, and
          // it owns the active treatment these two ternaries were hand-rolling.
          return (
            <FilterChip
              key={f.value}
              active={active}
              size="sm"
              onClick={() => onFilter(f.value)}
            >
              {f.label}
            </FilterChip>
          );
        })}
      </Inline>

      <DataTable
        data={filtered}
        columns={columns}
        keyField={(s) => s.id}
        rowActions={(s) => (
          <Button variant="secondary" size="sm" onClick={() => onOpen(s.id)}>
            Open
          </Button>
        )}
      />
    </>
  );
}
