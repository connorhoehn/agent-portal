import {
  T,
  Chip,
  DataTable,
  Inline,
} from '@connorhoehn/ui-components/shared';
import type { DataTableColumn } from '@connorhoehn/ui-components/shared';
import { absoluteTime } from '../../lib/relativeTime';
import { CRAWL_STATUS_TONE } from './types';
import type { CrawlTarget } from './types';
import { Toggle } from './ui';

export function TargetsTable({
  targets,
  readOnly = false,
  onOpen,
  onToggle,
}: {
  targets: CrawlTarget[];
  /** True when the session lacks ManageIngest — the Enabled column is a
      read-only chip instead of a switch. */
  readOnly?: boolean;
  /** A row opens the target as a page (`/admin/ingest/crawl/:targetId`), where
      Run now, the edit form and Delete live. */
  onOpen: (t: CrawlTarget) => void;
  onToggle: (t: CrawlTarget, enabled: boolean) => void;
}) {
  const columns: DataTableColumn<CrawlTarget>[] = [
    {
      key: 'label',
      header: 'Label',
      render: (t) => (
        <Inline gap="sm" align="center" wrap={false}>
          <T as="span" size="sm" weight="semibold">{t.label}</T>
          <T as="span" size="xs" tone="tertiary" className="font-mono" title={t.id}>{t.id.slice(0, 12)}…</T>
        </Inline>
      ),
    },
    {
      key: 'startUrl',
      header: 'URL',
      render: (t) => (
        <T as="span" size="xs" tone="secondary" className="font-mono max-w-[280px] truncate whitespace-nowrap" title={t.startUrl}>{t.startUrl}</T>
      ),
    },
    {
      key: 'mode',
      header: 'Mode',
      render: (t) => <Chip tone="neutral" size="xs">{t.mode}</Chip>,
    },
    {
      key: 'cronExpr',
      header: 'Cron',
      render: (t) => t.cronExpr
        ? <T as="span" size="xs" tone="secondary" className="font-mono whitespace-nowrap">{t.cronExpr}</T>
        : <T as="span" size="xs" tone="tertiary">on-demand</T>,
    },
    {
      key: 'lastRunAt',
      header: 'Last Run',
      render: (t) => <T as="span" size="xs" tone="tertiary" className="whitespace-nowrap">{absoluteTime(t.lastRunAt)}</T>,
    },
    {
      key: 'lastStatus',
      header: 'Last Status',
      render: (t) => (
        t.lastStatus
          ? <Chip tone={CRAWL_STATUS_TONE[t.lastStatus]} size="xs">{t.lastStatus}</Chip>
          : <T as="span" size="xs" tone="tertiary">—</T>
      ),
    },
    {
      key: 'maxPages',
      header: 'Max Pages',
      numeric: true,
      render: (t) => <T as="span" size="sm" weight="semibold" tabular>{t.maxPages}</T>,
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
      // The Enabled switch is interactive, so a click on it toggles without opening the row.
      onRowClick={onOpen}
      data-testid="ingest-targets-table"
    />
  );
}
