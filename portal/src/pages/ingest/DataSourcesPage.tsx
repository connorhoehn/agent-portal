import React, { Fragment, useEffect, useRef, useState } from 'react';
import {
  Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { EmptyState, PulseDot } from '../../components/ingest/ui';

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
  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

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
      const body = await r.json() as { ok?: boolean; error?: string; job?: { jobId: string; status: string } };
      if (!r.ok || !body.ok) {
        setActionMessage({ tone: 'err', text: body.error ?? 'Sync failed' });
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
    <div style={{ padding: 24 }}>
      {actionMessage && (
        <div style={{
          padding: 10, marginBottom: 12, borderRadius: 4, fontSize: 12,
          background: actionMessage.tone === 'ok' ? '#ecfdf5' : '#fef2f2',
          color: actionMessage.tone === 'ok' ? '#065f46' : '#991b1b',
        }}>
          {actionMessage.text}
        </div>
      )}

      {/* Live KB-sync monitor */}
      {activeJob && (
        <LiveJobMonitor
          baseJob={activeJob}
          liveJob={liveJob}
          streamDone={streamDone}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Data Sources */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Data Sources</h3>
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
                    <div style={{ fontWeight: 500 }}>{ds.name}</div>
                    <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>{ds.id}</div>
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{ds.type}</TableTd>
                  <TableTd style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-secondary)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ds.sourceUri}>
                    {ds.sourceUri || '—'}
                  </TableTd>
                  <TableTd>
                    <Chip tone={ds.status === 'AVAILABLE' ? 'success' : 'warning'} size="xs">{ds.status}</Chip>
                  </TableTd>
                  <TableTd>
                    <button
                      onClick={() => triggerSync(ds.id)}
                      disabled={triggering === ds.id || !!activeJob}
                      style={syncBtnStyle(triggering === ds.id || !!activeJob)}
                    >
                      {triggering === ds.id ? 'Syncing…' : activeJob ? 'In Progress' : 'Sync now'}
                    </button>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {/* KB Job History */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600 }}>
            KB Job History{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>· 10s refresh</span>
          </h3>
          {jobs[0] && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              last: {new Date(jobs[0].startedAt).toLocaleString()}
            </span>
          )}
        </div>
        {jobs.length === 0 ? (
          <EmptyState title="No ingestion jobs yet" />
        ) : (
          <JobHistoryTable jobs={jobs} />
        )}
      </Card>
    </div>
  );
}

function LiveJobMonitor({
  baseJob, liveJob, streamDone, style,
}: {
  baseJob: IngestionJob; liveJob: IngestionJob | null; streamDone: boolean;
  style?: React.CSSProperties;
}) {
  const job = liveJob ?? baseJob;
  const progress = job.documentsScanned > 0
    ? Math.min(100, Math.round((job.documentsIndexed / job.documentsScanned) * 100))
    : 0;
  const tone = streamDone ? '#065f46' : '#92400e';
  const bg  = streamDone ? '#ecfdf5' : '#fffbeb';
  const bar = streamDone ? 'var(--color-success)' : 'var(--color-warning)';

  return (
    <Card padding="md" style={{ ...style, background: bg, borderLeft: `3px solid ${bar}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PulseDot active={!streamDone} color={bar} />
          <span style={{ fontWeight: 600, fontSize: 13, color: tone }}>
            {streamDone ? 'Sync complete' : 'Sync in progress'}
          </span>
          <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
            {job.jobId.slice(0, 12)}…
          </span>
        </div>
        <Chip tone={JOB_STATUS_TONE[job.status] ?? 'neutral'} size="xs">{job.status}</Chip>
      </div>

      {job.documentsScanned > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ height: 5, background: 'rgba(0,0,0,.08)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: bar, transition: 'width 0.5s ease' }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {job.documentsIndexed} / {job.documentsScanned} indexed ({progress}%)
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        <MiniStat label="Scanned"  value={job.documentsScanned} />
        <MiniStat label="Indexed"  value={job.documentsIndexed} />
        <MiniStat label="Failed"   value={job.documentsFailed}  danger={job.documentsFailed > 0} />
        <MiniStat label="Deleted"  value={job.documentsDeleted} />
      </div>
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
          <TableTh style={{ textAlign: 'right' }}>Indexed</TableTh>
          <TableTh style={{ textAlign: 'right' }}>Scanned</TableTh>
          <TableTh style={{ textAlign: 'right' }}>Failed</TableTh>
          <TableTh style={{ textAlign: 'right' }}>Deleted</TableTh>
          <TableTh></TableTh>
        </TableRow>
      </TableHead>
      <TableBody>
        {jobs.map(j => (
          <Fragment key={j.jobId}>
            <TableRow>
              <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                {new Date(j.startedAt).toLocaleString()}
              </TableTd>
              <TableTd style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                {j.jobId.slice(0, 12)}…
              </TableTd>
              <TableTd>
                <Chip tone={JOB_STATUS_TONE[j.status] ?? 'neutral'} size="xs">{j.status}</Chip>
              </TableTd>
              <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                {j.durationMs > 0 ? `${(j.durationMs / 1000).toFixed(1)}s` : '—'}
              </TableTd>
              <TableTd style={{ textAlign: 'right', fontWeight: 600 }}>{j.documentsIndexed}</TableTd>
              <TableTd style={{ textAlign: 'right', fontSize: 12, color: 'var(--color-text-secondary)' }}>{j.documentsScanned}</TableTd>
              <TableTd style={{ textAlign: 'right', fontSize: 12, color: j.documentsFailed > 0 ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>
                {j.documentsFailed}
              </TableTd>
              <TableTd style={{ textAlign: 'right', fontSize: 12, color: 'var(--color-text-secondary)' }}>{j.documentsDeleted}</TableTd>
              <TableTd>
                {j.status === 'FAILED' && (
                  <button
                    onClick={() => loadDetails(j.jobId, j.dataSourceId)}
                    style={{ fontSize: 11, color: 'var(--color-danger)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    {expanded === j.jobId ? 'hide' : 'details'}
                  </button>
                )}
              </TableTd>
            </TableRow>
            {expanded === j.jobId && (
              <TableRow>
                <TableTd colSpan={9} style={{ background: '#fef2f2', padding: '10px 16px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#991b1b', marginBottom: 4 }}>Failure reasons</div>
                  {(details[j.jobId]?.failureReasons ?? j.failureReasons ?? []).length === 0 ? (
                    <div style={{ fontSize: 12, color: '#991b1b' }}>No details returned by Bedrock.</div>
                  ) : (
                    <ul style={{ margin: 0, paddingLeft: 16 }}>
                      {(details[j.jobId]?.failureReasons ?? j.failureReasons).map((r, i) => (
                        <li key={i} style={{ fontSize: 12, color: '#991b1b', marginBottom: 2 }}>{r}</li>
                      ))}
                    </ul>
                  )}
                </TableTd>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

function MiniStat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: danger ? 'var(--color-danger)' : undefined }}>{value}</div>
      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
    </div>
  );
}

function syncBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11, padding: '4px 12px', background: 'var(--color-primary)', color: '#fff',
    border: 'none', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}

export default DataSourcesPage;
