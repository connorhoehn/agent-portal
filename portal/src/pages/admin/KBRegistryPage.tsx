// TODO(Wave 3-C): replace MOCK_KBS with a real useFetch('/api/admin/knowledge-bases', 30_000)
//   call and wire the "Sync Now" action to POST /api/admin/knowledge-bases/:id/sync.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

// ─── Mock data ────────────────────────────────────────────────────────────────

export const MOCK_KBS: KbRegistryEntry[] = [
  {
    id: 'kb-default-001',
    bedrockKbId: 'EJYAXQAMHQ',
    dataSourceId: null,
    name: 'OrgIQ Documents',
    slug: 'default',
    tenant: 'orgiq',
    purpose: 'default',
    description: 'General org docs — ADRs, postmortems, wiki, Slack',
    s3Prefix: 'orgiq/uploads/',
    auroraTable: 'bedrock_kb',
    embeddingModel: 'amazon.titan-embed-text-v2:0',
    chunkingStrategy: 'SEMANTIC',
    maxTokens: 512,
    status: 'ACTIVE',
    errorMessage: null,
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2026-05-21T08:00:00Z',
    docCount: 213,
    lastSyncAt: '2026-05-21T06:00:00Z',
    lastSyncStatus: 'COMPLETE',
  },
  {
    id: 'kb-newsroom-001',
    bedrockKbId: null,
    dataSourceId: null,
    name: 'Newsroom Articles',
    slug: 'newsroom',
    tenant: 'newsroom',
    purpose: 'articles',
    description: 'News articles and editorial research',
    s3Prefix: 'newsroom/',
    auroraTable: 'bedrock_kb_newsroom',
    embeddingModel: 'amazon.titan-embed-text-v2:0',
    chunkingStrategy: 'SEMANTIC',
    maxTokens: 512,
    status: 'PENDING',
    errorMessage: null,
    createdAt: '2026-05-21T00:00:00Z',
    updatedAt: '2026-05-21T00:00:00Z',
    docCount: undefined,
    lastSyncAt: null,
    lastSyncStatus: null,
  },
];

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

function StatusChip({ status }: { status: KbRegistryEntry['status'] }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: cfg.dotColor,
          flexShrink: 0,
        }}
      />
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

  const visible = tenantFilter === 'all'
    ? MOCK_KBS
    : MOCK_KBS.filter(kb => kb.tenant === tenantFilter);

  return (
    <PageSection title="Knowledge Bases">
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px' }}>Knowledge Bases</h2>
          <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', margin: 0 }}>
            Registered Bedrock Knowledge Base entries and their ingestion status.
          </p>
        </div>
        <button
          disabled
          title="Coming in Wave 2-B"
          onClick={() => console.log('+ New Knowledge Base — not yet implemented')}
          style={{
            fontSize: 13,
            fontWeight: 600,
            padding: '7px 16px',
            background: 'var(--color-primary)',
            color: '#fff',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: 'not-allowed',
            opacity: 0.5,
          }}
        >
          + New Knowledge Base
        </button>
      </div>

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
          {visible.length} {visible.length === 1 ? 'entry' : 'entries'}
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
                    {kb.id}
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
                  <StatusChip status={kb.status} />
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
                  <button
                    disabled
                    title="Coming in Wave 3-C"
                    onClick={() => console.log('Sync Now — not yet implemented', kb.id)}
                    style={{
                      fontSize: 11,
                      padding: '4px 12px',
                      background: 'var(--color-primary)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'not-allowed',
                      opacity: 0.5,
                    }}
                  >
                    Sync Now
                  </button>
                </TableTd>
              </TableRow>
            ))}

            {visible.length === 0 && (
              <TableRow>
                <TableTd
                  colSpan={7}
                  style={{ textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13, padding: '32px 0' }}
                >
                  No knowledge bases match this filter.
                </TableTd>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </PageSection>
  );
}

export default KBRegistryPage;
