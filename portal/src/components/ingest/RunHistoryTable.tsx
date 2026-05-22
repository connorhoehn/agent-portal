import {
  Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip,
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
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {FILTERS.map(f => {
          const active = f.value === filter;
          return (
            <button
              key={f.value}
              onClick={() => onFilter(f.value)}
              style={{
                fontSize: 11,
                padding: '4px 10px',
                background: active ? 'var(--color-primary)' : 'transparent',
                color: active ? '#fff' : 'var(--color-text-secondary)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <Table>
        <TableHead>
          <TableRow>
            <TableTh>Started</TableTh>
            <TableTh>Target</TableTh>
            <TableTh>Mode</TableTh>
            <TableTh>Status</TableTh>
            <TableTh>Duration</TableTh>
            <TableTh style={{ textAlign: 'right' }}>Pages</TableTh>
            <TableTh style={{ textAlign: 'right' }}>Cost</TableTh>
            <TableTh></TableTh>
          </TableRow>
        </TableHead>
        <TableBody>
          {filtered.map(s => {
            const target = s.targetId ? targetsById.get(s.targetId) : null;
            return (
              <TableRow key={s.id}>
                <TableTd
                  style={{
                    fontSize: 11,
                    color: 'var(--color-text-tertiary)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {new Date(s.startedAt).toLocaleString()}
                </TableTd>
                <TableTd>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      maxWidth: 280,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={target?.label ?? s.startUrl}
                  >
                    {target?.label ?? '(ad-hoc)'}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily: 'monospace',
                      color: 'var(--color-text-tertiary)',
                      maxWidth: 280,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={s.startUrl}
                  >
                    {s.startUrl}
                  </div>
                </TableTd>
                <TableTd>
                  <Chip tone="neutral" size="xs">{s.mode}</Chip>
                </TableTd>
                <TableTd>
                  <Chip tone={CRAWL_STATUS_TONE[s.status]} size="xs">{s.status}</Chip>
                </TableTd>
                <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                  {formatDuration(durationOf(s))}
                </TableTd>
                <TableTd style={{ textAlign: 'right', fontSize: 12, fontWeight: 600 }}>
                  {s.pages.length}
                  <span style={{ color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
                    {' / '}{s.maxPages}
                  </span>
                </TableTd>
                <TableTd
                  style={{
                    textAlign: 'right',
                    fontSize: 11,
                    color: 'var(--color-text-secondary)',
                    fontFamily: 'monospace',
                  }}
                >
                  {formatCost(s.estimatedCostUsd)}
                </TableTd>
                <TableTd style={{ textAlign: 'right' }}>
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
