import {
  Card, CardHeader, KPIGrid, PageSection, StatCard, Stack, Table, TableBody,
  TableHead, TableRow, TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { formatBytes } from '../../components/ingest/types';
import type { StorageBreakdown } from '../../components/ingest/types';
import { EmptyState } from '../../components/ingest/ui';

function StoragePage() {
  const { data: storage } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);

  return (
    <PageSection
      title="3 · Storage"
      description="Where ingested documents land in S3, and how much of it the knowledge base has chunked."
    >
      <Stack gap="md">
        {/* Totals row */}
        <KPIGrid columns={3}>
          <StatCard label="S3 Bucket" value={storage?.bucket ?? '—'} mono />
          <StatCard label="Total Objects" value={storage ? storage.totalObjects.toLocaleString() : '—'} />
          <StatCard label="Total Bytes" value={storage ? formatBytes(storage.totalBytes) : '—'} />
        </KPIGrid>

        {/* KB indexed docs */}
        <Card padding="md">
          <CardHeader title="Knowledge Base" />
          {!storage ? (
            <EmptyState title="Loading storage breakdown…" />
          ) : (
            <KPIGrid columns={2}>
              {/* "Indexed" was the wrong noun as well as the wrong number: the
                  value was the last run's newly-indexed count, which is 0 for a
                  current index. It is now what the vector store holds, and a
                  failed count shows a dash rather than a confident zero. */}
              <StatCard
                label="KB Documents"
                value={storage.kb.totalDocuments != null ? storage.kb.totalDocuments.toLocaleString() : '—'}
              />
              <StatCard
                label="Last KB Ingest"
                value={storage.kb.lastIngestedAt ? new Date(storage.kb.lastIngestedAt).toLocaleString() : '—'}
              />
            </KPIGrid>
          )}
        </Card>

        {/* By extension */}
        <Card padding="md">
          <CardHeader title="By File Type" />
          {!storage || storage.byType.length === 0 ? (
            <EmptyState title="No S3 objects yet." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Extension</TableTh>
                  <TableTh className="text-right">Count</TableTh>
                  <TableTh className="text-right">Bytes</TableTh>
                  <TableTh className="text-right">Share</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {storage.byType.map((row) => (
                  <TableRow key={row.extension}>
                    <TableTd className="font-mono text-[12px]">
                      {row.extension || '(none)'}
                    </TableTd>
                    <TableTd className="text-right text-[12px]">
                      {row.count.toLocaleString()}
                    </TableTd>
                    <TableTd className="text-right text-[12px]">
                      {formatBytes(row.bytes)}
                    </TableTd>
                    <TableTd className="text-right text-[11px] text-text-tertiary">
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
        <Card padding="md">
          <CardHeader title="By Prefix" />
          {!storage || storage.byPrefix.length === 0 ? (
            <EmptyState title="No S3 objects yet." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Prefix</TableTh>
                  <TableTh className="text-right">Count</TableTh>
                  <TableTh className="text-right">Bytes</TableTh>
                  <TableTh className="text-right">Share</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {storage.byPrefix.map((row) => (
                  <TableRow key={row.prefix}>
                    <TableTd
                      className="max-w-[480px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-text-secondary"
                      title={row.prefix}
                    >
                      {row.prefix}
                    </TableTd>
                    <TableTd className="text-right text-[12px]">
                      {row.count.toLocaleString()}
                    </TableTd>
                    <TableTd className="text-right text-[12px]">
                      {formatBytes(row.bytes)}
                    </TableTd>
                    <TableTd className="text-right text-[11px] text-text-tertiary">
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
      </Stack>
    </PageSection>
  );
}

export default StoragePage;
