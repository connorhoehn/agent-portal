// TODO(Wave 3-C): replace MOCK_KBS lookup with a real useFetch(`/api/admin/knowledge-bases/${id}`, 30_000)
//   and wire the "Sync Now" button to POST /api/admin/knowledge-bases/:id/sync.

import { useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  PageSection,
  Card,
  Chip,
} from '@connorhoehnslalom/ui-components/shared';
import { MOCK_KBS, type KbRegistryEntry } from './KBRegistryPage';

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

// ─── Pipeline Chain ───────────────────────────────────────────────────────────

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
  const cfg = STATUS_CONFIG[kb.status] ?? STATUS_CONFIG.PENDING;

  return (
    <Card padding="md">
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 14px' }}>Pipeline Chain</h3>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <PipelineNode
          label="S3 Landing Zone"
          value={kb.s3Prefix}
          dotColor={cfg.dotColor}
        />
        <Arrow />
        <PipelineNode
          label="Data Source"
          value={kb.dataSourceId ?? '(not provisioned)'}
          dotColor={kb.dataSourceId ? cfg.dotColor : '#9ca3af'}
        />
        <Arrow />
        <PipelineNode
          label="Bedrock KB"
          value={kb.bedrockKbId ?? '(not provisioned)'}
          dotColor={kb.bedrockKbId ? cfg.dotColor : '#9ca3af'}
        />
        <Arrow />
        <PipelineNode
          label="Agents"
          value="search · advisor"
          dotColor={kb.status === 'ACTIVE' ? cfg.dotColor : '#9ca3af'}
        />
      </div>
    </Card>
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

function PlaceholderCard({ children }: { children: React.ReactNode }) {
  return (
    <Card padding="md">
      <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
        {children}
      </div>
    </Card>
  );
}

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
        File browser coming in Wave 2-B
      </p>
    </Card>
  );
}

function DocumentsTab({ kb }: { kb: KbRegistryEntry }) {
  return (
    <Card padding="md">
      <h3 style={{ fontSize: 13, fontWeight: 600, margin: '0 0 12px' }}>Documents</h3>
      {kb.docCount !== undefined && (
        <div style={{ marginBottom: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{kb.docCount.toLocaleString()}</span>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginLeft: 6 }}>documents ingested</span>
        </div>
      )}
      <p style={{ fontSize: 12, color: 'var(--color-text-tertiary)', margin: 0 }}>
        Document list coming in Wave 3-C
      </p>
    </Card>
  );
}

function IngestionJobsTab() {
  return (
    <PlaceholderCard>
      Job history coming in Wave 3-C
    </PlaceholderCard>
  );
}

function ConfigurationTab({ kb }: { kb: KbRegistryEntry }) {
  const rows: { label: string; value: string }[] = [
    { label: 'Slug',             value: kb.slug },
    { label: 'Aurora Table',     value: kb.auroraTable },
    { label: 'Embedding Model',  value: kb.embeddingModel },
    { label: 'Chunking Strategy',value: kb.chunkingStrategy },
    { label: 'Max Tokens',       value: String(kb.maxTokens) },
    { label: 'S3 Prefix',        value: kb.s3Prefix },
    { label: 'Created At',       value: formatDate(kb.createdAt) },
    { label: 'Updated At',       value: formatDate(kb.updatedAt) },
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

  const kb = MOCK_KBS.find(k => k.id === id);

  if (!kb) {
    return (
      <PageSection title="Knowledge Base">
        <Card padding="md">
          <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--color-text-tertiary)', fontSize: 13 }}>
            No knowledge base found with id <code style={{ fontFamily: 'monospace' }}>{id}</code>.
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

        <button
          disabled
          title="Coming in Wave 3-C"
          onClick={() => console.log('Sync Now — not yet implemented', kb.id)}
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
          Sync Now
        </button>
      </div>

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
      {activeTab === 'landing-zone'   && <LandingZoneTab   kb={kb} />}
      {activeTab === 'documents'      && <DocumentsTab      kb={kb} />}
      {activeTab === 'ingestion-jobs' && <IngestionJobsTab  />}
      {activeTab === 'configuration'  && <ConfigurationTab  kb={kb} />}
    </PageSection>
  );
}

export default KBDetailPage;
