import { useState } from 'react';
import {
  Banner,
  Button,
  Card,
  CardHeader,
  Chip,
  ConfirmDialog,
  FormField,
  IconButton,
  Inline,
  InlinePlaceholder,
  Input,
  LoadingState,
  MetaLine,
  Modal,
  PageSection,
  SectionLabel,
  Select,
  Stack,
  StatStrip,
  Switch,
  Table,
  TableBody,
  TableHead,
  TableRow,
  TableTd,
  TableTh,
  Textarea,
  useToast, T,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { writeJson } from '../../lib/writeJson';
import { Link } from 'react-router';

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
const PII_ACTION_OPTIONS = PII_ACTIONS.map(a => ({ value: a, label: a }));

// ─── Page ─────────────────────────────────────────────────────────────────────

function GuardrailsPage() {
  const { data: guardrail, refresh } = useFetch<Guardrail>('/api/capabilities/guardrail', 30000);
  const { data: metrics } = useFetch<GuardrailMetrics>('/api/capabilities/guardrail/metrics?hours=6', 60000);
  // Guardrail mutations are Cedar's EditGuardrail; without it the page is a
  // read-only view of the same config.
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('EditGuardrail');

  const { toast } = useToast();

  const [newTopic, setNewTopic] = useState({ name: '', definition: '' });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<DeniedTopic | null>(null);
  const [editingDef, setEditingDef] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DeniedTopic | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function patchPii(type: string, patch: { action?: PiiAction; enabled?: boolean }) {
    const res = await writeJson(`/api/capabilities/guardrail/pii`, 'PATCH', { type, ...patch });
    if (!res.ok) {
      console.error(new Error(`PATCH /pii failed: ${res.status}`));
      toast(`Failed to update PII filter ${type}`, { type: 'error' });
      refresh(); // restore prior value by re-reading
      return;
    }
    toast(`PII filter ${type} updated`, { type: 'success' });
    refresh();
  }

  async function patchTopicEnabled(name: string, enabled: boolean) {
    const res = await writeJson(`/api/capabilities/guardrail/topics/${encodeURIComponent(name)}`, 'PATCH', { enabled });
    if (!res.ok) {
      console.error(new Error(`PATCH /topics/${name} failed: ${res.status}`));
      toast(`Failed to update topic ${name}`, { type: 'error' });
      refresh();
      return;
    }
    toast(`Topic ${name} ${enabled ? 'enabled' : 'disabled'}`, { type: 'success' });
    refresh();
  }

  async function addTopic() {
    if (!newTopic.name.trim() || !newTopic.definition.trim()) return;
    setAdding(true);
    const res = await writeJson('/api/capabilities/guardrail/topics', 'POST', newTopic);
    if (!res.ok) {
      console.error(new Error(`POST /topics failed: ${res.status}`));
      toast('Failed to add topic', { type: 'error' });
      setAdding(false);
      return;
    }
    toast(`Topic "${newTopic.name}" added`, { type: 'success' });
    setNewTopic({ name: '', definition: '' });
    refresh();
    setAdding(false);
  }

  function openEdit(topic: DeniedTopic) {
    setEditing(topic);
    setEditingDef(topic.definition);
  }

  async function saveEdit() {
    if (!editing) return;
    setSavingEdit(true);
    const res = await writeJson(`/api/capabilities/guardrail/topics/${encodeURIComponent(editing.name)}`, 'PATCH', { definition: editingDef });
    if (!res.ok) {
      console.error(new Error(`PATCH /topics/${editing.name} failed: ${res.status}`));
      toast('Failed to update topic', { type: 'error' });
      setSavingEdit(false);
      return;
    }
    toast(`Topic "${editing.name}" updated`, { type: 'success' });
    setEditing(null);
    refresh();
    setSavingEdit(false);
  }

  async function doDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    const res = await writeJson(`/api/capabilities/guardrail/topics/${encodeURIComponent(confirmDelete.name)}`, 'DELETE');
    if (!res.ok) {
      console.error(new Error(`DELETE /topics/${confirmDelete.name} failed: ${res.status}`));
      toast('Failed to remove topic', { type: 'error' });
      setDeleting(false);
      return;
    }
    toast(`Topic "${confirmDelete.name}" removed`, { type: 'success' });
    setConfirmDelete(null);
    refresh();
    setDeleting(false);
  }

  if (!guardrail) {
    return <LoadingState label="Loading guardrail…" testId="guardrails-page-loading" />;
  }

  return (
    <>
    <Stack gap="lg" data-testid="guardrails-page">
      {/* Naming it matters. Three role guardrails exist (member, org leader,
          HR admin) and all three rows on Capabilities drill in HERE, but this
          editor reads and writes the single configured GUARDRAIL_ID — so
          someone arriving from the org-leader row could edit a different
          resource than the one they clicked, on a safety control. Saying which
          one is open does not close that gap, but it stops the page from
          quietly implying it is per-role. */}
      <Banner variant="warning" data-testid="guardrails-live-banner">
        {`Changes apply immediately to the live DRAFT of ${guardrail.name}. Per-role guardrails (member, org leader, HR admin) are separate resources and are not edited here — `}
        <Link to="/admin/capabilities" className="text-primary no-underline hover:underline">Capabilities</Link>
        {' lists which id each role uses.'}
      </Banner>

        {/* Status + metrics — wrapped in a single Card per spec */}
        <Card padding="none" className="overflow-hidden" data-testid="guardrails-status-card">
          <CardHeader inset
            title={guardrail.name}
            subtitle={`v${guardrail.version} · Updated ${new Date(guardrail.updatedAt).toLocaleString()}`}
            action={<Chip tone={guardrail.status === 'READY' ? 'success' : 'warning'} size="xs">{guardrail.status}</Chip>}
          />
          <Stack gap="md" className="px-3.5 py-3">
            <StatStrip
              variant="line"
              items={[
                { label: 'grounding threshold', value: `${(guardrail.groundingThreshold * 100).toFixed(0)}%` },
                { label: 'relevance threshold', value: `${(guardrail.relevanceThreshold * 100).toFixed(0)}%` },
                { label: 'invocations (6h)', value: metrics?.totalInvocations ?? 0 },
                { label: 'interventions (6h)', value: metrics?.totalInterventions ?? 0, tone: (metrics?.totalInterventions ?? 0) > 0 ? 'danger' : 'default' },
                { label: 'intervention rate (6h)', value: `${metrics?.interventionRate ?? '0.0'}%` },
              ]}
            />
            <Stack gap="xs">
              <SectionLabel as="div">Activity (last 6h) · from AWS/Bedrock metrics</SectionLabel>
              {/* NOTE: lib Sparkline is single-series; we need 2 overlaid series so we keep this SVG renderer. */}
              <MetricsSparkline series={metrics?.series ?? []} />
            </Stack>
          </Stack>
        </Card>

        {/* PII Filters */}
        <PageSection title="PII Filters" description="Per-entity action (BLOCK | ANONYMIZE | NONE) and on/off toggle.">
          <Card padding="md" data-testid="pii-filters-card">
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
                    <TableTd >{filter.type}</TableTd>
                    <TableTd>
                      {canEdit ? (
                        <Select
                          aria-label={`Action for ${filter.type}`}
                          data-testid={`pii-action-${filter.type}`}
                          value={filter.action}
                          onChange={e => patchPii(filter.type, { action: e.target.value as PiiAction })}
                          options={PII_ACTION_OPTIONS}
                          size="sm"
                        />
                      ) : (
                        <T size="xs">{filter.action}</T>
                      )}
                    </TableTd>
                    <TableTd>
                      {canEdit ? (
                        <Switch
                          checked={filter.enabled}
                          onChange={v => patchPii(filter.type, { enabled: v })}
                          aria-label={`Toggle PII filter ${filter.type}`}
                          data-testid={`pii-switch-${filter.type}`}
                        />
                      ) : (
                        <Chip tone={filter.enabled ? 'success' : 'neutral'} size="xs">
                          {filter.enabled ? 'on' : 'off'}
                        </Chip>
                      )}
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
            <Inline gap="sm" wrap>
              {Object.entries(guardrail.contentPolicy).map(([key, enabled]) => (
                <Chip
                  key={key}
                  tone={enabled ? 'success' : 'neutral'}
                  size="xs"
                >
                  {key.replace('Enabled', '')}
                </Chip>
              ))}
            </Inline>
          </Card>
        </PageSection>

        {/* Denied Topics */}
        <PageSection title="Denied Topics" description="Topics the guardrail will refuse to discuss.">
          <Card padding="md" data-testid="denied-topics-card">
            {canEdit && (
              <Card padding="sm" className="mb-4 bg-surface-hover" data-testid="topic-add-form">
                <Stack gap="sm">
                  {/* FormField hands its render prop a `labelId` that is not a
                      DOM attribute (queue: FormField `labelId` DOM leak) — dropped
                      before the spread, here and below, or React warns on render. */}
                  <FormField label="Topic name">
                    {({ labelId: _labelId, ...p }) => (
                      <Input
                        {...p}
                        type="text"
                        value={newTopic.name}
                        onChange={e => setNewTopic(prev => ({ ...prev, name: e.target.value }))}
                        placeholder="e.g. competitor-strategy"
                        data-testid="topic-add-name"
                      />
                    )}
                  </FormField>
                  <FormField label="Definition" hint="What does this topic cover?">
                    {({ labelId: _labelId, ...p }) => (
                      <Textarea
                        {...p}
                        value={newTopic.definition}
                        onChange={e => setNewTopic(prev => ({ ...prev, definition: e.target.value }))}
                        placeholder="A short natural-language description the model will match against."
                        rows={2}
                        data-testid="topic-add-definition"
                      />
                    )}
                  </FormField>
                  <Inline justify="end">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={addTopic}
                      disabled={adding || !newTopic.name.trim() || !newTopic.definition.trim()}
                      data-testid="topic-add-submit"
                    >
                      {adding ? 'Adding…' : 'Add'}
                    </Button>
                  </Inline>
                </Stack>
              </Card>
            )}

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
                    <TableTd className="whitespace-nowrap">{topic.name}</TableTd>
                    <TableTd className="max-w-[360px] truncate text-text-secondary" title={topic.definition}>
                      {topic.definition}
                    </TableTd>
                    <TableTd>
                      {canEdit ? (
                        <Switch
                          checked={topic.enabled}
                          onChange={v => patchTopicEnabled(topic.name, v)}
                          aria-label={`Toggle denied topic ${topic.name}`}
                          data-testid={`topic-switch-${topic.name}`}
                        />
                      ) : (
                        <Chip tone={topic.enabled ? 'success' : 'neutral'} size="xs">
                          {topic.enabled ? 'on' : 'off'}
                        </Chip>
                      )}
                    </TableTd>
                    <TableTd>
                      {canEdit && (
                        <Inline gap="xs" justify="end">
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
                            aria-label={`Delete ${topic.name}`}
                            variant="danger"
                            size="sm"
                            onClick={() => setConfirmDelete(topic)}
                            data-testid={`topic-delete-${topic.name}`}
                          >
                            Delete
                          </IconButton>
                        </Inline>
                      )}
                    </TableTd>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </PageSection>
      </Stack>

      {/* Edit topic definition modal */}
      <Modal
        open={editing !== null}
        onClose={() => (savingEdit ? undefined : setEditing(null))}
        title={editing ? `Edit definition — ${editing.name}` : 'Edit topic'}
        maxWidth={520}
        footer={
          <Inline gap="sm" justify="end">
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
          </Inline>
        }
      >
        <FormField label="Definition" hint="Natural-language description used by the model.">
          {({ labelId: _labelId, ...p }) => (
            <Textarea
              {...p}
              value={editingDef}
              onChange={e => setEditingDef(e.target.value)}
              rows={5}
              data-testid="topic-edit-definition"
            />
          )}
        </FormField>
      </Modal>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmDelete !== null}
        onConfirm={doDelete}
        onCancel={() => (deleting ? undefined : setConfirmDelete(null))}
        title="Delete denied topic?"
        body={
          confirmDelete
            ? `"${confirmDelete.name}" will be deleted from the live guardrail DRAFT immediately.`
            : ''
        }
        confirmLabel={deleting ? 'Deleting…' : 'Delete'}
        cancelLabel="Cancel"
        confirmDisabled={deleting}
        tone="destructive"
      />
    </>
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

  // An all-zero window is not the same as an absent one, and it must not be
  // DRAWN. CloudWatch returns a bucket per interval whether or not anything
  // happened, so a quiet six hours arrived here as a full series of zeros and
  // the renderer dutifully plotted two flat lines along the axis — which reads
  // as a broken chart, not as a quiet guardrail. Only a series with something
  // in it is worth a chart.
  const hasSignal = series.some((p) => p.invocations > 0 || p.interventions > 0);
  if (series.length === 0 || !hasSignal) {
    return (
      <InlinePlaceholder size="sm" align="center">
        {series.length === 0
          ? 'No metrics returned for this window. CloudWatch had nothing to report, which can also mean the guardrail id is not the one being invoked.'
          : 'No invocations in this window. The guardrail is configured and ready; nothing has passed through it.'}
      </InlinePlaceholder>
    );
  }

  return (
    <Stack gap="xs">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block h-20 w-full">
        <polyline fill="none" stroke="var(--color-primary)" strokeWidth="1.5" points={points('invocations')} />
        <polyline fill="none" stroke="var(--color-danger)" strokeWidth="1.5" points={points('interventions')} />
      </svg>
      <MetaLine
        items={[
          <Chip tone="info" dot="static" size="xs">invocations</Chip>,
          <Chip tone="danger" dot="static" size="xs">interventions</Chip>,
        ]}
      />
    </Stack>
  );
}

export default GuardrailsPage;
