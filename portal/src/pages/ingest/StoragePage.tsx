import { useState } from 'react';
import {
  T,
  Card, CardHeader, CollectionToolbar, LoadingState, PageSection, StatStrip, Stack, Table, TableBody,
  TableHead, TableRow, TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { formatBytes } from '../../components/ingest/types';
import type { StorageBreakdown } from '../../components/ingest/types';
import { EmptyState } from '../../components/ingest/ui';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { matchesStorageKey, storageAdapter } from './ingestCommands';

function StoragePage() {
  const { data: storage, isLoading, error, degraded, refresh } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);
  const failure = error ?? degraded;
  const [query, setQuery] = useState('');
  const byType = (storage?.byType ?? []).filter(row => matchesStorageKey(row.extension, query));
  const byPrefix = (storage?.byPrefix ?? []).filter(row => matchesStorageKey(row.prefix, query));
  const adapter = storageAdapter({ setQuery, refresh });

  return (
    <PageSection
      title="Storage"
      description="Where ingested documents land in S3, and how much of it the knowledge base has chunked."
    >
      <Stack gap="md" className="min-w-0">
        <CollectionToolbar label="Storage filters"
          search={{ value: query, onChange: setQuery, placeholder: 'Search file types and prefixes', 'aria-label': 'Search file types and prefixes' }}
          summary={storage ? `${byType.length} of ${storage.byType.length} file types · ${byPrefix.length} of ${storage.byPrefix.length} prefixes` : undefined}
          onRefresh={refresh} refreshing={isLoading} />
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
          ) : byType.length === 0 ? (
            <EmptyState title="No file type matches this search." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Extension</TableTh>
                  <TableTh numeric>Count</TableTh>
                  <TableTh numeric>Bytes</TableTh>
                  <TableTh numeric>Share</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {byType.map((row) => (
                  <TableRow key={row.extension}>
                    <TableTd><T className="font-mono" as="span" size="xs">
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
          ) : byPrefix.length === 0 ? (
            <EmptyState title="No prefix matches this search." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Prefix</TableTh>
                  <TableTh numeric>Count</TableTh>
                  <TableTh numeric>Bytes</TableTh>
                  <TableTh numeric>Share</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {byPrefix.map((row) => (
                  <TableRow key={row.prefix}>
                    <TableTd title={row.prefix} className="max-w-[480px] overflow-hidden text-ellipsis whitespace-nowrap"><T className="font-mono" as="span" size="xs" tone="secondary">
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

        <CollectionCommandHost adapter={adapter} />
      </Stack>
    </PageSection>
  );
}

export default StoragePage;
