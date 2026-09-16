import {
  Chip,
  DataTable,
  Inline,
} from '@connorhoehnslalom/ui-components/shared';
import type { DataTableColumn } from '@connorhoehnslalom/ui-components/shared';
import { absoluteTime } from '../../lib/relativeTime';
import { CRAWL_STATUS_TONE } from './types';
import type { CrawlTarget } from './types';
import { Button, Toggle } from './ui';

export function TargetsTable({
  targets,
  busyId,
  readOnly = false,
  onRun,
  onEdit,
  onDelete,
  onToggle,
}: {
  targets: CrawlTarget[];
  busyId: string | null;
  /** True when the session lacks ManageIngest — rows render without the
      run/edit/delete/toggle affordances. */
  readOnly?: boolean;
  onRun: (t: CrawlTarget) => void;
  onEdit: (t: CrawlTarget) => void;
  onDelete: (t: CrawlTarget) => void;
  onToggle: (t: CrawlTarget, enabled: boolean) => void;
}) {
  const columns: DataTableColumn<CrawlTarget>[] = [
    {
      key: 'label',
      header: 'Label',
      render: (t) => (
        <>
          <Inline gap="none" className="font-medium">{t.label}</Inline>
          <Inline gap="none" className="text-[10px] font-mono text-text-tertiary">{t.id.slice(0, 12)}…</Inline>
        </>
      ),
    },
    {
      key: 'startUrl',
      header: 'URL',
      className: 'text-[11px] font-mono text-text-secondary max-w-[280px] overflow-hidden truncate whitespace-nowrap',
      render: (t) => <span title={t.startUrl}>{t.startUrl}</span>,
    },
    {
      key: 'mode',
      header: 'Mode',
      render: (t) => <Chip tone="neutral" size="xs">{t.mode}</Chip>,
    },
    {
      key: 'cronExpr',
      header: 'Cron',
      className: 'text-[11px] font-mono text-text-secondary',
      render: (t) => t.cronExpr ?? <Inline as="span" gap="none" className="text-text-tertiary">on-demand</Inline>,
    },
    {
      key: 'lastRunAt',
      header: 'Last Run',
      className: 'text-[11px] text-text-tertiary whitespace-nowrap',
      render: (t) => absoluteTime(t.lastRunAt),
    },
    {
      key: 'lastStatus',
      header: 'Last Status',
      render: (t) => (
        t.lastStatus
          ? <Chip tone={CRAWL_STATUS_TONE[t.lastStatus]} size="xs">{t.lastStatus}</Chip>
          : <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">—</Inline>
      ),
    },
    {
      key: 'maxPages',
      header: 'Max Pages',
      align: 'right',
      className: 'text-[12px] font-semibold',
      render: (t) => t.maxPages,
    },
    {
      key: 'enabled',
      header: 'Enabled',
      render: (t) => (
        readOnly ? (
          <Chip tone={t.enabled ? 'success' : 'neutral'} size="xs">{t.enabled ? 'on' : 'off'}</Chip>
        ) : (
          <Toggle
            checked={t.enabled}
            onChange={v => onToggle(t, v)}
            aria-label={`Enable target ${t.label}`}
          />
        )
      ),
    },
  ];

  return (
    <DataTable
      data={targets}
      columns={columns}
      keyField={(t) => t.id}
      rowActions={readOnly ? undefined : (t) => (
        <Inline gap="none" className="flex gap-1.5 justify-end">
          <Button variant="secondary" size="sm" onClick={() => onRun(t)} disabled={busyId === t.id}>
            {busyId === t.id ? 'Starting…' : 'Run now'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onEdit(t)}>Edit</Button>
          <Button variant="danger" size="sm" onClick={() => onDelete(t)}>Delete</Button>
        </Inline>
      )}
    />
  );
}
