import React, { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import {
  Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import type {
  CrawlSession,
  CrawlStatus,
  CrawlTarget,
  StorageBreakdown,
} from '../components/ingest/types';
import { TargetsTable } from '../components/ingest/TargetsTable';
import { ActiveRunsStrip } from '../components/ingest/ActiveRunsStrip';
import { RunHistoryTable } from '../components/ingest/RunHistoryTable';
import { RunDetailDrawer } from '../components/ingest/RunDetailDrawer';
import { NewTargetModal } from '../components/ingest/NewTargetModal';
import type { TargetDraft } from '../components/ingest/NewTargetModal';
import { StorageBreakdownCard } from '../components/ingest/StorageBreakdownCard';
import { EmptyState, PulseDot, Toggle, labelStyle, primaryBtnStyle, secondaryBtnStyle } from '../components/ingest/ui';

// ─── KB / data-source / job interfaces (existing) ────────────────────────────

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

// ─── Constants ───────────────────────────────────────────────────────────────

const JOB_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  COMPLETE: 'success', IN_PROGRESS: 'warning', STARTING: 'warning', FAILED: 'danger', STOPPED: 'neutral',
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

// ─── KB sync SSE hook (existing — preserved) ─────────────────────────────────

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

// ─── Page ────────────────────────────────────────────────────────────────────

function IngestPage() {
  // Existing endpoints
  const { data: kbData } = useFetch<{ kb: KbSummary | null }>('/api/ingest/kb', 60_000);
  const { data: sourcesData, refresh: refreshSources } = useFetch<{ sources: DataSource[] }>('/api/ingest/data-sources', 30_000);
  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: IngestionJob[] }>('/api/ingest/jobs?limit=20', 10_000);
  const { data: queueData } = useFetch<S3Queue>('/api/ingest/queue', 60_000);

  // New (Track B) endpoints
  const { data: targetsData, refresh: refreshTargets } = useFetch<{ targets: CrawlTarget[] }>('/api/ingest/crawl-targets', 30_000);
  const { data: crawlsData, refresh: refreshCrawls } = useFetch<{ crawls: CrawlSession[] }>('/api/ingest/crawls', 10_000);
  const { data: storageData } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);

  const [triggering, setTriggering] = useState<string | null>(null);
  const [targetBusy, setTargetBusy] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // Drawer + modal state for crawl runs
  const [drawerCrawlId, setDrawerCrawlId] = useState<string | null>(null);
  const [drawerInitial, setDrawerInitial] = useState<CrawlSession | null>(null);
  const [runFilter, setRunFilter] = useState<'all' | CrawlStatus>('all');

  // Target modal state
  const [showNewTarget, setShowNewTarget] = useState(false);
  const [editTarget, setEditTarget] = useState<CrawlTarget | null>(null);

  const kb = kbData?.kb ?? null;
  const sources = sourcesData?.sources ?? [];
  const jobs = jobsData?.jobs ?? [];
  const targets = targetsData?.targets ?? [];
  const crawls = crawlsData?.crawls ?? [];

  const activeJob = jobs.find(j => ACTIVE_STATUSES.has(j.status)) ?? null;
  const lastCompleteJob = jobs.find(j => j.status === 'COMPLETE') ?? null;

  const activeCrawls = useMemo(() => crawls.filter(c => c.status === 'running'), [crawls]);
  const historyCrawls = useMemo(
    () => [...crawls].sort((a, b) => +new Date(b.startedAt) - +new Date(a.startedAt)),
    [crawls],
  );

  const { liveJob, streamDone } = useIngestionStream(
    activeJob?.jobId ?? null,
    activeJob?.dataSourceId ?? null,
    () => { refreshJobs(); },
  );

  const totalIndexed = jobs.reduce((s, j) => s + j.documentsIndexed, 0);

  // ── Actions ────────────────────────────────────────────────────────────────

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

  async function saveTarget(draft: TargetDraft) {
    setActionMessage(null);
    const url = editTarget
      ? `/api/ingest/crawl-targets/${encodeURIComponent(editTarget.id)}`
      : '/api/ingest/crawl-targets';
    const method = editTarget ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(draft),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Failed to save target (${r.status})`);
    }
    setActionMessage({
      tone: 'ok',
      text: editTarget ? `Target "${draft.label}" updated` : `Target "${draft.label}" created`,
    });
    setShowNewTarget(false);
    setEditTarget(null);
    refreshTargets();
  }

  async function runTarget(t: CrawlTarget) {
    setTargetBusy(t.id);
    setActionMessage(null);
    try {
      const r = await fetch(`/api/ingest/crawl-targets/${encodeURIComponent(t.id)}/run`, { method: 'POST' });
      const body = await r.json() as { session?: CrawlSession; error?: string };
      if (!r.ok || !body.session) {
        setActionMessage({ tone: 'err', text: body.error ?? 'Failed to start crawl' });
      } else {
        setActionMessage({ tone: 'ok', text: `Crawl started for "${t.label}"` });
        refreshCrawls();
        setDrawerCrawlId(body.session.id);
        setDrawerInitial(body.session);
      }
    } catch (e) {
      setActionMessage({ tone: 'err', text: (e as Error).message });
    } finally {
      setTargetBusy(null);
      refreshTargets();
    }
  }

  async function deleteTarget(t: CrawlTarget) {
    if (!confirm(`Delete crawl target "${t.label}"? Run history is preserved.`)) return;
    const r = await fetch(`/api/ingest/crawl-targets/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setActionMessage({ tone: 'err', text: body.error ?? 'Failed to delete target' });
      return;
    }
    setActionMessage({ tone: 'ok', text: `Target "${t.label}" deleted` });
    refreshTargets();
  }

  async function toggleTarget(t: CrawlTarget, enabled: boolean) {
    const r = await fetch(`/api/ingest/crawl-targets/${encodeURIComponent(t.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setActionMessage({ tone: 'err', text: body.error ?? 'Failed to toggle target' });
      return;
    }
    refreshTargets();
  }

  async function cancelCrawl(id: string) {
    const r = await fetch(`/api/ingest/crawl/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({})) as { error?: string };
      setActionMessage({ tone: 'err', text: body.error ?? 'Failed to cancel crawl' });
      return;
    }
    setActionMessage({ tone: 'ok', text: 'Crawl cancellation requested' });
    refreshCrawls();
  }

  function openCrawl(id: string) {
    const initial = crawls.find(c => c.id === id) ?? null;
    setDrawerInitial(initial);
    setDrawerCrawlId(id);
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

      {/* Stats row — now 5 tiles incl. storage */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 16 }}>
        <StatCard label="Crawl Targets"      value={String(targets.length)} />
        <StatCard label="Recent Crawls"      value={String(crawls.length)} />
        <StatCard label="Docs Indexed (recent)" value={String(totalIndexed)} accent />
        <QueueCard queue={queueData ?? null} lastCompleteJob={lastCompleteJob} />
        <StorageBreakdownCard storage={storageData ?? null} />
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

      {/* Live KB-sync monitor — preserved from existing logic */}
      {activeJob && (
        <LiveJobMonitor
          baseJob={activeJob}
          liveJob={liveJob}
          streamDone={streamDone}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Crawl Targets */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>Crawl Targets</h2>
          <button onClick={() => setShowNewTarget(true)} style={primaryBtnStyle(false)}>
            + New Target
          </button>
        </div>
        {targets.length === 0 ? (
          <EmptyState>
            No crawl targets yet. Define a target to start ingesting public web content with vision-LLM extraction.
          </EmptyState>
        ) : (
          <TargetsTable
            targets={targets}
            busyId={targetBusy}
            onRun={runTarget}
            onEdit={(t) => setEditTarget(t)}
            onDelete={deleteTarget}
            onToggle={toggleTarget}
          />
        )}
      </Card>

      {/* Active Crawls — only when something is running */}
      {activeCrawls.length > 0 && (
        <Card padding="md" style={{ marginBottom: 16, borderLeft: '3px solid var(--color-warning)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <PulseDot active color="var(--color-warning)" />
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>
              Active Crawls{' '}
              <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
                · {activeCrawls.length} running
              </span>
            </h2>
          </div>
          <ActiveRunsStrip
            sessions={activeCrawls}
            onCancel={cancelCrawl}
            onOpen={openCrawl}
          />
        </Card>
      )}

      {/* Crawl Run History */}
      <Card padding="md" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Crawl Run History{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>· 10s refresh</span>
          </h2>
        </div>
        {historyCrawls.length === 0 ? (
          <EmptyState>No crawl runs yet. Trigger one from a target above.</EmptyState>
        ) : (
          <RunHistoryTable
            sessions={historyCrawls}
            targets={targets}
            filter={runFilter}
            onFilter={setRunFilter}
            onOpen={openCrawl}
          />
        )}
      </Card>

      {/* Data Sources + KB Sync — kept but de-emphasized */}
      <details style={{ marginBottom: 16 }} open={sources.length > 0 && targets.length === 0}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-text-secondary)',
            padding: '8px 0',
          }}
        >
          KB Data Sources & Job History ({sources.length} sources · {jobs.length} recent jobs)
        </summary>

        {/* Data Sources */}
        <Card padding="md" style={{ marginBottom: 16, marginTop: 8 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Data Sources</h3>
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
            <EmptyState>No ingestion jobs yet.</EmptyState>
          ) : (
            <JobHistoryTable jobs={jobs} />
          )}
        </Card>

        {/* Schedules */}
        <SchedulesPanel sources={sources} />
      </details>

      {/* Right-side drawer for crawl run details */}
      <RunDetailDrawer
        crawlId={drawerCrawlId}
        initialSession={drawerInitial}
        onClose={() => { setDrawerCrawlId(null); setDrawerInitial(null); }}
      />

      {/* Target create/edit modal */}
      {(showNewTarget || editTarget) && (
        <NewTargetModal
          existing={editTarget}
          onSave={saveTarget}
          onCancel={() => { setShowNewTarget(false); setEditTarget(null); }}
        />
      )}

    </PageSection>
  );
}

// ─── Live KB Job Monitor (existing — preserved) ──────────────────────────────

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

// ─── Queue Card ──────────────────────────────────────────────────────────────

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

// ─── KB Job History Table (existing — preserved) ─────────────────────────────

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

// ─── Schedules Panel (existing — preserved) ─────────────────────────────────

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
        <h3 style={{ fontSize: 13, fontWeight: 600 }}>KB Sync Schedules</h3>
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
                    ? <Chip tone={JOB_STATUS_TONE[s.lastStatus] ?? 'neutral'} size="xs">{s.lastStatus}</Chip>
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

// ─── Schedule Form (existing — preserved) ───────────────────────────────────

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

// ─── Small reusable components ──────────────────────────────────────────────

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

// ─── Style helpers ──────────────────────────────────────────────────────────

function syncBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11, padding: '4px 12px', background: 'var(--color-primary)', color: '#fff',
    border: 'none', borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}

export default IngestPage;
