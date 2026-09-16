import { Fragment, useEffect, useRef, useState } from 'react';
import {
  Button, Card, CardHeader, Chip, Inline, InlineAlert, InlinePlaceholder, PageSection,
  ProgressBar, Stack, StatStrip, Table, TableBody, TableHead, TableRow,
  TableTd, TableTh,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { EmptyState, StatusDot } from '../../components/ingest/ui';
import { T } from './Text';

interface DataSource {
  id: string; name: string; status: string; description: string;
  type: string; sourceUri: string; updatedAt: string;
}

interface IngestionJob {
  jobId: string; dataSourceId: string; status: string;
  startedAt: string; updatedAt: string; description: string; durationMs: number;
  documentsScanned: number; documentsIndexed: number;
  documentsFailed: number; documentsDeleted: number;
  failureReasons: string[];
}

const JOB_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  COMPLETE: 'success', IN_PROGRESS: 'warning', STARTING: 'warning', FAILED: 'danger', STOPPED: 'neutral',
};

const ACTIVE_STATUSES = new Set(['IN_PROGRESS', 'STARTING']);

function useIngestionStream(
  jobId: string | null,
  dataSourceId: string | null,
  onDone?: () => void,
): { liveJob: IngestionJob | null; streamDone: boolean } {
  const [liveJob, setLiveJob] = useState<IngestionJob | null>(null);
  const [streamDone, setStreamDone] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!jobId || !dataSourceId) { setLiveJob(null); setStreamDone(false); return; }
    setStreamDone(false);
    const es = new EventSource(
      `/api/ingest/stream?jobId=${encodeURIComponent(jobId)}&dataSourceId=${encodeURIComponent(dataSourceId)}`,
    );
    es.onmessage = (evt: MessageEvent) => {
      const msg = JSON.parse(evt.data) as { type: string; job?: IngestionJob };
      if (msg.type === 'update' && msg.job) setLiveJob(msg.job);
      if (msg.type === 'done') {
        if (msg.job) setLiveJob(msg.job);
        setStreamDone(true);
        es.close();
        onDoneRef.current?.();
      }
    };
    es.onerror = () => { setStreamDone(true); es.close(); };
    return () => es.close();
  }, [jobId, dataSourceId]);

  return { liveJob, streamDone };
}

function DataSourcesPage() {
  // Starting a KB sync POSTs /api/ingest/start (ManageIngest).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageIngest');
  const { data: sourcesData, refresh: refreshSources } = useFetch<{ sources: DataSource[] }>(
    '/api/ingest/data-sources',
    30_000,
  );
  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: IngestionJob[] }>(
    '/api/ingest/jobs?limit=20',
    10_000,
  );

  const sources = sourcesData?.sources ?? [];
  const jobs = jobsData?.jobs ?? [];

  const [triggering, setTriggering] = useState<string | null>(null);
  // `busy` is a third outcome, not a shade of `err`. The server answers 409
  // with `conflict: true` when Bedrock refuses because a sync is ALREADY
  // running on that data source — the thing the operator asked for is happening,
  // so painting it red says the pipeline broke when nothing did.
  const [actionMessage, setActionMessage] = useState<
    { tone: 'ok' | 'err' | 'busy'; text: string } | null
  >(null);

  const activeJob = jobs.find(j => ACTIVE_STATUSES.has(j.status)) ?? null;

  const { liveJob, streamDone } = useIngestionStream(
    activeJob?.jobId ?? null,
    activeJob?.dataSourceId ?? null,
    () => { refreshJobs(); },
  );

  async function triggerSync(dataSourceId: string) {
    setTriggering(dataSourceId);
    setActionMessage(null);
    try {
      const r = await fetch('/api/ingest/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId }),
      });
      const body = await r.json() as {
        ok?: boolean; error?: string; conflict?: boolean;
        job?: { jobId: string; status: string };
      };
      if (!r.ok || !body.ok) {
        setActionMessage({
          tone: body.conflict ? 'busy' : 'err',
          text: body.error ?? 'Sync failed',
        });
        // A conflict means a job IS running — showing it is the useful response.
        if (body.conflict) refreshJobs();
      } else {
        setActionMessage({ tone: 'ok', text: `Job ${body.job?.jobId.slice(0, 12) ?? 'unknown'}… started` });
        refreshJobs();
      }
    } catch (e) {
      setActionMessage({ tone: 'err', text: (e as Error).message });
    } finally {
      setTriggering(null);
      refreshSources();
    }
  }

  return (
    <PageSection
      title="KB sync"
      description="The data sources that carry storage into the knowledge base, and the jobs that ran."
    >
      <Stack gap="md">
        {actionMessage && (
          <InlineAlert
            tone={
              actionMessage.tone === 'ok' ? 'success'
                : actionMessage.tone === 'busy' ? 'info'
                  : 'error'
            }
          >
            {actionMessage.text}
          </InlineAlert>
        )}

        {/* Live KB-sync monitor */}
        {activeJob && (
          <LiveJobMonitor baseJob={activeJob} liveJob={liveJob} streamDone={streamDone} />
        )}

        {/* Data Sources */}
        <Card padding="md">
          <CardHeader title="Data Sources" />
          {sources.length === 0 ? (
            <EmptyState title="No data sources" body="No data sources attached to this Knowledge Base." />
          ) : (
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Name</TableTh><TableTh>Type</TableTh>
                  <TableTh>Source URI</TableTh><TableTh>Status</TableTh><TableTh></TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {sources.map(ds => (
                  <TableRow key={ds.id}>
                    <TableTd>
                      <T className="block font-medium">{ds.name}</T>
                      <T className="block font-mono text-[10px] text-text-tertiary">{ds.id}</T>
                    </TableTd>
                    <TableTd className="text-[11px] text-text-secondary">{ds.type}</TableTd>
                    <TableTd
                      className="max-w-[320px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-text-secondary"
                      title={ds.sourceUri}
                    >
                      {ds.sourceUri || '—'}
                    </TableTd>
                    <TableTd>
                      <Chip tone={ds.status === 'AVAILABLE' ? 'success' : 'warning'} size="xs">{ds.status}</Chip>
                    </TableTd>
                    <TableTd>
                      {canManage && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => triggerSync(ds.id)}
                          disabled={triggering === ds.id || !!activeJob}
                        >
                          {triggering === ds.id ? 'Syncing…' : activeJob ? 'In Progress' : 'Sync now'}
                        </Button>
                      )}
                    </TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {/* KB Job History */}
        <Card padding="md">
          <CardHeader
            title="KB Job History"
            subtitle="10s refresh"
            action={jobs[0]
              ? <T className="text-[11px] text-text-tertiary">last: {new Date(jobs[0].startedAt).toLocaleString()}</T>
              : undefined}
          />
          {jobs.length === 0 ? (
            <EmptyState title="No ingestion jobs yet" />
          ) : (
            <JobHistoryTable jobs={jobs} />
          )}
        </Card>
      </Stack>
    </PageSection>
  );
}

function LiveJobMonitor({
  baseJob, liveJob, streamDone,
}: {
  baseJob: IngestionJob; liveJob: IngestionJob | null; streamDone: boolean;
}) {
  const job = liveJob ?? baseJob;
  const barColor = streamDone ? 'var(--color-success)' : 'var(--color-warning)';

  return (
    <Card padding="md" className={streamDone ? 'border-l-[3px] border-l-success bg-success-bg' : 'border-l-[3px] border-l-warning bg-warning-bg'}>
      <Stack gap="sm">
        <CardHeader
          inset
          title={streamDone ? 'Sync complete' : 'Sync in progress'}
          meta={(
            <Inline gap="sm" align="center">
              <StatusDot pulse={!streamDone} color={barColor} />
              <T className="font-mono text-[11px] text-text-tertiary">{job.jobId.slice(0, 12)}…</T>
            </Inline>
          )}
          action={<Chip tone={JOB_STATUS_TONE[job.status] ?? 'neutral'} size="xs">{job.status}</Chip>}
        />

        {job.documentsScanned > 0 && (
          <ProgressBar
            value={job.documentsIndexed}
            max={job.documentsScanned}
            color={barColor}
            label={`${job.documentsIndexed} / ${job.documentsScanned} indexed`}
          />
        )}

        <StatStrip
          frameless
          aria-label="Job document counts"
          items={[
            { label: 'Scanned', value: job.documentsScanned },
            { label: 'Indexed', value: job.documentsIndexed },
            { label: 'Failed', value: job.documentsFailed, ...(job.documentsFailed > 0 ? { tone: 'danger' as const } : {}) },
            { label: 'Deleted', value: job.documentsDeleted },
          ]}
        />
      </Stack>
    </Card>
  );
}

function JobHistoryTable({ jobs }: { jobs: IngestionJob[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, IngestionJob>>({});

  async function loadDetails(jobId: string, dataSourceId: string) {
    if (details[jobId]) { setExpanded(e => e === jobId ? null : jobId); return; }
    try {
      const r = await fetch(`/api/ingest/job/${encodeURIComponent(jobId)}?dataSourceId=${encodeURIComponent(dataSourceId)}`);
      const body = await r.json() as { job?: IngestionJob };
      if (body.job) setDetails(d => ({ ...d, [jobId]: body.job! }));
    } catch { /* ignore */ }
    setExpanded(e => e === jobId ? null : jobId);
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableTh>Started</TableTh><TableTh>Job</TableTh><TableTh>Status</TableTh>
          <TableTh>Duration</TableTh>
          <TableTh className="text-right">Indexed</TableTh>
          <TableTh className="text-right">Scanned</TableTh>
          <TableTh className="text-right">Failed</TableTh>
          <TableTh className="text-right">Deleted</TableTh>
          <TableTh></TableTh>
        </TableRow>
      </TableHead>
      <TableBody>
        {jobs.map(j => (
          <Fragment key={j.jobId}>
            <TableRow>
              <TableTd className="whitespace-nowrap text-[11px] text-text-tertiary">
                {new Date(j.startedAt).toLocaleString()}
              </TableTd>
              <TableTd className="font-mono text-[10px] text-text-tertiary">
                {j.jobId.slice(0, 12)}…
              </TableTd>
              <TableTd>
                <Chip tone={JOB_STATUS_TONE[j.status] ?? 'neutral'} size="xs">{j.status}</Chip>
              </TableTd>
              <TableTd className="text-[11px] text-text-tertiary">
                {j.durationMs > 0 ? `${(j.durationMs / 1000).toFixed(1)}s` : '—'}
              </TableTd>
              <TableTd className="text-right font-semibold">{j.documentsIndexed}</TableTd>
              <TableTd className="text-right text-[12px] text-text-secondary">{j.documentsScanned}</TableTd>
              <TableTd className={`text-right text-[12px] ${j.documentsFailed > 0 ? 'text-danger' : 'text-text-secondary'}`}>
                {j.documentsFailed}
              </TableTd>
              <TableTd className="text-right text-[12px] text-text-secondary">{j.documentsDeleted}</TableTd>
              <TableTd>
                {j.status === 'FAILED' && (
                  <Button variant="ghost" size="sm" onClick={() => loadDetails(j.jobId, j.dataSourceId)}>
                    {expanded === j.jobId ? 'hide' : 'details'}
                  </Button>
                )}
              </TableTd>
            </TableRow>
            {expanded === j.jobId && (
              <TableRow>
                <TableTd colSpan={9} className="bg-danger-bg px-4 py-2.5">
                  <Stack gap="xs">
                    <T className="text-[12px] font-semibold text-danger">Failure reasons</T>
                    {(details[j.jobId]?.failureReasons ?? j.failureReasons ?? []).length === 0 ? (
                      <InlinePlaceholder tone="surface" className="text-danger">No details returned by Bedrock.</InlinePlaceholder>
                    ) : (
                      (details[j.jobId]?.failureReasons ?? j.failureReasons).map((r, i) => (
                        <T key={i} className="text-[12px] text-danger">· {r}</T>
                      ))
                    )}
                  </Stack>
                </TableTd>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

export default DataSourcesPage;
