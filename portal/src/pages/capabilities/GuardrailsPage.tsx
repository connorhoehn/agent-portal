import { useState } from 'react';
import { Card, Table, TableHead, TableBody, TableRow, TableTh, TableTd, Chip } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PiiFilter {
  type: string;
  action: 'ANONYMIZE' | 'BLOCK';
  enabled: boolean;
}

interface DeniedTopic {
  name: string;
  definition: string;
  enabled: boolean;
}

interface Guardrail {
  id: string;
  name: string;
  status: string;
  version: string;
  updatedAt: string;
  piiFilters: PiiFilter[];
  contentPolicy: Record<string, boolean>;
  deniedTopics: DeniedTopic[];
  groundingThreshold: number;
  relevanceThreshold: number;
}

interface GuardrailMetrics {
  totalInvocations: number;
  totalInterventions: number;
  interventionRate: string;
  series: Array<{ timestamp: string; invocations: number; interventions: number }>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function GuardrailsPage() {
  const { data: guardrail, refresh } = useFetch<Guardrail>('/api/capabilities/guardrail', 30000);
  const { data: metrics } = useFetch<GuardrailMetrics>('/api/capabilities/guardrail/metrics?hours=6', 60000);
  const [newTopic, setNewTopic] = useState({ name: '', definition: '' });
  const [addingTopic, setAddingTopic] = useState(false);
  const [saving, setSaving] = useState(false);

  async function togglePii(type: string, enabled: boolean) {
    await fetch(`/api/capabilities/guardrail/pii`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, enabled }),
    });
    refresh();
  }

  async function toggleTopic(name: string, enabled: boolean) {
    await fetch(`/api/capabilities/guardrail/topics/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    refresh();
  }

  async function removeTopic(name: string) {
    if (!confirm(`Delete denied topic "${name}"? This persists to AWS immediately.`)) return;
    await fetch(`/api/capabilities/guardrail/topics/${encodeURIComponent(name)}`, {
      method: 'DELETE',
    });
    refresh();
  }

  async function addTopic() {
    if (!newTopic.name || !newTopic.definition) return;
    setSaving(true);
    await fetch('/api/capabilities/guardrail/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTopic),
    });
    setNewTopic({ name: '', definition: '' });
    setAddingTopic(false);
    setSaving(false);
    refresh();
  }

  if (!guardrail) {
    return (
      <div style={{ padding: 24 }}>
        <div style={{ color: 'var(--color-text-secondary)' }}>Loading guardrail...</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Status bar */}
        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <span style={{ fontWeight: 600 }}>{guardrail.name}</span>
              <span style={{ marginLeft: 12, fontSize: 12, color: 'var(--color-text-secondary)' }}>
                v{guardrail.version} · Updated {new Date(guardrail.updatedAt).toLocaleString()}
              </span>
            </div>
            <Chip tone={guardrail.status === 'READY' ? 'success' : 'warning'} size="xs">{guardrail.status}</Chip>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>GROUNDING THRESHOLD</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{(guardrail.groundingThreshold * 100).toFixed(0)}%</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>RELEVANCE THRESHOLD</div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{(guardrail.relevanceThreshold * 100).toFixed(0)}%</div>
            </div>
          </div>
        </Card>

        {/* Metrics — last 24h */}
        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
            Activity (last 6h){' '}
            <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--color-text-tertiary)' }}>
              from AWS/Bedrock metrics
            </span>
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>INVOCATIONS</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{metrics?.totalInvocations ?? 0}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>INTERVENTIONS</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{metrics?.totalInterventions ?? 0}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 4 }}>RATE</div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>{metrics?.interventionRate ?? '0.0'}%</div>
            </div>
          </div>
          <MetricsSparkline series={metrics?.series ?? []} />
        </Card>

        {/* PII Filters */}
        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>PII Filters</h2>
          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Type</TableTh>
                <TableTh>Action</TableTh>
                <TableTh>Enabled</TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {guardrail.piiFilters.map(filter => (
                <TableRow key={filter.type}>
                  <TableTd style={{ fontWeight: 500 }}>{filter.type}</TableTd>
                  <TableTd>
                    <Chip tone={filter.action === 'BLOCK' ? 'danger' : 'warning'} size="xs">{filter.action}</Chip>
                  </TableTd>
                  <TableTd>
                    <Toggle value={filter.enabled} onChange={v => togglePii(filter.type, v)} />
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        {/* Content Policy */}
        <Card padding="md">
          <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Content Policy</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(guardrail.contentPolicy).map(([key, enabled]) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-md)' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)', flexShrink: 0 }} />
                <span style={{ fontSize: 12 }}>{key.replace('Enabled', '')}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Denied Topics */}
        <Card padding="md">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>Denied Topics</h2>
            <button
              onClick={() => setAddingTopic(v => !v)}
              style={{ fontSize: 12, padding: '4px 10px', background: 'var(--color-primary)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}
            >
              + Add Topic
            </button>
          </div>

          {addingTopic && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, padding: 12, background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-md)' }}>
              <input
                placeholder="Topic name"
                value={newTopic.name}
                onChange={e => setNewTopic(p => ({ ...p, name: e.target.value }))}
                style={{ flex: '0 0 160px', padding: '6px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
              />
              <input
                placeholder="Definition / description"
                value={newTopic.definition}
                onChange={e => setNewTopic(p => ({ ...p, definition: e.target.value }))}
                style={{ flex: 1, padding: '6px 10px', fontSize: 12, border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface)' }}
              />
              <button
                onClick={addTopic}
                disabled={saving}
                style={{ padding: '6px 12px', fontSize: 12, background: 'var(--color-success)', color: '#fff', border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
              >
                Save
              </button>
            </div>
          )}

          <Table>
            <TableHead>
              <TableRow>
                <TableTh>Topic</TableTh>
                <TableTh>Definition</TableTh>
                <TableTh>Enabled</TableTh>
                <TableTh></TableTh>
              </TableRow>
            </TableHead>
            <TableBody>
              {guardrail.deniedTopics.map(topic => (
                <TableRow key={topic.name}>
                  <TableTd style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{topic.name}</TableTd>
                  <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{topic.definition}</TableTd>
                  <TableTd>
                    <Toggle value={topic.enabled} onChange={v => toggleTopic(topic.name, v)} />
                  </TableTd>
                  <TableTd>
                    <button
                      onClick={() => removeTopic(topic.name)}
                      aria-label={`Remove ${topic.name}`}
                      style={{ fontSize: 11, padding: '2px 8px', background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                    >
                      Remove
                    </button>
                  </TableTd>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      </div>
    </div>
  );
}

// ─── Local helpers ────────────────────────────────────────────────────────────

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      style={{
        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', padding: 0, position: 'relative',
        background: value ? 'var(--color-success, #16a34a)' : 'var(--color-border, #e2e8f0)',
        transition: 'background 0.15s',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: value ? 19 : 3, width: 14, height: 14,
        borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
      }} />
    </button>
  );
}

function MetricsSparkline({ series }: { series: Array<{ timestamp: string; invocations: number; interventions: number }> }) {
  const width = 600;
  const height = 80;
  const padding = 4;
  const maxVal = Math.max(1, ...series.map(p => Math.max(p.invocations, p.interventions)));
  const points = (key: 'invocations' | 'interventions') =>
    series.map((p, i) => {
      const x = padding + (i / Math.max(series.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - (p[key] / maxVal) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

  if (series.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 20, color: 'var(--color-text-tertiary)', fontSize: 12 }}>
        No metrics yet — guardrail hasn't been invoked recently.
      </div>
    );
  }

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: 80, display: 'block' }}>
        <polyline fill="none" stroke="var(--color-primary, #6366f1)" strokeWidth="1.5" points={points('invocations')} />
        <polyline fill="none" stroke="#dc2626" strokeWidth="1.5" points={points('interventions')} />
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 4 }}>
        <span><span style={{ display: 'inline-block', width: 8, height: 2, background: 'var(--color-primary, #6366f1)', marginRight: 4, verticalAlign: 'middle' }} />invocations</span>
        <span><span style={{ display: 'inline-block', width: 8, height: 2, background: '#dc2626', marginRight: 4, verticalAlign: 'middle' }} />interventions</span>
      </div>
    </div>
  );
}

export default GuardrailsPage;
