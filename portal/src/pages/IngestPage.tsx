import { useState } from 'react';
import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

interface KbSummary {
  id: string;
  name: string;
  status: string;
  description: string;
  embeddingModel: string;
  embeddingModelArn: string;
  vectorStore: string;
  updatedAt: string;
}

interface DataSource {
  id: string;
  name: string;
  status: string;
  description: string;
  type: string;
  sourceUri: string;
  updatedAt: string;
}

interface IngestionJob {
  jobId: string;
  dataSourceId: string;
  status: string;
  startedAt: string;
  updatedAt: string;
  description: string;
  durationMs: number;
  documentsScanned: number;
  documentsIndexed: number;
  documentsFailed: number;
  documentsDeleted: number;
}

const JOB_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'default'> = {
  COMPLETE: 'success',
  IN_PROGRESS: 'warning',
  STARTING: 'warning',
  FAILED: 'danger',
  STOPPED: 'default',
};

function IngestPage() {
  const { data: kbData } = useFetch<{ kb: KbSummary | null }>('/api/ingest/kb', 60000);
  const { data: sourcesData, refresh: refreshSources } = useFetch<{ sources: DataSource[] }>('/api/ingest/data-sources', 30000);
  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: IngestionJob[] }>('/api/ingest/jobs?limit=20', 10000);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const kb = kbData?.kb ?? null;
  const sources = sourcesData?.sources ?? [];
  const jobs = jobsData?.jobs ?? [];

  async function triggerSync(dataSourceId: string) {
    setTriggering(dataSourceId);
    setActionMessage(null);
    try {
      const r = await fetch('/api/ingest/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId }),
      });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        setActionMessage({ tone: 'err', text: body.error || 'Sync failed' });
      } else {
        setActionMessage({ tone: 'ok', text: `Job ${body.job.jobId.slice(0, 12)}… ${body.job.status}` });
      }
    } catch (e) {
      setActionMessage({ tone: 'err', text: (e as Error).message });
    } finally {
      setTriggering(null);
      refreshSources();
      refreshJobs();
    }
  }

  const totalIndexed = jobs.reduce((s, j) => s + j.documentsIndexed, 0);
  const lastJob = jobs[0];

  return (
    <PageSection title="Knowledge Base Ingest">
      {!kb ? (
        <Card padding="md">
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
            <Stat label="KB ID" value={kb.id} mono />
            <Stat label="Embedding Model" value={kb.embeddingModel || '—'} mono />
            <Stat label="Vector Store" value={kb.vectorStore || '—'} />
            <Stat label="Updated" value={new Date(kb.updatedAt).toLocaleString()} />
          </div>
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
        <StatCard label="Data Sources" value={String(sources.length)} />
        <StatCard label="Recent Jobs" value={String(jobs.length)} />
        <StatCard label="Docs Indexed (recent)" value={String(totalIndexed)} accent />
      </div>

      {actionMessage && (
        <div style={{
          padding: 10,
          marginBottom: 12,
          background: actionMessage.tone === 'ok' ? '#ecfdf5' : '#fef2f2',
          color: actionMessage.tone === 'ok' ? '#065f46' : '#991b1b',
          fontSize: 12,
          borderRadius: 4,
        }}>
          {actionMessage.text}
        </div>
      )}

      <Card padding="md" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Data Sources</h2>
        {sources.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            No data sources attached to this Knowledge Base.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Name</TableTh>
                <TableTh>Type</TableTh>
                <TableTh>Source URI</TableTh>
                <TableTh>Status</TableTh>
                <TableTh></TableTh>
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
                      disabled={triggering === ds.id}
                      style={{
                        fontSize: 11,
                        padding: '4px 12px',
                        background: 'var(--color-primary)',
                        color: '#fff',
                        border: 'none',
                        borderRadius: 'var(--radius-sm)',
                        cursor: triggering === ds.id ? 'wait' : 'pointer',
                        opacity: triggering === ds.id ? 0.6 : 1,
                      }}
                    >
                      {triggering === ds.id ? 'Syncing…' : 'Sync now'}
                    </button>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="md" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>
            Recent Ingestion Jobs{' '}
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400 }}>
              · 10s refresh
            </span>
          </h2>
          {lastJob && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              last: {new Date(lastJob.startedAt).toLocaleString()}
            </span>
          )}
        </div>
        {jobs.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            No ingestion jobs yet. Click "Sync now" on a data source.
          </div>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Started</TableTh>
                <TableTh>Job</TableTh>
                <TableTh>Status</TableTh>
                <TableTh>Duration</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Indexed</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Scanned</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Failed</TableTh>
                <TableTh style={{ textAlign: 'right' }}>Deleted</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {jobs.map(j => (
                <TableRow key={j.jobId}>
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
                  <TableTd style={{ textAlign: 'right', fontSize: 12, color: j.documentsFailed > 0 ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>{j.documentsFailed}</TableTd>
                  <TableTd style={{ textAlign: 'right', fontSize: 12, color: 'var(--color-text-secondary)' }}>{j.documentsDeleted}</TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card padding="md">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>Schedule</h2>
          <Chip tone="default" size="xs">Manual only</Chip>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
          No cron schedule is configured. Ingestion jobs run only when triggered via
          <code style={{ margin: '0 4px' }}>POST /api/ingest/start</code>
          or the <b>Sync now</b> button.
          <div style={{ marginTop: 8 }}>
            To enable scheduled sync, add an EventBridge rule in
            <code style={{ margin: '0 4px' }}>infra/lib/knowledge-base-stack.ts</code>
            with a cron expression that targets a Lambda calling
            <code style={{ margin: '0 4px' }}>bedrock:StartIngestionJob</code>.
          </div>
        </div>
      </Card>
    </PageSection>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
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
      <div style={{
        fontSize: 24,
        fontWeight: 700,
        marginTop: 4,
        color: accent ? 'var(--color-success)' : undefined,
      }}>{value}</div>
    </Card>
  );
}

export default IngestPage;
