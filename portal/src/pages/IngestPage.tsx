import React, { useState, useEffect, useRef, Fragment } from 'react';
import {
  Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface KbSummary {
  id: string; name: string; status: string; description: string;
  embeddingModel: string; embeddingModelArn: string; vectorStore: string; updatedAt: string;
}

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

interface S3Queue {
  total: number; pendingSinceLastSync: number; lastModified: string | null; bucket: string;
}

interface IngestSchedule {
  id: string; dataSourceId: string; dataSourceName: string;
  cronExpr: string; label: string; enabled: boolean;
  createdAt: string; lastRunAt: string | null; lastJobId: string | null; lastStatus: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JOB_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  COMPLETE: 'success', IN_PROGRESS: 'warning', STARTING: 'warning', FAILED: 'danger', STOPPED: 'default',
};

const ACTIVE_STATUSES = new Set(['IN_PROGRESS', 'STARTING']);

const CRON_PRESETS = [
  { label: 'Every hour',       expr: '0 * * * *'   },
  { label: 'Every 6 hours',    expr: '0 */6 * * *'  },
  { label: 'Daily midnight',   expr: '0 0 * * *'    },
  { label: 'Daily 9 AM UTC',   expr: '0 9 * * *'    },
  { label: 'Weekly Mon 9 AM',  expr: '0 9 * * 1'    },
  { label: 'Custom…',          expr: '__custom__'   },
];

// ─── SSE hook ─────────────────────────────────────────────────────────────────

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

// ─── Page ─────────────────────────────────────────────────────────────────────

function IngestPage() {
  const { data: kbData } = useFetch<{ kb: KbSummary | null }>('/api/ingest/kb', 60_000);
  const { data: sourcesData, refresh: refreshSources } = useFetch<{ sources: DataSource[] }>('/api/ingest/data-sources', 30_000);
  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: IngestionJob[] }>('/api/ingest/jobs?limit=20', 10_000);
  const { data: queueData } = useFetch<S3Queue>('/api/ingest/queue', 60_000);

  const [triggering, setTriggering] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const kb = kbData?.kb ?? null;
  const sources = sourcesData?.sources ?? [];
  const jobs = jobsData?.jobs ?? [];

  const activeJob = jobs.find(j => ACTIVE_STATUSES.has(j.status)) ?? null;
  const lastCompleteJob = jobs.find(j => j.status === 'COMPLETE') ?? null;

  const { liveJob, streamDone } = useIngestionStream(
    activeJob?.jobId ?? null,
    activeJob?.dataSourceId ?? null,
    () => { refreshJobs(); },
  );

  const totalIndexed = jobs.reduce((s, j) => s + j.documentsIndexed, 0);

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
        setActionMessage({ tone: 'ok', text: `Job ${body.job!.jobId.slice(0, 12)}… started` });
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
    <PageSection title="Knowledge Base Ingest">

      {/* KB info */}
      {!kb ? (
        <Card padding="md" style={{ marginBottom: 16 }}>
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            No Knowledge Base configured. Set <code>KB_ID</code> in <code>middleware/.env.aws</code>.
          </div>
        </Card>
      ) : (
        <Card padding="md" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>{kb.name}</h2>
              <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                {kb.description || 'Bedrock Knowledge Base for org documents'}
              </div>
            </div>
            <Chip tone={kb.status === 'ACTIVE' ? 'success' : 'warning'} size="xs">{kb.status}</Chip>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginTop: 16 }}>
            <KVStat label="KB ID"            value={kb.id}           mono />
            <KVStat label="Embedding Model"  value={kb.embeddingModel || '—'} mono />
            <KVStat label="Vector Store"     value={kb.vectorStore || '—'} />
            <KVStat label="Updated"          value={new Date(kb.updatedAt).toLocaleString()} />
          </div>
        </Card>
      )}

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
        <StatCard label="Data Sources"       value={String(sources.length)} />
        <StatCard label="Recent Jobs"        value={String(jobs.length)} />
        <StatCard label="Docs Indexed (recent)" value={String(totalIndexed)} accent />
        <QueueCard queue={queueData} lastCompleteJob={lastCompleteJob} />
      </div>

      {/* Action banner */}
      {actionMessage && (
        <div style={{
          padding: 10, marginBottom: 12, borderRadius: 4, fontSize: 12,
          background: actionMessage.tone === 'ok' ? '#ecfdf5' : '#fef2f2',
          color: actionMessage.tone === 'ok' ? '#065f46' : '#991b1b',
        }}>
          {actionMessage.text}
        </div>
      )}

      {/* Live monitor — visible only while a job is active or just finished */}
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
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Data Sources</h2>
        {sources.length === 0 ? (
          <EmptyState>No data sources attached to this Knowledge Base.</EmptyState>
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

      {/* Job History */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Job History{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>· 10s refresh</span>
          </h2>
          {jobs[0] && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              last: {new Date(jobs[0].startedAt).toLocaleString()}
            </span>
          )}
        </div>
        {jobs.length === 0 ? (
          <EmptyState>No ingestion jobs yet. Click "Sync now" on a data source.</EmptyState>
        ) : (
          <JobHistoryTable jobs={jobs} />
        )}
      </Card>

      {/* Schedules */}
      <SchedulesPanel sources={sources} />

    </PageSection>
  );
}

// ─── Live Job Monitor ─────────────────────────────────────────────────────────

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
        <Chip tone={JOB_STATUS_TONE[job.status] ?? 'default'} size="xs">{job.status}</Chip>
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

// ─── Queue Card ───────────────────────────────────────────────────────────────

function QueueCard({ queue, lastCompleteJob }: { queue: S3Queue | null; lastCompleteJob: IngestionJob | null }) {
  const pending = queue?.pendingSinceLastSync ?? 0;
  const tone = pending === 0 ? 'success' : 'warning';
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>S3 Queue</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>
        {queue ? queue.total : '—'}
      </div>
      {queue && (
        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Chip tone={tone} size="xs">
            {pending === 0 ? 'In sync' : `${pending} pending`}
          </Chip>
        </div>
      )}
      {lastCompleteJob && (
        <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
          last sync {new Date(lastCompleteJob.updatedAt).toLocaleString()}
        </div>
      )}
    </Card>
  );
}

// ─── Job History Table ────────────────────────────────────────────────────────

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
                <Chip tone={JOB_STATUS_TONE[j.status] ?? 'default'} size="xs">{j.status}</Chip>
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

// ─── Schedules Panel ──────────────────────────────────────────────────────────

function SchedulesPanel({ sources }: { sources: DataSource[] }) {
  const { data, refresh } = useFetch<{ schedules: IngestSchedule[] }>('/api/ingest/schedules', 30_000);
  const schedules = data?.schedules ?? [];
  const [showForm, setShowForm] = useState(false);

  async function onDelete(id: string) {
    await fetch(`/api/ingest/schedules/${id}`, { method: 'DELETE' });
    refresh();
  }

  async function onToggle(id: string, enabled: boolean) {
    await fetch(`/api/ingest/schedules/${id}/toggle`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  return (
    <Card padding="md">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600 }}>Schedules</h2>
        <button onClick={() => setShowForm(v => !v)} style={secondaryBtnStyle}>
          {showForm ? 'Cancel' : '+ New Schedule'}
        </button>
      </div>

      {showForm && (
        <ScheduleForm
          sources={sources}
          onCreated={() => { setShowForm(false); refresh(); }}
        />
      )}

      {schedules.length === 0 && !showForm ? (
        <EmptyState>
          No schedules configured. Ingestion runs only on manual "Sync now" trigger.
        </EmptyState>
      ) : schedules.length > 0 ? (
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Label</TableTh><TableTh>Cron</TableTh><TableTh>Data Source</TableTh>
              <TableTh>Last Run</TableTh><TableTh>Last Status</TableTh>
              <TableTh>Enabled</TableTh><TableTh></TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {schedules.map(s => (
              <TableRow key={s.id}>
                <TableTd style={{ fontWeight: 500 }}>{s.label}</TableTd>
                <TableTd style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-secondary)' }}>{s.cronExpr}</TableTd>
                <TableTd style={{ fontSize: 12 }}>{s.dataSourceName}</TableTd>
                <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                  {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : '—'}
                </TableTd>
                <TableTd>
                  {s.lastStatus
                    ? <Chip tone={JOB_STATUS_TONE[s.lastStatus] ?? 'default'} size="xs">{s.lastStatus}</Chip>
                    : <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>—</span>}
                </TableTd>
                <TableTd>
                  <Toggle enabled={s.enabled} onChange={v => onToggle(s.id, v)} />
                </TableTd>
                <TableTd>
                  <button
                    onClick={() => onDelete(s.id)}
                    style={{ fontSize: 11, color: 'var(--color-danger)', background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    Remove
                  </button>
                </TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </Card>
  );
}

// ─── Schedule Form ────────────────────────────────────────────────────────────

function ScheduleForm({ sources, onCreated }: { sources: DataSource[]; onCreated: () => void }) {
  const [dsId, setDsId] = useState(sources[0]?.id ?? '');
  const [preset, setPreset] = useState(CRON_PRESETS[1]!.expr);
  const [custom, setCustom] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const cronExpr = preset === '__custom__' ? custom : preset;

  async function submit() {
    if (!dsId) { setError('Select a data source.'); return; }
    if (!cronExpr) { setError('Enter a cron expression.'); return; }
    setError('');
    setSaving(true);
    try {
      const ds = sources.find(s => s.id === dsId);
      const resolvedLabel = label || CRON_PRESETS.find(p => p.expr === cronExpr)?.label || cronExpr;
      const r = await fetch('/api/ingest/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId: dsId, dataSourceName: ds?.name ?? dsId, cronExpr, label: resolvedLabel, enabled: true }),
      });
      const body = await r.json() as { error?: string };
      if (!r.ok) { setError(body.error ?? 'Failed to create schedule'); return; }
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 12, padding: '5px 8px', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', width: '100%', boxSizing: 'border-box',
  };

  return (
    <div style={{ background: 'var(--color-surface-raised)', borderRadius: 'var(--radius-md)', padding: 16, marginBottom: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={labelStyle}>Data Source</label>
          <select value={dsId} onChange={e => setDsId(e.target.value)} style={inputStyle}>
            {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Schedule</label>
          <select value={preset} onChange={e => setPreset(e.target.value)} style={inputStyle}>
            {CRON_PRESETS.map(p => <option key={p.expr} value={p.expr}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Label (optional)</label>
          <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Nightly sync" style={inputStyle} />
        </div>
      </div>

      {preset === '__custom__' && (
        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Cron Expression (UTC)</label>
          <input
            value={custom} onChange={e => setCustom(e.target.value)}
            placeholder="e.g. 0 */4 * * *"
            style={{ ...inputStyle, fontFamily: 'monospace' }}
          />
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 3 }}>
            Format: minute hour day month weekday — all times UTC
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 12, color: 'var(--color-danger)', marginBottom: 8 }}>{error}</div>
      )}

      <button onClick={submit} disabled={saving} style={primaryBtnStyle(saving)}>
        {saving ? 'Saving…' : 'Create Schedule'}
      </button>
    </div>
  );
}

// ─── Small reusable components ────────────────────────────────────────────────

function KVStat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, color: accent ? 'var(--color-success)' : undefined }}>{value}</div>
    </Card>
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

function PulseDot({ active, color }: { active: boolean; color: string }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color,
      animation: active ? 'orgiq-pulse 1.5s ease-in-out infinite' : 'none',
    }}>
      <style>{`@keyframes orgiq-pulse{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </span>
  );
}

function Toggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!enabled)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0,
        background: enabled ? 'var(--color-success)' : 'var(--color-border)',
        position: 'relative', transition: 'background 0.2s',
      }}
    >
      <span style={{
        display: 'block', width: 14, height: 14, borderRadius: '50%', background: '#fff',
        position: 'absolute', top: 3, left: enabled ? 19 : 3, transition: 'left 0.2s',
      }} />
    </button>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
      {children}
    </div>
  );
}

// ─── Style helpers ────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 500,
  color: 'var(--color-text-secondary)', marginBottom: 4,
};

const secondaryBtnStyle: React.CSSProperties = {
  fontSize: 12, padding: '5px 12px', background: 'transparent',
  border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
};

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 12, padding: '6px 16px', background: 'var(--color-primary)', color: '#fff',
    border: 'none', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'wait' : 'pointer', opacity: disabled ? 0.6 : 1,
  };
}

function syncBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11, padding: '4px 12px', background: 'var(--color-primary)', color: '#fff',
    border: 'none', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}

export default IngestPage;
