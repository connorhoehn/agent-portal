import { useMemo, useState } from 'react';
import {
  T,
  Button,
  Card,
  CardHeader,
  Chip,
  CodeEditor,
  CollapsibleSection,
  ConfirmDialog,
  FormField,
  Inline,
  InlineAlert,
  Input,
  LoadingState,
  PageSection,
  RadioGroup,
  SegmentedControl,
  Select,
  Stack,
  TagEditor,
} from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { KeyValue } from '../../components/KeyValue';
import { parsePolicy, buildPolicy, type Effect, type ParsedPolicy } from '../../lib/cedarPolicy';
import { effectTone, inputWiring } from './identityFormat';
import { toastError } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { UnavailableNotice } from '../../components/UnavailableNotice';

interface PolicyEntry {
  policyId: string;
  policyType: string;
  createdDate: string;
  lastUpdatedDate?: string;
  description: string;
  statement: string;
}

interface PoliciesResponse {
  policies: PolicyEntry[];
  note?: string;
}

interface SchemaResponse {
  schema: { OrgIQ?: { actions?: Record<string, unknown> } };
}

interface RoleInfo { id: string; tenant: string | null; label: string }

const NO_ROLE_OPTION = { value: '', label: '— No role condition (matches everyone)' };

interface Draft {
  description: string;
  statement: string;          // canonical Cedar source (always kept current)
  mode: 'builder' | 'raw';    // active editor surface
  parsed: ParsedPolicy | null;// builder state, null when policy doesn't fit template
}

function makeDraft(description: string, statement: string): Draft {
  const parsed = parsePolicy(statement);
  return {
    description,
    statement,
    mode: parsed ? 'builder' : 'raw',
    parsed,
  };
}

const NEW_TEMPLATE: ParsedPolicy = {
  effect: 'permit',
  actions: ['Search'],
  role: 'member',
};

function PoliciesPage() {
  // Policy CRUD rides /api/identity/policies (EditPolicy).
  const { can, ready } = useCapabilities();
  const canEdit = ready && can('EditPolicy');
  const { data, isLoading, error, refresh } = useFetch<PoliciesResponse>('/api/identity/policies');
  const { data: schema } = useFetch<SchemaResponse>('/api/identity/schema');
  const allActions = useMemo(
    () => Object.keys(schema?.schema?.OrgIQ?.actions ?? {}).sort(),
    [schema],
  );
  // Every role a `when { principal.role == "…" }` clause could name, not just
  // orgiq's three — the store holds policies for every tenant (GET /policies
  // is store-wide), and a hardcoded list here silently made sme,
  // program-owner, admin and every assessment-tenant role unbuildable from
  // the visual editor. Same gap the sandbox (PolicyTestPage) already fixed.
  const { data: rolesData } = useFetch<RoleInfo[]>('/api/identity/roles');
  const roleOptions = useMemo(
    () => [
      NO_ROLE_OPTION,
      ...(rolesData ?? []).map(r => ({
        value: r.id,
        label: r.tenant ? `${r.label} (${r.tenant})` : `${r.label} (all tenants)`,
      })),
    ],
    [rolesData],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<Draft>(() => makeDraft('', buildPolicy(NEW_TEMPLATE)));
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  if (isLoading) {
    return (
      <PageSection title="Cedar Policies">
        <LoadingState label="Loading policies…" />
      </PageSection>
    );
  }
  if (error) {
    return (
      <PageSection title="Cedar Policies">
        <UnavailableNotice
          error={error}
          what="policies"
          source="Cedar policies are read from Verified Permissions"
          onRetry={() => void refresh()}
        />
      </PageSection>
    );
  }
  if (!data) return null;

  function startEdit(p: PolicyEntry) {
    setDraft(makeDraft(p.description, p.statement));
    setEditingId(p.policyId);
    setErrMsg(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setErrMsg(null);
  }

  async function saveEdit(policyId: string) {
    if (!draft) return;
    setBusy(true); setErrMsg(null);
    const res = await writeJson<{ detail?: string; error?: string }>(`/api/identity/policies/${policyId}`, 'PUT', {
      description: draft.description, statement: draft.statement,
    });
    if (!res.ok) {
      setErrMsg(res.data?.detail ?? res.data?.error ?? `${res.status}`);
    } else {
      cancelEdit();
      await refresh();
    }
    setBusy(false);
  }

  async function deletePolicy(policyId: string) {
    setBusy(true); setErrMsg(null);
    const res = await writeJson(`/api/identity/policies/${policyId}`, 'DELETE');
    if (!res.ok) {
      setErrMsg(`${res.status}`);
    } else {
      await refresh();
    }
    setBusy(false);
  }

  async function createPolicy() {
    setBusy(true); setErrMsg(null);
    const res = await writeJson<{ detail?: string; error?: string }>('/api/identity/policies', 'POST', {
      description: createDraft.description, statement: createDraft.statement,
    });
    if (!res.ok) {
      setErrMsg(res.data?.detail ?? res.data?.error ?? `${res.status}`);
    } else {
      setCreating(false);
      setCreateDraft(makeDraft('', buildPolicy(NEW_TEMPLATE)));
      await refresh();
    }
    setBusy(false);
  }

  return (
    <PageSection
      title="Cedar Policies"
      description="Live in AVS Verified Permissions. Edits take effect within ~60s (decision cache TTL)."
      actions={
        canEdit && !creating ? (
          <Button size="sm" onClick={() => { setCreating(true); setErrMsg(null); }}>+ New Policy</Button>
        ) : undefined
      }
    >
      {data.note && <InlineAlert tone="info">{data.note}</InlineAlert>}
      {errMsg && <InlineAlert tone="error">{errMsg}</InlineAlert>}

      {creating && (
        <Card padding="sm">
          <CardHeader
            title="New policy"
            action={(
              <Inline gap="xs">
                <Button size="sm" variant="secondary" onClick={() => setCreating(false)} disabled={busy}>Cancel</Button>
                <Button size="sm" onClick={createPolicy} disabled={busy}>Create</Button>
              </Inline>
            )}
          />
          <PolicyEditor draft={createDraft} setDraft={setCreateDraft} allActions={allActions} roleOptions={roleOptions} />
        </Card>
      )}

      {data.policies.map(p => {
        const isEditing = editingId === p.policyId;
        const parsed = parsePolicy(p.statement);
        return (
          <Card key={p.policyId} padding="sm">
            <CardHeader
              title={p.description || '(no description)'}
              subtitle={p.policyId}
              action={
                !isEditing && canEdit ? (
                  <Inline gap="xs">
                    <Button size="sm" variant="secondary" onClick={() => startEdit(p)} disabled={busy}>Edit</Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleteTarget(p.policyId)} disabled={busy}>Delete</Button>
                  </Inline>
                ) : isEditing ? (
                  <Inline gap="xs">
                    <Button size="sm" variant="secondary" onClick={cancelEdit} disabled={busy}>Cancel</Button>
                    <Button size="sm" onClick={() => saveEdit(p.policyId)} disabled={busy}>Save</Button>
                  </Inline>
                ) : undefined
              }
            />

            {isEditing && draft ? (
              <PolicyEditor draft={draft} setDraft={(next) => setDraft(typeof next === 'function' ? (next as (d: Draft) => Draft)(draft) : next)} allActions={allActions} roleOptions={roleOptions} />
            ) : (
              <PolicySummary parsed={parsed} statement={p.statement} />
            )}
          </Card>
        );
      })}

      <ConfirmDialog
        open={!!deleteTarget}
        onConfirm={() => {
          if (deleteTarget) {
            const id = deleteTarget;
            setDeleteTarget(null);
            void deletePolicy(id);
          }
        }}
        onCancel={() => setDeleteTarget(null)}
        tone="destructive"
        title="Delete policy?"
        body="This is immediate; AVP enforcement updates within ~60s. This cannot be undone."
      />
    </PageSection>
  );
}

// ── PolicyEditor: Builder vs Raw modes ────────────────────────────────────────

function PolicyEditor({
  draft,
  setDraft,
  allActions,
  roleOptions,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  allActions: string[];
  roleOptions: Array<{ value: string; label: string }>;
}) {
  // Switch back to builder when toggling, but only if the current raw text
  // can still be parsed. Otherwise force the user to fix syntax first.
  function switchMode(mode: string) {
    if (mode === 'builder') {
      const parsed = parsePolicy(draft.statement);
      if (!parsed) {
        toastError(null, 'Can\'t switch to Builder',
          'This Cedar source uses constructs the builder can\'t represent yet (e.g. complex when clauses). Stay in Raw mode.');
        return;
      }
      setDraft({ ...draft, mode: 'builder', parsed });
    } else {
      setDraft({ ...draft, mode: 'raw' });
    }
  }

  function patchParsed(patch: Partial<ParsedPolicy>) {
    if (!draft.parsed) return;
    const next = { ...draft.parsed, ...patch };
    setDraft({
      ...draft,
      parsed: next,
      statement: buildPolicy(next),
    });
  }

  function setRawStatement(s: string) {
    const parsed = parsePolicy(s);
    setDraft({ ...draft, statement: s, parsed });
  }

  function setDescription(s: string) {
    setDraft({ ...draft, description: s });
  }

  return (
    <Stack gap="md" className="mt-3">
      <FormField label="Description">
        {(wiring) => (
          <Input
            {...inputWiring(wiring)}
            placeholder="e.g. 'Finance leaders can view salary'"
            value={draft.description}
            onChange={e => setDescription(e.target.value)}
          />
        )}
      </FormField>

      <Inline gap="sm" align="center">
        <SegmentedControl
          value={draft.mode}
          onChange={switchMode}
          options={[{ value: 'builder', label: 'Builder' }, { value: 'raw', label: 'Raw Cedar' }]}
        />
        {!draft.parsed && draft.mode === 'raw' && (
          <T as="span" size="xs" tone="tertiary">
            (advanced syntax — builder unavailable)
          </T>
        )}
      </Inline>

      {draft.mode === 'builder' && draft.parsed ? (
        <BuilderForm parsed={draft.parsed} allActions={allActions} roleOptions={roleOptions} onChange={patchParsed} />
      ) : null}

      {draft.mode === 'builder' && draft.parsed && (
        <CollapsibleSection title="Cedar preview" defaultOpen={false}>
          <CodeEditor value={draft.statement} onChange={() => undefined} readOnly minLines={4} maxLines={12} />
        </CollapsibleSection>
      )}

      {draft.mode === 'raw' && (
        <CodeEditor value={draft.statement} onChange={setRawStatement} minLines={6} maxLines={20} />
      )}
    </Stack>
  );
}

function BuilderForm({
  parsed,
  allActions,
  roleOptions,
  onChange,
}: {
  parsed: ParsedPolicy;
  allActions: string[];
  roleOptions: Array<{ value: string; label: string }>;
  onChange: (patch: Partial<ParsedPolicy>) => void;
}) {
  return (
    <Card padding="sm" className="bg-surface-hover">
      <Stack gap="md">
        <FormField label="Effect" layout="inline">
          {() => (
            <RadioGroup<Effect>
              name="policy-effect"
              orientation="horizontal"
              value={parsed.effect}
              onChange={eff => onChange({ effect: eff })}
              options={[{ value: 'permit', label: 'permit' }, { value: 'forbid', label: 'forbid' }]}
            />
          )}
        </FormField>

        <FormField label="Role" layout="inline">
          {(wiring) => (
            <Select
              {...inputWiring(wiring)}
              className="min-w-[220px]"
              options={roleOptions}
              value={parsed.role ?? ''}
              onChange={e => onChange({ role: e.target.value === '' ? null : e.target.value })}
            />
          )}
        </FormField>

        <FormField label="Actions" layout="inline">
          {() => (
            <TagEditor
              value={parsed.actions}
              onChange={(actions: string[]) => onChange({ actions })}
              suggestions={allActions}
              placeholder={allActions.length ? 'add action…' : 'loading schema…'}
              lowercase={false}
            />
          )}
        </FormField>

        <FormField label="Resource" layout="inline">
          {() => (
            <T as="span" size="xs" tone="tertiary">
              Application <code>(fixed)</code>
            </T>
          )}
        </FormField>
      </Stack>
    </Card>
  );
}

// ── PolicySummary: read-only view of a saved policy ──────────────────────────

function PolicySummary({ parsed, statement }: { parsed: ParsedPolicy | null; statement: string }) {
  if (!parsed) {
    return (
      <Stack gap="none" className="mt-2">
        <CollapsibleSection title="Cedar source (advanced — no builder representation)" defaultOpen={false}>
          <CodeEditor value={statement || '(empty)'} onChange={() => undefined} readOnly minLines={4} maxLines={20} />
        </CollapsibleSection>
      </Stack>
    );
  }
  return (
    <Stack gap="sm" className="mt-3">
      <Inline gap="lg" wrap align="baseline">
        <KeyValue
          layout="row"
          labelWidth="w-auto"
          label="Effect"
          value={(
            <T as="span" size="sm" weight="semibold" className={effectTone(parsed.effect) === 'success' ? 'text-success' : 'text-danger'}>
              {parsed.effect}
            </T>
          )}
        />
        <KeyValue layout="row" labelWidth="w-auto" label="Role" value={parsed.role ?? 'any role'} />
        <KeyValue
          layout="row"
          labelWidth="w-auto"
          label="Actions"
          value={`${parsed.actions.length} action${parsed.actions.length === 1 ? '' : 's'}`}
        />
      </Inline>
      <Inline gap="xs" wrap>
        {parsed.actions.map(a => <Chip key={a} size="xs" mono>{a}</Chip>)}
      </Inline>
      <CollapsibleSection title="Cedar source" defaultOpen={false}>
        <CodeEditor value={statement} onChange={() => undefined} readOnly minLines={4} maxLines={20} />
      </CollapsibleSection>
    </Stack>
  );
}

export default PoliciesPage;
