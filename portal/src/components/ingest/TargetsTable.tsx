import {
  Chip,
  Inline,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
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
  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableTh>Label</TableTh>
          <TableTh>URL</TableTh>
          <TableTh>Mode</TableTh>
          <TableTh>Cron</TableTh>
          <TableTh>Last Run</TableTh>
          <TableTh>Last Status</TableTh>
          <TableTh className="text-right">Max Pages</TableTh>
          <TableTh>Enabled</TableTh>
          <TableTh></TableTh>
        </TableRow>
      </TableHead>
      <TableBody>
        {targets.map(t => {
          const isBusy = busyId === t.id;
          return (
            <TableRow key={t.id}>
              <TableTd>
                <Inline gap="none" className="font-medium">{t.label}</Inline>
                <Inline gap="none" className="text-[10px] font-mono text-text-tertiary">{t.id.slice(0, 12)}…</Inline>
              </TableTd>
              <TableTd
                className="text-[11px] font-mono text-text-secondary max-w-[280px] overflow-hidden truncate whitespace-nowrap"
                title={t.startUrl}
              >
                {t.startUrl}
              </TableTd>
              <TableTd>
                <Chip tone="neutral" size="xs">{t.mode}</Chip>
              </TableTd>
              <TableTd className="text-[11px] font-mono text-text-secondary">
                {t.cronExpr ?? <Inline as="span" gap="none" className="text-text-tertiary">on-demand</Inline>}
              </TableTd>
              <TableTd className="text-[11px] text-text-tertiary whitespace-nowrap">
                {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : '—'}
              </TableTd>
              <TableTd>
                {t.lastStatus
                  ? <Chip tone={CRAWL_STATUS_TONE[t.lastStatus]} size="xs">{t.lastStatus}</Chip>
                  : <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">—</Inline>}
              </TableTd>
              <TableTd className="text-right text-[12px] font-semibold">{t.maxPages}</TableTd>
              <TableTd>
                {readOnly ? (
                  <Chip tone={t.enabled ? 'success' : 'neutral'} size="xs">{t.enabled ? 'on' : 'off'}</Chip>
                ) : (
                  <Toggle
                    checked={t.enabled}
                    onChange={v => onToggle(t, v)}
                    aria-label={`Enable target ${t.label}`}
                  />
                )}
              </TableTd>
              <TableTd>
                {!readOnly && (
                  <Inline gap="none" className="flex gap-1.5 justify-end">
                    <Button variant="secondary" size="sm" onClick={() => onRun(t)} disabled={isBusy}>
                      {isBusy ? 'Starting…' : 'Run now'}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => onEdit(t)}>Edit</Button>
                    <Button variant="danger" size="sm" onClick={() => onDelete(t)}>Delete</Button>
                  </Inline>
                )}
              </TableTd>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
