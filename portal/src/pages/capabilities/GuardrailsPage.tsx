import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  FormField,
  IconButton,
  Modal,
  PageSection,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
  useToast,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

// ─── Types ────────────────────────────────────────────────────────────────────

type PiiAction = 'ANONYMIZE' | 'BLOCK' | 'NONE';

interface PiiFilter {
  type: string;
  action: PiiAction;
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

const PII_ACTIONS: PiiAction[] = ['BLOCK', 'ANONYMIZE', 'NONE'];

// ─── Page ─────────────────────────────────────────────────────────────────────

function GuardrailsPage() {
  const { data: guardrail, refresh } = useFetch<Guardrail>('/api/capabilities/guardrail', 30000);
  const { data: metrics } = useFetch<GuardrailMetrics>('/api/capabilities/guardrail/metrics?hours=6', 60000);

  const { toast } = useToast();

  const [newTopic, setNewTopic] = useState({ name: '', definition: '' });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DeniedTopic | null>(null);
  const [editingDef, setEditingDef] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DeniedTopic | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function patchPii(type: string, patch: { action?: PiiAction; enabled?: boolean }) {
    try {
      const res = await fetch(`/api/capabilities/guardrail/pii`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...patch }),
      });
      if (!res.ok) throw new Error(`PATCH /pii failed: ${res.status}`);
      toast(`PII filter ${type} updated`, { type: 'success' });
      refresh();
    } catch (err) {
      console.error(err);
      toast(`Failed to update PII filter ${type}`, { type: 'error' });
      refresh(); // restore prior value by re-reading
    }
  }

  async function patchTopicEnabled(name: string, enabled: boolean) {
    try {
      const res = await fetch(
        `/api/capabilities/guardrail/topics/${encodeURIComponent(name)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled }),
        },
      );
      if (!res.ok) throw new Error(`PATCH /topics/${name} failed: ${res.status}`);
      toast(`Topic ${name} ${enabled ? 'enabled' : 'disabled'}`, { type: 'success' });
      refresh();
    } catch (err) {
      console.error(err);
      toast(`Failed to update topic ${name}`, { type: 'error' });
      refresh();
    }
  }

  async function addTopic() {
    if (!newTopic.name.trim() || !newTopic.definition.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/capabilities/guardrail/topics', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newTopic),
      });
      if (!res.ok) throw new Error(`POST /topics failed: ${res.status}`);
      toast(`Topic "${newTopic.name}" added`, { type: 'success' });
      setNewTopic({ name: '', definition: '' });
      refresh();
    } catch (err) {
      console.error(err);
      toast('Failed to add topic', { type: 'error' });
    } finally {
      setAdding(false);
    }
  }

  function openEdit(topic: DeniedTopic) {
    setEditing(topic);
    setEditingDef(topic.definition);
  }

  async function saveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    try {
      const res = await fetch(
        `/api/capabilities/guardrail/topics/${encodeURIComponent(editing.name)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ definition: editingDef }),
        },
      );
      if (!res.ok) throw new Error(`PATCH /topics/${editing.name} failed: ${res.status}`);
      toast(`Topic "${editing.name}" updated`, { type: 'success' });
      setEditing(null);
      refresh();
    } catch (err) {
      console.error(err);
      toast('Failed to update topic', { type: 'error' });
    } finally {
      setSavingEdit(false);
    }
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/capabilities/guardrail/topics/${encodeURIComponent(confirmDelete.name)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) throw new Error(`DELETE /topics/${confirmDelete.name} failed: ${res.status}`);
      toast(`Topic "${confirmDelete.name}" removed`, { type: 'success' });
      setConfirmDelete(null);
      refresh();
    } catch (err) {
      console.error(err);
      toast('Failed to remove topic', { type: 'error' });
    } finally {
      setDeleting(false);
    }
  }

  if (!guardrail) {
    return (
      <div style={{ padding: 24 }} data-testid="guardrails-page-loading">
        <div style={{ color: 'var(--color-text-secondary)' }}>Loading guardrail...</div>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }} data-testid="guardrails-page">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <Banner variant="warning" data-testid="guardrails-live-banner">
          Changes apply to the live guardrail DRAFT immediately.
        </Banner>

        {/* Status + metrics — wrapped in a single Card per spec */}
        <Card padding="md" data-testid="guardrails-status-card">
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

          <div style={{ marginTop: 20 }}>
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
            {/* NOTE: lib Sparkline is single-series; we need 2 overlaid series so we keep this SVG renderer. */}
            <MetricsSparkline series={metrics?.series ?? []} />
          </div>
        </Card>

        {/* PII Filters */}
        <PageSection title="PII Filters" description="Per-entity action (BLOCK | ANONYMIZE | NONE) and on/off toggle.">
          <Card padding="md" data-testid="pii-filters-card">
            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Type</TableTh>
                  <TableTh>Status</TableTh>
                  <TableTh>Action</TableTh>
                  <TableTh>Enabled</TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {guardrail.piiFilters.map(filter => (
                  <TableRow key={filter.type}>
                    <TableTd style={{ fontWeight: 500 }}>{filter.type}</TableTd>
                    <TableTd>
                      <Chip
                        tone={filter.enabled ? 'success' : 'neutral'}
                        size="xs"
                      >
                        {filter.enabled ? 'on' : 'off'}
                      </Chip>
                    </TableTd>
                    <TableTd>
                      <select
                        aria-label={`Action for ${filter.type}`}
                        data-testid={`pii-action-${filter.type}`}
                        value={filter.action}
                        onChange={e => patchPii(filter.type, { action: e.target.value as PiiAction })}
                        style={{
                          fontSize: 12,
                          padding: '4px 8px',
                          border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--color-surface)',
                        }}
                      >
                        {PII_ACTIONS.map(a => (
                          <option key={a} value={a}>{a}</option>
                        ))}
                      </select>
                    </TableTd>
                    <TableTd>
                      <Switch
                        checked={filter.enabled}
                        onChange={v => patchPii(filter.type, { enabled: v })}
                        aria-label={`Toggle PII filter ${filter.type}`}
                        data-testid={`pii-switch-${filter.type}`}
                      />
                    </TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </PageSection>

        {/* Content Policy — view-only.
            TODO(backend): no PATCH route exists for content-policy categories
            yet (middleware/src/providers/guardrails.ts only ships getGuardrail
            here). When a mutation is added, replace this chip strip with a
            Switch column mirroring the PII filter table. */}
        <PageSection title="Content Policy" description="View-only. Mutation API not yet available.">
          <Card padding="md" data-testid="content-policy-card">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {Object.entries(guardrail.contentPolicy).map(([key, enabled]) => (
                <Chip
                  key={key}
                  tone={enabled ? 'success' : 'neutral'}
                  size="xs"
                >
                  {key.replace('Enabled', '')}
                </Chip>
              ))}
            </div>
          </Card>
        </PageSection>

        {/* Denied Topics */}
        <PageSection title="Denied Topics" description="Topics the guardrail will refuse to discuss.">
          <Card padding="md" data-testid="denied-topics-card">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '200px 1fr auto',
                gap: 12,
                alignItems: 'end',
                marginBottom: 16,
                padding: 12,
                background: 'var(--color-surface-hover)',
                borderRadius: 'var(--radius-md)',
              }}
              data-testid="topic-add-form"
            >
              <FormField label="Topic name">
                {p => (
                  <input
                    {...p}
                    type="text"
                    value={newTopic.name}
                    onChange={e => setNewTopic(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g. competitor-strategy"
                    data-testid="topic-add-name"
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-surface)',
                    }}
                  />
                )}
              </FormField>
              <FormField label="Definition" hint="What does this topic cover?">
                {p => (
                  <textarea
                    {...p}
                    value={newTopic.definition}
                    onChange={e => setNewTopic(prev => ({ ...prev, definition: e.target.value }))}
                    placeholder="A short natural-language description the model will match against."
                    rows={2}
                    data-testid="topic-add-definition"
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--color-surface)',
                      resize: 'vertical',
                      fontFamily: 'inherit',
                    }}
                  />
                )}
              </FormField>
              <Button
                variant="primary"
                size="sm"
                onClick={addTopic}
                disabled={adding || !newTopic.name.trim() || !newTopic.definition.trim()}
                data-testid="topic-add-submit"
              >
                {adding ? 'Adding…' : 'Add'}
              </Button>
            </div>

            <Table>
              <TableHead>
                <TableRow>
                  <TableTh>Topic</TableTh>
                  <TableTh>Definition</TableTh>
                  <TableTh>Enabled</TableTh>
                  <TableTh aria-label="Actions"></TableTh>
                </TableRow>
              </TableHead>
              <TableBody>
                {guardrail.deniedTopics.map(topic => (
                  <TableRow key={topic.name} data-testid={`topic-row-${topic.name}`}>
                    <TableTd style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{topic.name}</TableTd>
                    <TableTd style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{topic.definition}</TableTd>
                    <TableTd>
                      <Switch
                        checked={topic.enabled}
                        onChange={v => patchTopicEnabled(topic.name, v)}
                        aria-label={`Toggle denied topic ${topic.name}`}
                        data-testid={`topic-switch-${topic.name}`}
                      />
                    </TableTd>
                    <TableTd>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <IconButton
                          aria-label={`Edit definition for ${topic.name}`}
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(topic)}
                          data-testid={`topic-edit-${topic.name}`}
                        >
                          Edit
                        </IconButton>
                        <IconButton
                          aria-label={`Remove ${topic.name}`}
                          variant="danger"
                          size="sm"
                          onClick={() => setConfirmDelete(topic)}
                          data-testid={`topic-delete-${topic.name}`}
                        >
                          Remove
                        </IconButton>
                      </div>
                    </TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </PageSection>
      </div>

      {/* Edit topic definition modal */}
      <Modal
        open={editing !== null}
        onClose={() => (savingEdit ? undefined : setEditing(null))}
        title={editing ? `Edit definition — ${editing.name}` : 'Edit topic'}
        maxWidth={520}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)} disabled={savingEdit}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={saveEdit}
              disabled={savingEdit || !editingDef.trim()}
              data-testid="topic-edit-save"
            >
              {savingEdit ? 'Saving…' : 'Save'}
            </Button>
          </div>
        }
      >
        <FormField label="Definition" hint="Natural-language description used by the model.">
          {p => (
            <textarea
              {...p}
              value={editingDef}
              onChange={e => setEditingDef(e.target.value)}
              rows={5}
              data-testid="topic-edit-definition"
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--color-surface)',
                resize: 'vertical',
                fontFamily: 'inherit',
              }}
            />
          )}
        </FormField>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmDelete !== null}
        onConfirm={doDelete}
        onCancel={() => (deleting ? undefined : setConfirmDelete(null))}
        title="Remove denied topic?"
        body={
          confirmDelete
            ? `"${confirmDelete.name}" will be removed from the live guardrail DRAFT immediately.`
            : ''
        }
        confirmLabel={deleting ? 'Removing…' : 'Remove'}
        cancelLabel="Cancel"
        confirmDisabled={deleting}
        tone="destructive"
      />
    </div>
  );
}

// ─── Local helpers ────────────────────────────────────────────────────────────

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
