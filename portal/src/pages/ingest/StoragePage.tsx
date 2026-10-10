import {
  T,
  Card, CardHeader, LoadingState, PageSection, StatStrip, Stack, Table, TableBody,
  TableHead, TableRow, TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { formatBytes } from '../../components/ingest/types';
import type { StorageBreakdown } from '../../components/ingest/types';
import { EmptyState } from '../../components/ingest/ui';
import { UnavailableNotice } from '../../components/UnavailableNotice';

function StoragePage() {
  const { data: storage, isLoading, error, degraded, refresh } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);
  const failure = error ?? degraded;

  return (
    <PageSection
      title="Storage"
      description="Where ingested documents land in S3, and how much of it the knowledge base has chunked."
    >
      <Stack gap="md">
        {failure && (
          <UnavailableNotice
            error={failure}
            what="the storage breakdown"
            source="The breakdown is counted live from S3"
            onRetry={refresh}
          />
        )}
        {/* Totals — one line above the breakdowns. "KB documents" is the count
            the vector store holds (not the last run's newly-indexed count), and a
            failed count shows a dash rather than a confident zero. */}
        {!failure && storage && (
          <StatStrip
            aria-label="Storage totals"
            variant="line"
            size="sm"
            items={[
              { label: 'S3 bucket', value: storage.bucket ?? '—' },
              { label: 'objects', value: storage.totalObjects.toLocaleString() },
              { label: 'stored', value: formatBytes(storage.totalBytes) },
              {
                label: 'KB documents',
                value: storage.kb.totalDocuments != null ? storage.kb.totalDocuments.toLocaleString() : '—',
              },
              {
                label: 'last KB ingest',
                value: storage.kb.lastIngestedAt ? new Date(storage.kb.lastIngestedAt).toLocaleString() : '—',
              },
            ]}
          />
        )}
        {/* By extension */}
        <Card padding="md">
          <CardHeader title="By File Type" />
          {failure ? null : !storage && isLoading ? (
            <LoadingState label="Loading file types…" />
          ) : !storage || storage.byType.length === 0 ? (
            <EmptyState title="No S3 objects yet." />
          ) : (
            <Table size="sm">
              <TableHead>
                <TableRow>
                  <TableTh>Extension</TableTh>
                  <TableTh numeric>Count</TableTh>
                  <TableTh numeric>Bytes</TableTh>
                  <TableTh numeric>Share</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {storage.byType.map((row) => (
                  <TableRow key={row.extension}>
                    <TableTd className="font-mono"><T as="span" size="xs">
                      {row.extension || '(none)'}
                    </T></TableTd>
                    <TableTd numeric><T as="span" size="xs">
                      {row.count.toLocaleString()}
                    </T></TableTd>
                    <TableTd numeric><T as="span" size="xs">
                      {formatBytes(row.bytes)}
                    </T></TableTd>
                    <TableTd numeric><T as="span" size="xs" tone="tertiary">
                      {storage.totalBytes > 0
                        ? `${((row.bytes / storage.totalBytes) * 100).toFixed(1)}%`
                        : '—'}
                    </T></TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {/* By prefix */}
        <Card padding="md">
          <CardHeader title="By Prefix" />
          {failure ? null : !storage && isLoading ? (
            <LoadingState label="Loading prefixes…" />
          ) : !storage || storage.byPrefix.length === 0 ? (
            <EmptyState title="No S3 objects yet." />
          ) : (
            <Table size="sm">
              <TableHead>
                <TableRow>
                  <TableTh>Prefix</TableTh>
                  <TableTh numeric>Count</TableTh>
                  <TableTh numeric>Bytes</TableTh>
                  <TableTh numeric>Share</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {storage.byPrefix.map((row) => (
                  <TableRow key={row.prefix}>
                    <TableTd
                      title={row.prefix} className="max-w-[480px] overflow-hidden text-ellipsis whitespace-nowrap font-mono"><T as="span" size="xs" tone="secondary">
                      {row.prefix}
                    </T></TableTd>
                    <TableTd numeric><T as="span" size="xs">
                      {row.count.toLocaleString()}
                    </T></TableTd>
                    <TableTd numeric><T as="span" size="xs">
                      {formatBytes(row.bytes)}
                    </T></TableTd>
                    <TableTd numeric><T as="span" size="xs" tone="tertiary">
                      {storage.totalBytes > 0
                        ? `${((row.bytes / storage.totalBytes) * 100).toFixed(1)}%`
                        : '—'}
                    </T></TableTd>
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
