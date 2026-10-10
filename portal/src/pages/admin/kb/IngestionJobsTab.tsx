// Bedrock ingestion job history.

import {
  T,
  Card,
  CardHeader,
  Chip,
  Inline,
  InlinePlaceholder,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch.js';
import { UnavailableNotice } from '../../../components/UnavailableNotice';
import { formatDate, jobTone } from './kbFormat';
import type { KbJobsResponse, KbRegistryEntry } from './types';

export function IngestionJobsTab({ kb }: { kb: KbRegistryEntry }) {
  // `ListIngestionJobs` is a live Bedrock call, so AccessDenied and a
  // throttle are both routine here — and both used to render as "No ingestion
  // jobs found.", i.e. as a KB that has never been synced.
  const { data, error, degraded, refresh } = useFetch<KbJobsResponse>(
    kb.bedrockKbId ? `/api/admin/kb-registry/${kb.id}/jobs` : null,
  );
  const jobs = data?.jobs ?? [];
  const failure = error ?? degraded;

  return (
    <Card padding="md">
      <Stack gap="md">
        <CardHeader title="Ingestion jobs" />
        {failure ? (
          <UnavailableNotice
            error={failure}
            what="the ingestion job history"
            source="Jobs are listed live from Bedrock"
            onRetry={refresh}
          />
        ) : jobs.length === 0 ? (
          <InlinePlaceholder size="sm">
            {kb.bedrockKbId ? 'No ingestion jobs found.' : 'KB not yet provisioned — no ingestion jobs.'}
          </InlinePlaceholder>
        ) : (
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableTh>Job</TableTh>
                <TableTh>Result</TableTh>
                <TableTh>Started</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {jobs.map((job) => (
                <TableRow key={job.jobId}>
                  <TableTd>
                    <Inline gap="sm" align="center" wrap={false} title={job.description || undefined}>
                      <Chip tone={jobTone(job.status)} size="xs">{job.status}</Chip>
                      <T as="span" size="xs" tone="secondary" className="font-mono">{job.jobId.slice(0, 8)}…</T>
                      {job.description && (
                        <T as="span" size="xs" tone="secondary" className="truncate max-w-[24rem]">{job.description}</T>
                      )}
                    </Inline>
                  </TableTd>
                  <TableTd className="whitespace-nowrap">
                    <T as="span" size="xs" tone="secondary" tabular>
                      {job.documentsIndexed} indexed
                      {job.documentsFailed > 0 ? `, ${job.documentsFailed} failed` : ''}
                    </T>
                  </TableTd>
                  <TableTd className="whitespace-nowrap">
                    <T as="span" size="xs" tone="tertiary">{formatDate(job.startedAt)}</T>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Stack>
    </Card>
  );
}
