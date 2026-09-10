import {
  Chip,
  FilterChip,
  Inline,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { CRAWL_STATUS_TONE, durationOf, formatCost, formatDuration } from './types';
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

      <Table>
        <TableHead>
          <TableRow>
            <TableTh>Started</TableTh>
            <TableTh>Target</TableTh>
            <TableTh>Mode</TableTh>
            <TableTh>Status</TableTh>
            <TableTh>Duration</TableTh>
            <TableTh className="text-right">Pages</TableTh>
            <TableTh className="text-right">Cost</TableTh>
            <TableTh></TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {filtered.map(s => {
            const target = s.targetId ? targetsById.get(s.targetId) : null;
            return (
              <TableRow key={s.id}>
                <TableTd
                  className="text-[11px] text-text-tertiary whitespace-nowrap"
                >
                  {new Date(s.startedAt).toLocaleString()}
                </TableTd>
                <TableTd>
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
                </TableTd>
                <TableTd>
                  <Chip tone="neutral" size="xs">{s.mode}</Chip>
                </TableTd>
                <TableTd>
                  <Chip tone={CRAWL_STATUS_TONE[s.status]} size="xs">{s.status}</Chip>
                </TableTd>
                <TableTd className="text-[11px] text-text-tertiary">
                  {formatDuration(durationOf(s))}
                </TableTd>
                <TableTd className="text-right text-[12px] font-semibold">
                  {s.pages.length}
                  <Inline as="span" gap="none" className="text-text-tertiary font-normal">
                    {' / '}{s.maxPages}
                  </Inline>
                </TableTd>
                <TableTd
                  className="text-right text-[11px] text-text-secondary font-mono"
                >
                  {formatCost(s.estimatedCostUsd)}
                </TableTd>
                <TableTd className="text-right">
                  <Button variant="secondary" size="sm" onClick={() => onOpen(s.id)}>
                    Open
                  </Button>
                </TableTd>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
