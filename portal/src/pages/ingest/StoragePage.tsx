import {
  Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { formatBytes } from '../../components/ingest/types';
import type { StorageBreakdown } from '../../components/ingest/types';
import { EmptyState } from '../../components/ingest/ui';

function StoragePage() {
  const { data: storage } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);

  return (
    <div style={{ padding: 24 }}>
      {/* Totals row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
        <TotalCard
          label="S3 Bucket"
          value={storage?.bucket ?? '—'}
          mono
        />
        <TotalCard
          label="Total Objects"
          value={storage ? storage.totalObjects.toLocaleString() : '—'}
        />
        <TotalCard
          label="Total Bytes"
          value={storage ? formatBytes(storage.totalBytes) : '—'}
        />
      </div>

      {/* KB indexed docs */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Knowledge Base</h3>
        {!storage ? (
          <EmptyState title="Loading storage breakdown…" />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            <KVStat
              label="KB Documents Indexed"
              value={storage.kb.totalDocuments.toLocaleString()}
            />
            <KVStat
              label="Last KB Ingest"
              value={storage.kb.lastIngestedAt ? new Date(storage.kb.lastIngestedAt).toLocaleString() : '—'}
            />
          </div>
        )}
      </Card>

      {/* By extension */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>By File Type</h3>
        {!storage || storage.byType.length === 0 ? (
          <EmptyState title="No S3 objects yet." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Extension</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Count</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Bytes</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Share</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {storage.byType.map((row) => (
                <TableRow key={row.extension}>
                  <TableTd style={{ fontFamily: 'monospace', fontSize: 12 }}>
                    {row.extension || '(none)'}
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', fontSize: 12 }}>
                    {row.count.toLocaleString()}
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', fontSize: 12 }}>
                    {formatBytes(row.bytes)}
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {storage.totalBytes > 0
                      ? `${((row.bytes / storage.totalBytes) * 100).toFixed(1)}%`
                      : '—'}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* By prefix */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>By Prefix</h3>
        {!storage || storage.byPrefix.length === 0 ? (
          <EmptyState title="No S3 objects yet." />
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Prefix</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Count</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Bytes</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Share</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {storage.byPrefix.map((row) => (
                <TableRow key={row.prefix}>
                  <TableTd
                    style={{
                      fontFamily: 'monospace',
                      fontSize: 11,
                      color: 'var(--color-text-secondary)',
                      maxWidth: 480,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={row.prefix}
                  >
                    {row.prefix}
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', fontSize: 12 }}>
                    {row.count.toLocaleString()}
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', fontSize: 12 }}>
                    {formatBytes(row.bytes)}
                  </TableTd>
                  <TableTd style={{ textAlign: 'right', fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                    {storage.totalBytes > 0
                      ? `${((row.bytes / storage.totalBytes) * 100).toFixed(1)}%`
                      : '—'}
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function TotalCard({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          marginTop: 4,
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </div>
    </Card>
  );
}

function KVStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default StoragePage;
