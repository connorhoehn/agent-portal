import {
  T,
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
  emptyMessage,
}: {
  sessions: CrawlSession[];
  targets: CrawlTarget[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  onOpen: (id: string) => void;
  /** Shown when the filters leave no row (the page owns the "nothing yet" state). */
  emptyMessage?: string;
}) {
  const targetsById = new Map(targets.map(t => [t.id, t] as const));
  const filtered = filter === 'all' ? sessions : sessions.filter(s => s.status === filter);

  const columns: DataTableColumn<CrawlSession>[] = [
    {
      key: 'startedAt',
      header: 'Started',
      render: (s) => <T as="span" size="xs" tone="tertiary" className="whitespace-nowrap">{absoluteTime(s.startedAt)}</T>,
    },
    {
      key: 'target',
      header: 'Target',
      render: (s) => {
        const target = s.targetId ? targetsById.get(s.targetId) : null;
        return (
          <Inline gap="sm" align="center" wrap={false}>
            <T as="span" title={target?.label ?? s.startUrl} size="sm" weight="semibold" className="max-w-[200px] truncate whitespace-nowrap">
              {target?.label ?? '(ad-hoc)'}
            </T>
            <T as="span" title={s.startUrl} size="xs" tone="tertiary" className="font-mono max-w-[240px] truncate whitespace-nowrap">
              {s.startUrl}
            </T>
          </Inline>
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
      render: (s) => <T as="span" size="xs" tone="tertiary" className="whitespace-nowrap">{durationLabel(durationOf(s))}</T>,
    },
    {
      key: 'pages',
      header: 'Pages',
      numeric: true,
      render: (s) => (
        <Inline gap="none" justify="end" wrap={false}>
          <T as="span" size="sm" weight="semibold" tabular>{s.pages.length}</T>
          <T as="span" size="sm" tone="tertiary" tabular>{' / '}{s.maxPages}</T>
        </Inline>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      numeric: true,
      render: (s) => <T as="span" size="xs" tone="secondary" tabular className="font-mono">{formatCost(s.estimatedCostUsd)}</T>,
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
        {...(emptyMessage ? { emptyMessage } : {})}
        rowActions={(s) => (
          <Button variant="secondary" size="sm" onClick={() => onOpen(s.id)}>
            Open
          </Button>
        )}
      />
    </>
  );
}
