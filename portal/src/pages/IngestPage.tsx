import { Card, PageSection, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehnslalom/ui-components';
import { useFetch } from '../hooks/useFetch';

interface IngestSource {
  id: string;
  name: string;
  type: string;
  status: string;
  lastSync: string | null;
  documentCount: number;
  errorCount: number;
  nextSync: string | null;
}

interface IngestStats {
  totalDocuments: number;
  activeSyncs: number;
  dlqItems: number;
  documentsLast24h: number;
  avgProcessingMs: number;
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  syncing: 'warning',
  configured: 'neutral',
  error: 'danger',
};

function IngestPage() {
  const { data: sourcesData } = useFetch<{ sources: IngestSource[] }>('/api/ingest/sources', 30000);
  const { data: stats } = useFetch<IngestStats>('/api/ingest/stats', 30000);

  const sources = sourcesData?.sources ?? [];

  return (
    <PageSection title="Ingest Monitor">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16, marginBottom: 24 }}>
        <StatCard label="Total Documents" value={stats?.totalDocuments.toLocaleString() ?? '—'} />
        <StatCard label="Active Syncs" value={String(stats?.activeSyncs ?? 0)} />
        <StatCard label="Last 24h" value={`+${stats?.documentsLast24h ?? 0}`} accent />
        <StatCard label="Avg Processing" value={stats ? `${(stats.avgProcessingMs / 1000).toFixed(1)}s` : '—'} />
        <StatCard label="DLQ Items" value={String(stats?.dlqItems ?? 0)} danger={!!stats && stats.dlqItems > 0} />
      </div>

      <Card padding="md">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600 }}>Data Sources</h2>
          <button
            onClick={() => fetch('/api/ingest/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })}
            style={{ fontSize: 12, padding: '6px 12px', background: 'var(--color-primary)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}
          >
            Trigger Full Sync
          </button>
        </div>
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Source</TableTh>
              <TableTh>Type</TableTh>
              <TableTh>Status</TableTh>
              <TableTh>Last Sync</TableTh>
              <TableTh style={{ textAlign: 'right' }}>Documents</TableTh>
              <TableTh style={{ textAlign: 'right' }}>Errors</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {sources.map(s => (
              <TableRow key={s.id}>
                <TableTd style={{ fontWeight: 500 }}>{s.name}</TableTd>
                <TableTd style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.type}</TableTd>
                <TableTd>
                  <Chip tone={STATUS_TONE[s.status] ?? 'neutral'} size="xs">{s.status}</Chip>
                </TableTd>
                <TableTd style={{ fontSize: 12 }}>
                  {s.lastSync ? new Date(s.lastSync).toLocaleString() : 'Never'}
                </TableTd>
                <TableTd style={{ textAlign: 'right', fontWeight: 500 }}>{s.documentCount.toLocaleString()}</TableTd>
                <TableTd style={{ textAlign: 'right', color: s.errorCount > 0 ? 'var(--color-danger)' : undefined }}>
                  {s.errorCount}
                </TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </PageSection>
  );
}

function StatCard({ label, value, accent, danger }: { label: string; value: string; accent?: boolean; danger?: boolean }) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{
        fontSize: 24, fontWeight: 700, marginTop: 4,
        color: danger ? 'var(--color-danger)' : accent ? 'var(--color-success)' : undefined,
      }}>{value}</div>
    </Card>
  );
}

export default IngestPage;
