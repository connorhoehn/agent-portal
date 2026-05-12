import {
  Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { CRAWL_STATUS_TONE } from './types';
import type { CrawlTarget } from './types';
import { Toggle, smallBtnStyle, dangerBtnStyle } from './ui';

export function TargetsTable({
  targets,
  busyId,
  onRun,
  onEdit,
  onDelete,
  onToggle,
}: {
  targets: CrawlTarget[];
  busyId: string | null;
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
          <TableTh style={{ textAlign: 'right' }}>Max Pages</TableTh>
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
                <div style={{ fontWeight: 500 }}>{t.label}</div>
                <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>{t.id.slice(0, 12)}…</div>
              </TableTd>
              <TableTd
                style={{
                  fontSize: 11,
                  fontFamily: 'monospace',
                  color: 'var(--color-text-secondary)',
                  maxWidth: 280,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={t.startUrl}
              >
                {t.startUrl}
              </TableTd>
              <TableTd>
                <Chip tone="neutral" size="xs">{t.mode}</Chip>
              </TableTd>
              <TableTd style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-secondary)' }}>
                {t.cronExpr ?? <span style={{ color: 'var(--color-text-tertiary)' }}>on-demand</span>}
              </TableTd>
              <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : '—'}
              </TableTd>
              <TableTd>
                {t.lastStatus
                  ? <Chip tone={CRAWL_STATUS_TONE[t.lastStatus]} size="xs">{t.lastStatus}</Chip>
                  : <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>—</span>}
              </TableTd>
              <TableTd style={{ textAlign: 'right', fontSize: 12, fontWeight: 600 }}>{t.maxPages}</TableTd>
              <TableTd>
                <Toggle enabled={t.enabled} onChange={v => onToggle(t, v)} />
              </TableTd>
              <TableTd>
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button onClick={() => onRun(t)} disabled={isBusy} style={smallBtnStyle(isBusy)}>
                    {isBusy ? 'Starting…' : 'Run now'}
                  </button>
                  <button onClick={() => onEdit(t)} style={smallBtnStyle(false)}>Edit</button>
                  <button onClick={() => onDelete(t)} style={dangerBtnStyle(false)}>Delete</button>
                </div>
              </TableTd>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
