import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useFetch } from '../../hooks/useFetch.js';
import { ProvisioningProgress } from '../../components/kb/ProvisioningProgress.js';
import type { KbRegistryEntry } from './KBRegistryPage.js';
import { StatusChip, DeleteButton } from './KBRegistryPage.js';
import {
  PageSection,
  Card,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';

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

// ─── Pipeline Chain ───────────────────────────────────────────────────────────

const STATUS_DOT: Record<KbRegistryEntry['status'], string> = {
  ACTIVE:   '#16a34a',
  CREATING: '#ca8a04',
  UPDATING: '#ca8a04',
  PENDING:  '#9ca3af',
  DELETING: '#9ca3af',
  FAILED:   '#dc2626',
};

function PipelineNode({
  label,
  value,
  dotColor,
}: {
  label: string;
  value: string;
  dotColor: string;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        padding: '8px 14px',
        background: 'var(--color-surface)',
        minWidth: 130,
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, marginBottom: 3 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: dotColor,
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <span style={{ fontSize: 16, color: 'var(--color-text-tertiary)', userSelect: 'none', flexShrink: 0, padding: '0 4px' }}>
      ──▶
    </span>
  );
}

function PipelineChain({ kb }: { kb: KbRegistryEntry }) {
  const dotColor = STATUS_DOT[kb.status] ?? '#9ca3af';

  return (
    <Card padding="md">
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 14px' }}>Pipeline Chain</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <PipelineNode
          label="S3 Landing Zone"
          value={kb.s3Prefix}
          dotColor={dotColor}
        />
        <Arrow />
        <PipelineNode
          label="Data Source"
          value={kb.dataSourceId ?? '(not provisioned)'}
          dotColor={kb.dataSourceId ? dotColor : '#9ca3af'}
        />
        <Arrow />
        <PipelineNode
          label="Bedrock KB"
          value={kb.bedrockKbId ?? '(not provisioned)'}
          dotColor={kb.bedrockKbId ? dotColor : '#9ca3af'}
        />
        <Arrow />
        <PipelineNode
          label="Agents"
          value="search · advisor"
          dotColor={kb.status === 'ACTIVE' ? dotColor : '#9ca3af'}
        />
      </div>
    </Card>
  );
}

// ─── Re-provision modal ───────────────────────────────────────────────────────

function ReprovisionModal({
  kb,
  onClose,
  onComplete,
}: {
  kb: KbRegistryEntry;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [provError, setProvError] = useState<string | null>(null);

  async function startProvisioning() {
    setStartError(null);
    try {
      const res = await fetch(`/api/admin/kb-registry/${kb.id}/provision`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setStartError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setStarted(true);
    } catch {
      setStartError('Network error — check middleware logs');
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={e => { if (e.target === e.currentTarget && !started) onClose(); }}
    >
      <div
        style={{
          width: 460,
          background: '#fff',
          borderRadius: 10,
          boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          overflow: 'hidden',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {started ? 'Provisioning in Progress' : 'Provision Knowledge Base'}
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
              {kb.name} · <code style={{ fontFamily: 'monospace' }}>{kb.slug}</code>
            </div>
          </div>
          {!started && (
            <button
              onClick={onClose}
              style={{ background: 'none', border: 'none', fontSize: 18, color: '#6b7280', cursor: 'pointer', padding: '2px 6px' }}
            >
              ×
            </button>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '20px' }}>
          {!started ? (
            <>
              <p style={{ fontSize: 13, color: '#374151', margin: '0 0 16px' }}>
                This will provision the Bedrock Knowledge Base for{' '}
                <strong>{kb.name}</strong>. The 7-step process takes about 2–3 minutes.
              </p>
              {kb.status === 'FAILED' && kb.errorMessage && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: '8px 12px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 6,
                    fontSize: 12,
                    color: '#dc2626',
                  }}
                >
                  <strong>Previous failure:</strong> {kb.errorMessage}
                </div>
              )}
              {startError && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: '8px 12px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 6,
                    fontSize: 12,
                    color: '#dc2626',
                  }}
                >
                  {startError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  onClick={onClose}
                  style={{
                    padding: '7px 16px', fontSize: 13, background: '#fff',
                    border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', color: '#374151',
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={startProvisioning}
                  style={{
                    padding: '7px 16px', fontSize: 13, fontWeight: 600,
                    background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer',
                  }}
                >
                  {kb.status === 'FAILED' ? 'Re-provision' : 'Provision'}
                </button>
              </div>
            </>
          ) : (
            <>
              <ProvisioningProgress
                registryId={kb.id}
                onComplete={() => { onComplete(); onClose(); }}
                onError={msg => setProvError(msg)}
              />
              {provError && (
                <div
                  style={{
                    marginTop: 14,
                    padding: '8px 12px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    borderRadius: 6,
                    fontSize: 12,
                    color: '#dc2626',
                  }}
                >
                  {provError}
                </div>
              )}
              {provError && (
                <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    onClick={onClose}
                    style={{
                      padding: '7px 16px', fontSize: 13, background: '#fff',
                      border: '1px solid #d1d5db', borderRadius: 6, cursor: 'pointer', color: '#374151',
                    }}
                  >
                    Close
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tab bar ──────────────────────────────────────────────────────────────────

type TabId = 'landing-zone' | 'documents' | 'ingestion-jobs' | 'configuration';

const TABS: { id: TabId; label: string }[] = [
  { id: 'landing-zone',    label: 'Landing Zone' },
  { id: 'documents',       label: 'Documents' },
  { id: 'ingestion-jobs',  label: 'Ingestion Jobs' },
  { id: 'configuration',   label: 'Configuration' },
];

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

// ─── Tab content ──────────────────────────────────────────────────────────────

function LandingZoneTab({ kb }: { kb: KbRegistryEntry }) {
  return (
    <Card padding="md">
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>Landing Zone</h3>
      <div style={{ marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginRight: 8 }}>S3 Prefix</span>
        <code
          style={{
            fontSize: 12,
            fontFamily: 'monospace',
            background: 'var(--color-surface-raised, #f3f4f6)',
            padding: '3px 8px',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)',
          }}
        >
          {kb.s3Prefix}
        </code>
      </div>
      <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', margin: 0 }}>
        Upload documents to this S3 prefix then click "Sync Now" to ingest them.
      </p>
    </Card>
  );
}

function DocumentsTab({ kb }: { kb: KbRegistryEntry }) {
  const { data } = useFetch<{ documents: { id: string; title: string | null; source: string | null; ingestedAt: string | null }[]; total: number }>(
    kb.bedrockKbId ? `/api/admin/kb-registry/${kb.id}/docs?limit=50` : null,
  );

  return (
    <Card padding="md">
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>Documents</h3>
      {kb.docCount !== undefined && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{kb.docCount.toLocaleString()}</span>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginLeft: 6 }}>documents ingested</span>
        </div>
      )}
      {data?.documents && data.documents.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.documents.map(doc => (
            <div
              key={doc.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '6px 10px', background: 'var(--color-surface-raised, #f9fafb)',
                border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
              }}
            >
              <div>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{doc.title ?? doc.source ?? doc.id}</div>
                {doc.source && <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontFamily: 'monospace' }}>{doc.source}</div>}
              </div>
              {doc.ingestedAt && (
                <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                  {formatDate(doc.ingestedAt)}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', margin: 0 }}>
          {!kb.bedrockKbId ? 'KB not yet provisioned.' : 'No documents ingested yet.'}
        </p>
      )}
    </Card>
  );
}

function IngestionJobsTab({ kb }: { kb: KbRegistryEntry }) {
  const { data } = useFetch<{
    jobs: {
      jobId: string;
      status: string;
      startedAt: string;
      updatedAt: string;
      description: string;
      documentsIndexed: number;
      documentsFailed: number;
    }[];
  }>(kb.bedrockKbId ? `/api/admin/kb-registry/${kb.id}/jobs` : null);

  if (!kb.bedrockKbId) {
    return (
      <Card padding="md">
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          KB not yet provisioned — no ingestion jobs.
        </div>
      </Card>
    );
  }

  if (!data?.jobs?.length) {
    return (
      <Card padding="md">
        <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
          No ingestion jobs found.
        </div>
      </Card>
    );
  }

  return (
    <Card padding="md">
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 14px' }}>Ingestion Jobs</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.jobs.map(job => (
          <div
            key={job.jobId}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 12px', background: 'var(--color-surface-raised, #f9fafb)',
              border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Chip
                  tone={job.status === 'COMPLETE' ? 'success' : job.status === 'FAILED' ? 'danger' : 'warning'}
                  size="xs"
                >
                  {job.status}
                </Chip>
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-tertiary)' }}>
                  {job.jobId.slice(0, 8)}…
                </span>
              </div>
              {job.description && (
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>{job.description}</div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {job.documentsIndexed} indexed{job.documentsFailed > 0 ? `, ${job.documentsFailed} failed` : ''}
              </div>
              <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
                {formatDate(job.startedAt)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ConfigurationTab({ kb }: { kb: KbRegistryEntry }) {
  const rows: { label: string; value: string }[] = [
    { label: 'ID',                value: kb.id },
    { label: 'Slug',              value: kb.slug },
    { label: 'Aurora Table',      value: kb.auroraTable },
    { label: 'Bedrock KB ID',     value: kb.bedrockKbId ?? '—' },
    { label: 'Data Source ID',    value: kb.dataSourceId ?? '—' },
    { label: 'Embedding Model',   value: kb.embeddingModel },
    { label: 'Chunking Strategy', value: kb.chunkingStrategy },
    { label: 'Max Tokens',        value: String(kb.maxTokens) },
    { label: 'S3 Prefix',         value: kb.s3Prefix },
    { label: 'Created At',        value: formatDate(kb.createdAt) },
    { label: 'Updated At',        value: formatDate(kb.updatedAt) },
  ];

  return (
    <Card padding="md">
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 14px' }}>Configuration</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          rowGap: 10,
          columnGap: 24,
        }}
      >
        {rows.map(({ label, value }) => (
          <>
            <div
              key={`${label}-lbl`}
              style={{ fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 500, paddingTop: 1 }}
            >
              {label}
            </div>
            <div
              key={`${label}-val`}
              style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--color-text-primary)', wordBreak: 'break-all' }}
            >
              {value}
            </div>
          </>
        ))}
      </div>
    </Card>
  );
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface)',
      }}
    >
      <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-primary)' }}>
        {value}
      </span>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function KBDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<TabId>('landing-zone');
  const [reprovisionOpen, setReprovisionOpen] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Poll more frequently when CREATING or PENDING so status updates quickly
  const { data, isLoading, error, refresh } = useFetch<{ kb: KbRegistryEntry }>(
    id ? `/api/admin/kb-registry/${id}` : null,
    10_000,
  );

  const kb = data?.kb;

  if (isLoading && !kb) {
    return (
      <PageSection title="Knowledge Base">
        <Card padding="md">
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            Loading…
          </div>
        </Card>
      </PageSection>
    );
  }

  if (error || !kb) {
    return (
      <PageSection title="Knowledge Base">
        <Card padding="md">
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            {error ?? `No knowledge base found with id `}
            <code style={{ fontFamily: 'monospace' }}>{id}</code>.
            <div style={{ marginTop: 12 }}>
              <button
                onClick={() => navigate('/admin/knowledge-bases')}
                style={{ fontSize: 12, cursor: 'pointer', color: '#2563eb', background: 'none', border: 'none', textDecoration: 'underline' }}
              >
                ← Back to Knowledge Bases
              </button>
            </div>
          </div>
        </Card>
      </PageSection>
    );
  }

  const canProvision = ['PENDING', 'FAILED'].includes(kb.status);
  const canSync = kb.status === 'ACTIVE' && !!kb.bedrockKbId && !!kb.dataSourceId;

  async function handleSync() {
    setSyncLoading(true);
    setSyncError(null);
    try {
      const res = await fetch(`/api/admin/kb-registry/${kb!.id}/sync`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setSyncError(body.error ?? `HTTP ${res.status}`);
      } else {
        refresh();
      }
    } catch {
      setSyncError('Network error');
    } finally {
      setSyncLoading(false);
    }
  }

  return (
    <PageSection title={kb.name}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/admin/knowledge-bases')}
            title="Back to Knowledge Bases"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 28,
              height: 28,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-surface)',
              cursor: 'pointer',
              fontSize: 14,
              color: 'var(--color-text-secondary)',
              flexShrink: 0,
            }}
          >
            ←
          </button>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 10 }}>
              {kb.name}
              <StatusChip status={kb.status} />
            </h2>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: 0 }}>
              {kb.description}
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {canProvision && (
            <button
              onClick={() => setReprovisionOpen(true)}
              style={{
                fontSize: 13,
                fontWeight: 600,
                padding: '7px 16px',
                background: kb.status === 'FAILED' ? '#dc2626' : '#475569',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              {kb.status === 'FAILED' ? 'Re-provision' : 'Provision'}
            </button>
          )}
          {/* Delete for non-ACTIVE KBs */}
          {kb.status !== 'ACTIVE' && (
            <DeleteButton
              kbId={kb.id}
              kbName={kb.name}
              variant="full"
              onDone={() => navigate('/admin/knowledge-bases')}
            />
          )}
          {canSync && (
            <div>
              <button
                disabled={syncLoading}
                onClick={handleSync}
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  padding: '7px 16px',
                  background: syncLoading ? '#93c5fd' : 'var(--color-primary)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  cursor: syncLoading ? 'not-allowed' : 'pointer',
                }}
              >
                {syncLoading ? 'Starting…' : 'Sync Now'}
              </button>
              {syncError && (
                <div style={{ fontSize: 10, color: '#dc2626', marginTop: 2 }}>{syncError}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Error banner for FAILED status */}
      {kb.status === 'FAILED' && kb.errorMessage && (
        <div
          style={{
            marginBottom: 14,
            padding: '8px 14px',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            fontSize: 12,
            color: '#dc2626',
          }}
        >
          <strong>Provisioning failed:</strong> {kb.errorMessage}
        </div>
      )}

      {/* Info pills row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <Chip tone={kb.tenant === 'orgiq' ? 'success' : 'warning'} size="xs">
          {kb.tenant}
        </Chip>
        <InfoPill label="Purpose"        value={kb.purpose} />
        <InfoPill label="Bedrock KB ID"  value={kb.bedrockKbId ?? '—'} />
        <InfoPill label="Aurora Table"   value={kb.auroraTable} />
        <InfoPill label="Embedding"      value={kb.embeddingModel.replace('amazon.', '').replace(':0', '')} />
        <InfoPill label="Chunking"       value={`${kb.chunkingStrategy} / ${kb.maxTokens} tok`} />
      </div>

      {/* Pipeline chain */}
      <div style={{ marginBottom: 20 }}>
        <PipelineChain kb={kb} />
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={tabBtnStyle(activeTab === tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'landing-zone'   && <LandingZoneTab    kb={kb} />}
      {activeTab === 'documents'      && <DocumentsTab       kb={kb} />}
      {activeTab === 'ingestion-jobs' && <IngestionJobsTab   kb={kb} />}
      {activeTab === 'configuration'  && <ConfigurationTab   kb={kb} />}

      {/* Re-provision modal */}
      {reprovisionOpen && (
        <ReprovisionModal
          kb={kb}
          onClose={() => setReprovisionOpen(false)}
          onComplete={() => { setReprovisionOpen(false); refresh(); }}
        />
      )}
    </PageSection>
  );
}

export default KBDetailPage;
