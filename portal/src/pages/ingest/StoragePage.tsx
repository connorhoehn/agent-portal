import {
  Card, CardHeader, KPIGrid, LoadingState, PageSection, StatCard, Stack, Table, TableBody,
  TableHead, TableRow, TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { formatBytes } from '../../components/ingest/types';
import type { StorageBreakdown } from '../../components/ingest/types';
import { EmptyState } from '../../components/ingest/ui';

function StoragePage() {
  const { data: storage, isLoading } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);

  return (
    <PageSection
      title="Storage"
      description="Where ingested documents land in S3, and how much of it the knowledge base has chunked."
    >
      <Stack gap="md">
        {/* By extension */}
        <Card padding="md">
          <CardHeader title="By File Type" />
          {!storage && isLoading ? (
            <LoadingState label="Loading file types…" />
          ) : !storage || storage.byType.length === 0 ? (
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
          {!storage && isLoading ? (
            <LoadingState label="Loading prefixes…" />
          ) : !storage || storage.byPrefix.length === 0 ? (
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

        {/* Totals row — kept below the breakdown tables (table-density audit,
            matches KnowledgeHomePage's "right now" strip): Total Objects and
            Total Bytes sum what the two tables above already list per row,
            but S3 Bucket names the bucket itself, which neither table shows. */}
        <KPIGrid columns={3}>
          <StatCard label="S3 Bucket" value={storage?.bucket ?? '—'} mono />
          <StatCard label="Total Objects" value={storage ? storage.totalObjects.toLocaleString() : '—'} />
          <StatCard label="Total Bytes" value={storage ? formatBytes(storage.totalBytes) : '—'} />
        </KPIGrid>

        {/* KB indexed docs — also carries something neither breakdown table
            shows: what the knowledge base itself holds and when it last
            ingested, as opposed to what is sitting in S3. */}
        <Card padding="md">
          <CardHeader title="Knowledge Base" />
          {!storage ? (
            <LoadingState label="Loading storage breakdown…" />
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
      </Stack>
    </PageSection>
  );
}

export default StoragePage;
