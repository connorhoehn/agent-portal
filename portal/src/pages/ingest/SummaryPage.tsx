import { Card, Chip, StatCard } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import type {
  CrawlSession,
  CrawlTarget,
  StorageBreakdown,
} from '../../components/ingest/types';
import { StorageBreakdownCard } from '../../components/ingest/StorageBreakdownCard';

interface KbSummary {
  id: string; name: string; status: string; description: string;
  embeddingModel: string; embeddingModelArn: string; vectorStore: string; updatedAt: string;
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

function SummaryPage() {
  const { data: kbData } = useFetch<{ kb: KbSummary | null }>('/api/ingest/kb', 60_000);
  const { data: jobsData } = useFetch<{ jobs: IngestionJob[] }>('/api/ingest/jobs?limit=20', 10_000);
  const { data: queueData } = useFetch<S3Queue>('/api/ingest/queue', 60_000);
  const { data: targetsData } = useFetch<{ targets: CrawlTarget[] }>('/api/ingest/crawl-targets', 30_000);
  const { data: crawlsData } = useFetch<{ crawls: CrawlSession[] }>('/api/ingest/crawls', 10_000);
  const { data: storageData } = useFetch<StorageBreakdown>('/api/ingest/storage', 60_000);

  const kb = kbData?.kb ?? null;
  const jobs = jobsData?.jobs ?? [];
  const targets = targetsData?.targets ?? [];
  const crawls = crawlsData?.crawls ?? [];

  const lastCompleteJob = jobs.find(j => j.status === 'COMPLETE') ?? null;
  const totalIndexed = jobs.reduce((s, j) => s + j.documentsIndexed, 0);

  return (
    <div style={{ padding: 24 }}>
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

      {/* Stats row — 5 tiles incl. storage */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
        <StatCard label="Crawl Targets"         value={String(targets.length)} />
        <StatCard label="Recent Crawls"         value={String(crawls.length)} />
        <StatCard label="Docs Indexed (recent)" value={String(totalIndexed)} accent />
        <QueueCard queue={queueData ?? null} lastCompleteJob={lastCompleteJob} />
        <StorageBreakdownCard storage={storageData ?? null} />
      </div>
    </div>
  );
}

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

export default SummaryPage;
