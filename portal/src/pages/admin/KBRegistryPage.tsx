import { useState } from 'react';
import { useNavigate, Link } from 'react-router';
import { KBCreateWizard } from '../../components/kb/KBCreateWizard.js';
import { useFetch } from '../../hooks/useFetch.js';
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
  ConfirmDialog,
  StatusDot,
} from '@connorhoehnslalom/ui-components/shared';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KbRegistryEntry {
  id: string;
  bedrockKbId: string | null;
  dataSourceId: string | null;
  name: string;
  slug: string;
  tenant: 'orgiq' | 'newsroom';
  purpose: string;
  description: string;
  s3Prefix: string;
  auroraTable: string;
  embeddingModel: string;
  chunkingStrategy: string;
  maxTokens: number;
  status: 'ACTIVE' | 'CREATING' | 'PENDING' | 'FAILED' | 'UPDATING' | 'DELETING';
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  // Enriched at list time:
  docCount?: number;
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
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

// ─── Status chip ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  KbRegistryEntry['status'],
  { dotColor: string; label: string; chipTone: 'success' | 'warning' | 'danger' | 'neutral' }
> = {
  ACTIVE:    { dotColor: '#16a34a', label: 'ACTIVE',    chipTone: 'success' },
  CREATING:  { dotColor: '#ca8a04', label: 'CREATING',  chipTone: 'warning' },
  UPDATING:  { dotColor: '#ca8a04', label: 'UPDATING',  chipTone: 'warning' },
  PENDING:   { dotColor: '#9ca3af', label: 'PENDING',   chipTone: 'neutral' },
  DELETING:  { dotColor: '#9ca3af', label: 'DELETING',  chipTone: 'neutral' },
  FAILED:    { dotColor: '#dc2626', label: 'FAILED',    chipTone: 'danger'  },
};

export function StatusChip({ status }: { status: KbRegistryEntry['status'] }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING;
  return (
    <span className="inline-flex items-center gap-1">
      <StatusDot color={cfg.dotColor} size="sm" />
      <Chip tone={cfg.chipTone} size="xs">{cfg.label}</Chip>
    </span>
  );
}

// ─── Filter chip style ────────────────────────────────────────────────────────

type TenantFilter = 'all' | 'orgiq' | 'newsroom';

function filterBtnStyle(active: boolean): React.CSSProperties {
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export function KBRegistryPage() {
  const navigate = useNavigate();
  const [tenantFilter, setTenantFilter] = useState<TenantFilter>('all');
  const [wizardOpen, setWizardOpen] = useState(false);

  const { data, isLoading, error, refresh } = useFetch<{ kbs: KbRegistryEntry[] }>(
    '/api/admin/kb-registry',
    30_000,
  );

  const allKbs = data?.kbs ?? [];
  const visible = tenantFilter === 'all'
    ? allKbs
    : allKbs.filter(kb => kb.tenant === tenantFilter);

  return (
    <PageSection
      title="Knowledge base registry"
      description="The rows the platform keeps about Bedrock knowledge bases. Whether they match the account is answered on Knowledge."
    >
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <Link to="/admin/knowledge" style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'none' }}>
          ← Knowledge
        </Link>
        <button
          onClick={() => setWizardOpen(true)}
          style={{
            fontSize: 13,
            fontWeight: 600,
            padding: '7px 16px',
            background: 'var(--color-primary)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          + New Knowledge Base
        </button>
      </div>

      {/* Error banner */}
      {error && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 14px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            fontSize: 12,
            color: '#dc2626',
          }}
        >
          Failed to load knowledge bases: {error}
        </div>
      )}

      {/* Tenant filter chips */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        {(['all', 'orgiq', 'newsroom'] as TenantFilter[]).map(t => (
          <button
            key={t}
            onClick={() => setTenantFilter(t)}
            style={filterBtnStyle(tenantFilter === t)}
          >
            {t === 'all' ? 'All' : t}
          </button>
        ))}
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 4 }}>
          {error && !data ? '' : isLoading && !data ? 'Loading…' : `${visible.length} ${visible.length === 1 ? 'entry' : 'entries'}`}
        </span>
      </div>

      {/* Table */}
      <Card padding="md">
        <Table>
          <TableHead>
            <TableRow>
              <TableTh>Name</TableTh>
              <TableTh>Tenant</TableTh>
              <TableTh>Purpose</TableTh>
              <TableTh>Status</TableTh>
              <TableTh>Documents</TableTh>
              <TableTh>Last Sync</TableTh>
              <TableTh>Actions</TableTh>
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map(kb => (
              <TableRow
                key={kb.id}
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/admin/knowledge-bases/${kb.id}`)}
              >
                {/* Name + slug */}
                <TableTd>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{kb.name}</div>
                  <div style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--color-text-tertiary)', marginTop: 1 }}>
                    {kb.slug}
                  </div>
                </TableTd>

                {/* Tenant */}
                <TableTd>
                  <Chip
                    tone={kb.tenant === 'orgiq' ? 'success' : 'warning'}
                    size="xs"
                  >
                    {kb.tenant}
                  </Chip>
                </TableTd>

                {/* Purpose */}
                <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {kb.purpose}
                </TableTd>

                {/* Status */}
                <TableTd>
                  <div>
                    <StatusChip status={kb.status} />
                    {kb.errorMessage && (
                      <div
                        style={{ fontSize: 10, color: '#dc2626', marginTop: 2, maxWidth: 200, wordBreak: 'break-word' }}
                        title={kb.errorMessage}
                      >
                        {kb.errorMessage.length > 60 ? `${kb.errorMessage.slice(0, 60)}…` : kb.errorMessage}
                      </div>
                    )}
                  </div>
                </TableTd>

                {/* Document count */}
                <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {kb.docCount !== undefined ? kb.docCount.toLocaleString() : '—'}
                </TableTd>

                {/* Last sync */}
                <TableTd style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                  <div>{formatDate(kb.lastSyncAt)}</div>
                  {kb.lastSyncStatus && (
                    <div style={{ marginTop: 2 }}>
                      <Chip
                        tone={kb.lastSyncStatus === 'COMPLETE' ? 'success' : 'warning'}
                        size="xs"
                      >
                        {kb.lastSyncStatus}
                      </Chip>
                    </div>
                  )}
                </TableTd>

                {/* Actions */}
                <TableTd onClick={e => e.stopPropagation()}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {kb.status === 'ACTIVE' ? (
                      <SyncButton kbId={kb.id} dataSourceId={kb.dataSourceId} onDone={refresh} />
                    ) : ['PENDING', 'FAILED'].includes(kb.status) ? (
                      <ProvisionButton kbId={kb.id} onDone={() => navigate(`/admin/knowledge-bases/${kb.id}`)} />
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                        {kb.status === 'CREATING' ? 'Provisioning…' : '—'}
                      </span>
                    )}
                    {/* Delete available for FAILED / PENDING (orphaned rows) */}
                    {['FAILED', 'PENDING'].includes(kb.status) && (
                      <DeleteButton kbId={kb.id} kbName={kb.name} onDone={refresh} />
                    )}
                  </div>
                </TableTd>
              </TableRow>
            ))}

            {!isLoading && visible.length === 0 && (
              <TableRow>
                <TableTd
                  colSpan={7}
                  style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13, padding: '32px 0' }}
                >
                  {data
                    ? 'No knowledge bases match this filter.'
                    : error
                      ? 'Could not read the registry — see the error above.'
                      : 'No knowledge bases found.'}
                </TableTd>
              </TableRow>
            )}

            {isLoading && !data && (
              <TableRow>
                <TableTd
                  colSpan={7}
                  style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13, padding: '32px 0' }}
                >
                  Loading…
                </TableTd>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <KBCreateWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onCreated={(kb) => {
          setWizardOpen(false);
          refresh();
          navigate(`/admin/knowledge-bases/${kb.id}`);
        }}
      />
    </PageSection>
  );
}

// ─── Action buttons ───────────────────────────────────────────────────────────

function SyncButton({
  kbId,
  dataSourceId,
  onDone,
}: {
  kbId: string;
  dataSourceId: string | null;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!dataSourceId) return <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>—</span>;

  async function handleSync() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/kb-registry/${kbId}/sync`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
      } else {
        onDone();
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        disabled={loading}
        onClick={handleSync}
        style={{
          fontSize: 11,
          padding: '4px 10px',
          background: loading ? '#93c5fd' : 'var(--color-primary)',
          color: '#fff',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          cursor: loading ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {loading ? 'Starting…' : 'Sync Now'}
      </button>
      {error && <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }} title={error}>Error</div>}
    </div>
  );
}

function ProvisionButton({
  kbId,
  onDone,
}: {
  kbId: string;
  onDone: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleProvision() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/kb-registry/${kbId}/provision`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setLoading(false);
      } else {
        onDone(); // navigate to detail page — SSE stream is there
      }
    } catch {
      setError('Network error');
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        disabled={loading}
        onClick={handleProvision}
        style={{
          fontSize: 11,
          padding: '4px 10px',
          background: loading ? '#9ca3af' : '#475569',
          color: '#fff',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          cursor: loading ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {loading ? 'Starting…' : 'Provision'}
      </button>
      {error && <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }} title={error}>Failed</div>}
    </div>
  );
}

// ─── DeleteButton ─────────────────────────────────────────────────────────────

export function DeleteButton({
  kbId,
  kbName,
  onDone,
  variant = 'compact',
}: {
  kbId: string;
  kbName: string;
  onDone: () => void;
  variant?: 'compact' | 'full';
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function performDelete() {
    setConfirmOpen(false);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/kb-registry/${kbId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setLoading(false);
      } else {
        onDone();
      }
    } catch {
      setError('Network error');
      setLoading(false);
    }
  }

  return (
    <div>
      <button
        disabled={loading}
        onClick={() => setConfirmOpen(true)}
        title={`Delete "${kbName}" and all associated resources`}
        style={{
          fontSize: variant === 'full' ? 13 : 11,
          padding: variant === 'full' ? '7px 16px' : '4px 10px',
          fontWeight: variant === 'full' ? 600 : 400,
          background: loading ? '#9ca3af' : '#fee2e2',
          color: loading ? '#fff' : '#dc2626',
          border: '1px solid #fca5a5',
          borderRadius: 'var(--radius-sm)',
          cursor: loading ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {loading ? 'Deleting…' : variant === 'full' ? 'Delete KB' : '✕ Delete'}
      </button>
      {error && <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }} title={error}>Error</div>}
      <ConfirmDialog
        open={confirmOpen}
        onConfirm={() => void performDelete()}
        onCancel={() => setConfirmOpen(false)}
        tone="destructive"
        title={`Delete "${kbName}"?`}
        body="This will remove the DB registry row, delete the Bedrock KB (if provisioned), and drop the Aurora vector table. This cannot be undone."
      />
    </div>
  );
}

export default KBRegistryPage;
