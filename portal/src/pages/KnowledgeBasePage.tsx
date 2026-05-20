// TODO(D3): wire post-merge —
//   1. middleware/src/index.ts: import + mount knowledgeBaseRouter at /api/knowledge-base.
//      It can mount ungated (same as cost/harness) or gated; default to ungated.
//   2. portal/src/App.tsx: lazy import KnowledgeBasePage; add <Route path="knowledge-base">.
//   3. portal/src/components/shell/Layout.tsx: NAV_ITEMS — append { path: '/knowledge-base', label: 'Knowledge Base' }
//      between Newsroom and Ingest, with requireRoles: ['hr-admin'] (or open if you prefer).
//   4. portal/src/components/shell/CommandPalette.tsx: add { label: 'Knowledge Base', hint: 'Documents + data sources', path: '/knowledge-base' } to PAGES.

import { useState } from 'react';
import {
  PageSection,
  Card,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableTh,
  TableTd,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';

// ─── API types ────────────────────────────────────────────────────────────────

interface IngestedDoc {
  id: string;
  source: string | null;
  sourceUri: string | null;
  title: string | null;
  ingestedAt: string | null;
}

interface DataSource {
  id: string;
  name: string;
  status: string;
  lastSyncedAt: string | null;
  lastJobStatus: string | null;
}

interface DocumentsResponse {
  documents: IngestedDoc[];
  total: number;
}

interface DataSourcesResponse {
  sources: DataSource[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── Tab chip pattern (matches DepartmentFilter / SkillFilter) ────────────────

type TabId = 'documents' | 'data-sources';

function tabBtnStyle(active: boolean): React.CSSProperties {
  const color = '#2563eb';
  return {
    padding: '4px 12px',
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    border: `1px solid ${active ? color : 'var(--color-border)'}`,
    background: active ? `${color}15` : 'var(--color-surface)',
    color: active ? color : 'var(--color-text-secondary)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  };
}

function syncBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '4px 12px',
    background: 'var(--color-primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

// ─── Documents tab ────────────────────────────────────────────────────────────

function DocumentsTab() {
  const { data, isLoading, error, refresh } = useFetch<DocumentsResponse>(
    '/api/knowledge-base/documents?limit=50',
    60_000,
  );
  const docs = data?.documents ?? [];

  return (
    <Card padding="md">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
          Ingested Documents
          {data && (
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400, marginLeft: 8 }}>
              · {data.total} rows · 60s refresh
            </span>
          )}
        </h3>
        <button
          onClick={refresh}
          style={{ fontSize: 11, padding: '4px 10px', cursor: 'pointer', border: '1px solid var(--color-border)', background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)' }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ padding: '8px 12px', background: '#fef2f2', color: '#991b1b', borderRadius: 4, fontSize: 12, marginBottom: 8 }}>
          {error}
        </div>
      )}

      {isLoading && docs.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          Loading…
        </div>
      ) : docs.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          No documents ingested yet. Run a sync to populate this table.
        </div>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Title</TableTh>
              <TableTh>Source</TableTh>
              <TableTh>Source URI</TableTh>
              <TableTh>Ingested at</TableTh>
              <TableTh>Actions</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {docs.map(doc => (
              <TableRow key={doc.id}>
                <TableTd>
                  <div style={{ fontWeight: 500 }}>{doc.title || '(untitled)'}</div>
                  <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                    {doc.id}
                  </div>
                </TableTd>
                <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {doc.source || '—'}
                </TableTd>
                <TableTd
                  style={{
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: 'var(--color-text-secondary)',
                    maxWidth: 280,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={doc.sourceUri ?? undefined}
                >
                  {doc.sourceUri || '—'}
                </TableTd>
                <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                  {formatDate(doc.ingestedAt)}
                </TableTd>
                <TableTd>
                  <button
                    disabled
                    title="Coming soon"
                    style={{ fontSize: 11, padding: '3px 10px', cursor: 'not-allowed', opacity: 0.4, border: '1px solid var(--color-border)', background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)' }}
                  >
                    Re-embed
                  </button>
                </TableTd>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// ─── Data Sources tab ─────────────────────────────────────────────────────────

function DataSourcesTab() {
  const { data, isLoading, error, refresh } = useFetch<DataSourcesResponse>(
    '/api/knowledge-base/data-sources',
    30_000,
  );
  const sources = data?.sources ?? [];

  const [syncing, setSyncing] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  async function handleSync(dataSourceId: string) {
    setSyncing(dataSourceId);
    setStatusMsg(null);
    try {
      const resp = await fetch('/api/knowledge-base/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSourceId }),
        credentials: 'include',
      });
      const body = await resp.json() as { ok?: boolean; jobId?: string; error?: string };
      if (!resp.ok || !body.ok) {
        setStatusMsg({ tone: 'err', text: body.error ?? 'Sync request failed' });
      } else {
        setStatusMsg({ tone: 'ok', text: `Job ${(body.jobId ?? '').slice(0, 12)}… started` });
        refresh();
      }
    } catch (e) {
      setStatusMsg({ tone: 'err', text: (e as Error).message });
    } finally {
      setSyncing(null);
    }
  }

  const JOB_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
    COMPLETE: 'success',
    IN_PROGRESS: 'warning',
    STARTING: 'warning',
    FAILED: 'danger',
    STOPPED: 'neutral',
  };

  return (
    <Card padding="md">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
          Data Sources
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', fontWeight: 400, marginLeft: 8 }}>
            · 30s refresh
          </span>
        </h3>
        <button
          onClick={refresh}
          style={{ fontSize: 11, padding: '4px 10px', cursor: 'pointer', border: '1px solid var(--color-border)', background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)', color: 'var(--color-text-secondary)' }}
        >
          Refresh
        </button>
      </div>

      {statusMsg && (
        <div style={{
          padding: '8px 12px',
          marginBottom: 10,
          borderRadius: 4,
          fontSize: 12,
          background: statusMsg.tone === 'ok' ? '#ecfdf5' : '#fef2f2',
          color: statusMsg.tone === 'ok' ? '#065f46' : '#991b1b',
        }}>
          {statusMsg.text}
        </div>
      )}

      {error && (
        <div style={{ padding: '8px 12px', background: '#fef2f2', color: '#991b1b', borderRadius: 4, fontSize: 12, marginBottom: 8 }}>
          {error}
        </div>
      )}

      {isLoading && sources.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          Loading…
        </div>
      ) : sources.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          No data sources attached to this Knowledge Base, or KB_ID is not configured.
        </div>
      ) : (
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Name</TableTh>
              <TableTh>Status</TableTh>
              <TableTh>Last synced</TableTh>
              <TableTh>Last job</TableTh>
              <TableTh>Action</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {sources.map(ds => {
              const isSyncing = syncing === ds.id;
              return (
                <TableRow key={ds.id}>
                  <TableTd>
                    <div style={{ fontWeight: 500 }}>{ds.name}</div>
                    <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                      {ds.id}
                    </div>
                  </TableTd>
                  <TableTd>
                    <Chip tone={ds.status === 'AVAILABLE' ? 'success' : 'warning'} size="xs">
                      {ds.status}
                    </Chip>
                  </TableTd>
                  <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                    {formatDate(ds.lastSyncedAt)}
                  </TableTd>
                  <TableTd>
                    {ds.lastJobStatus ? (
                      <Chip tone={JOB_STATUS_TONE[ds.lastJobStatus] ?? 'neutral'} size="xs">
                        {ds.lastJobStatus}
                      </Chip>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>—</span>
                    )}
                  </TableTd>
                  <TableTd>
                    <button
                      onClick={() => handleSync(ds.id)}
                      disabled={isSyncing || syncing !== null}
                      style={syncBtnStyle(isSyncing || syncing !== null)}
                    >
                      {isSyncing ? (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              display: 'inline-block',
                              width: 10,
                              height: 10,
                              border: '2px solid rgba(255,255,255,0.4)',
                              borderTopColor: '#fff',
                              borderRadius: '50%',
                              animation: 'spin 0.7s linear infinite',
                            }}
                          />
                          Syncing…
                        </span>
                      ) : 'Sync now'}
                    </button>
                  </TableTd>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function KnowledgeBasePage() {
  const [activeTab, setActiveTab] = useState<TabId>('documents');

  return (
    <PageSection title="Knowledge Base">
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>Knowledge Base</h2>
        <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
          Manage ingested documents and Bedrock data sources.
        </p>
      </div>

      {/* Tab bar — chip pattern matching DepartmentFilter / SkillFilter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <button
          onClick={() => setActiveTab('documents')}
          style={tabBtnStyle(activeTab === 'documents')}
        >
          Documents
        </button>
        <button
          onClick={() => setActiveTab('data-sources')}
          style={tabBtnStyle(activeTab === 'data-sources')}
        >
          Data Sources
        </button>
      </div>

      {activeTab === 'documents' && <DocumentsTab />}
      {activeTab === 'data-sources' && <DataSourcesTab />}
    </PageSection>
  );
}

export default KnowledgeBasePage;
