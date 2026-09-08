// Bedrock ingestion job history.

import {
  Card,
  CardHeader,
  Chip,
  Inline,
  InlinePlaceholder,
  MetaLine,
  Stack,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch.js';
import { formatDate, jobTone } from './kbFormat';
import type { KbJobsResponse, KbRegistryEntry } from './types';

export function IngestionJobsTab({ kb }: { kb: KbRegistryEntry }) {
  const { data } = useFetch<KbJobsResponse>(
    kb.bedrockKbId ? `/api/admin/kb-registry/${kb.id}/jobs` : null,
  );
  const jobs = data?.jobs ?? [];

  return (
    <Card padding="md">
      <Stack gap="md">
        <CardHeader title="Ingestion jobs" />
        {jobs.length === 0 ? (
          <InlinePlaceholder size="sm">
            {kb.bedrockKbId ? 'No ingestion jobs found.' : 'KB not yet provisioned — no ingestion jobs.'}
          </InlinePlaceholder>
        ) : (
          <Table>
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
                    <Stack gap="xs" align="start">
                      <MetaLine
                        size="sm"
                        items={[
                          <Chip key="s" tone={jobTone(job.status)} size="xs">{job.status}</Chip>,
                          <Inline key="id" as="span" gap="none" className="font-mono">{job.jobId.slice(0, 8)}…</Inline>,
                        ]}
                      />
                      {job.description && (
                        <Inline as="span" gap="none" className="text-[11px] text-text-secondary">{job.description}</Inline>
                      )}
                    </Stack>
                  </TableTd>
                  <TableTd className="whitespace-nowrap tabular-nums text-[11px] text-text-secondary">
                    {job.documentsIndexed} indexed
                    {job.documentsFailed > 0 ? `, ${job.documentsFailed} failed` : ''}
                  </TableTd>
                  <TableTd className="whitespace-nowrap text-[11px] text-text-tertiary">
                    {formatDate(job.startedAt)}
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
