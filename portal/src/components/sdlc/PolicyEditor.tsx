// SDLC governance policies — the rules an agent's change is checked against
// before it can ship unattended.
//
// Policies are deliberately flat (kind + config + action) rather than a rule
// engine: there is no policy composition, no precedence, no "first match
// wins". Every enabled policy is evaluated independently and the strictest
// outcome applies — block beats require_approval beats ship. That keeps the
// mental model to "what does each row do on its own", which is what this
// list is for.

import { useCallback, useState } from 'react';
import {
  Button, Card, Chip, ConfirmDialog, FormField, Inline, Input, MetaLine, SectionLabel,
  Select, Stack, Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';

type PolicyKind = 'require_review' | 'protected_paths' | 'max_files' | 'model_allowlist';
type PolicyAction = 'require_approval' | 'block';

interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  kind: PolicyKind;
  config: Record<string, unknown>;
  action: PolicyAction;
}

const KIND_LABEL: Record<PolicyKind, string> = {
  require_review: 'Require review',
  protected_paths: 'Protected paths',
  max_files: 'Max files changed',
  model_allowlist: 'Model allowlist',
};

const ACTION_TONE: Record<PolicyAction, string> = {
  require_approval: 'bg-warning-bg text-warning',
  block: 'bg-danger-bg text-danger',
};

const ACTION_LABEL: Record<PolicyAction, string> = {
  require_approval: 'needs a human',
  block: 'blocks',
};

// require_review has nothing to require approval "instead of" — its whole
// point is a human in the loop, so the action is pinned rather than offered
// as a choice that could be set to something contradictory.
const FIXED_ACTION: Partial<Record<PolicyKind, PolicyAction>> = {
  require_review: 'require_approval',
};

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function splitList(text: string): string[] {
  return text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

// Human-readable summary of what a policy actually does, derived from
// kind + config rather than stored — so the description can never drift
// from the rule it describes.
function describe(p: Policy): string {
  const verb = p.action === 'block' ? 'Blocks' : 'Requires a human';
  switch (p.kind) {
    case 'require_review':
      return 'Requires a human to review every change.';
    case 'protected_paths': {
      const globs = asStringList(p.config.globs);
      return globs.length
        ? `${verb} when a change touches: ${globs.join(', ')}`
        : `${verb} when a change touches any path (no paths configured yet).`;
    }
    case 'max_files': {
      const max = typeof p.config.max === 'number' ? p.config.max : null;
      return max !== null
        ? `${verb === 'Blocks' ? 'Blocks' : 'Requires a human for'} changes over ${max} file${max === 1 ? '' : 's'}.`
        : `${verb} for changes over a file limit (not configured yet).`;
    }
    case 'model_allowlist': {
      const models = asStringList(p.config.models);
      return models.length
        ? `${verb} for changes made by any model other than: ${models.join(', ')}`
        : `${verb} for changes made by any model (no allowlist configured yet).`;
    }
    default:
      return '';
  }
}

interface FormState {
  name: string;
  kind: PolicyKind;
  action: PolicyAction;
  globsText: string;
  maxText: string;
  modelsText: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'require_review',
  action: 'require_approval',
  globsText: '',
  maxText: '',
  modelsText: '',
};

function configFor(form: FormState): Record<string, unknown> {
  switch (form.kind) {
    case 'require_review':
      return {};
    case 'protected_paths':
      return { globs: splitList(form.globsText) };
    case 'max_files':
      return { max: Number(form.maxText) || 0 };
    case 'model_allowlist':
      return { models: splitList(form.modelsText) };
    default:
      return {};
  }
}

export function PolicyEditor() {
  const { data, refresh } = useFetch<{ policies: Policy[] }>('/api/sdlc/policies', 60_000);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Policy | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const save = useCallback(async (policy: {
    id?: string; name: string; enabled: boolean; kind: PolicyKind; config: Record<string, unknown>; action: PolicyAction;
  }, pendingLabel: string) => {
    const tid = toastPending(pendingLabel, policy.name);
    try {
      const res = await fetch('/api/sdlc/policies', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });
      const body = await res.json() as { policy?: Policy; error?: string };
      if (!res.ok || !body.policy) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Saved', policy.name);
      refresh();
      return true;
    } catch (err) {
      toastError(tid, 'Could not save policy', (err as Error).message);
      return false;
    }
  }, [refresh]);

  const toggle = useCallback((p: Policy) => {
    void save(
      { id: p.id, name: p.name, enabled: !p.enabled, kind: p.kind, config: p.config, action: p.action },
      p.enabled ? 'Disabling policy' : 'Enabling policy',
    );
  }, [save]);

  const remove = useCallback(async (p: Policy) => {
    setDeletingId(p.id);
    const tid = toastPending('Deleting policy', p.name);
    try {
      const res = await fetch(`/api/sdlc/policies/${p.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, 'Deleted', p.name);
      refresh();
    } catch (err) {
      toastError(tid, 'Could not delete', (err as Error).message);
    } finally {
      setDeletingId(null);
      setConfirmDelete(null);
    }
  }, [refresh]);

  const create = useCallback(async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    const action = FIXED_ACTION[form.kind] ?? form.action;
    const ok = await save(
      { name: form.name.trim(), enabled: true, kind: form.kind, config: configFor(form), action },
      'Creating policy',
    );
    setBusy(false);
    if (ok) { setForm(EMPTY_FORM); setCreating(false); }
  }, [form, save]);

  const policies = data?.policies ?? [];

  // `labelId` is pulled out of every wiring bag on purpose: FormField hands it
  // to the consumer but it is not a DOM prop, so spreading it onto an input
  // reaches the element and React warns. Queued against the library.
  return (
    <Card padding="none" className="overflow-hidden">
      <Inline gap="sm" align="center" className="px-3.5 py-3 border-b border-border">
        <SectionLabel>GOVERNANCE POLICIES</SectionLabel>
        <MetaLine
          size="xs"
          items={["decide when an agent's change can ship on its own and when it needs a human — every change is evaluated against all enabled policies"]}
        />
        <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : '+ Add policy'}
        </Button>
      </Inline>

      {creating && (
        <Inline gap="md" align="end" wrap className="px-3.5 py-3 border-b border-border">
          <FormField label="Name" className="flex-1 min-w-[200px]">
            {({ labelId: _l, ...w }) => (
              <Input
                {...w}
                size="sm"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="No unreviewed infra changes"
              />
            )}
          </FormField>
          <FormField label="Kind">
            {({ labelId: _l, ...w }) => (
              <Select
                {...w}
                size="sm"
                value={form.kind}
                onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as PolicyKind }))}
                options={[
                  { value: 'require_review', label: 'Require review' },
                  { value: 'protected_paths', label: 'Protected paths' },
                  { value: 'max_files', label: 'Max files changed' },
                  { value: 'model_allowlist', label: 'Model allowlist' },
                ]}
              />
            )}
          </FormField>
          {!FIXED_ACTION[form.kind] && (
            <FormField label="Action">
              {({ labelId: _l, ...w }) => (
                <Select
                  {...w}
                  size="sm"
                  value={form.action}
                  onChange={(e) => setForm((f) => ({ ...f, action: e.target.value as PolicyAction }))}
                  options={[
                    { value: 'require_approval', label: 'Require approval' },
                    { value: 'block', label: 'Block' },
                  ]}
                />
              )}
            </FormField>
          )}

          {form.kind === 'protected_paths' && (
            <FormField label="Path globs (comma or newline separated)" className="w-full">
              {({ labelId: _l, ...w }) => (
                <Textarea
                  {...w}
                  className="font-mono"
                  rows={2}
                  value={form.globsText}
                  onChange={(e) => setForm((f) => ({ ...f, globsText: e.target.value }))}
                  placeholder="infra/**, **/auth/**"
                />
              )}
            </FormField>
          )}
          {form.kind === 'max_files' && (
            <FormField label="Max files">
              {({ labelId: _l, ...w }) => (
                <Input
                  {...w}
                  type="number"
                  size="sm"
                  min={0}
                  className="w-24"
                  value={form.maxText}
                  onChange={(e) => setForm((f) => ({ ...f, maxText: e.target.value }))}
                  placeholder="40"
                />
              )}
            </FormField>
          )}
          {form.kind === 'model_allowlist' && (
            <FormField label="Allowed models (comma or newline separated)" className="w-full">
              {({ labelId: _l, ...w }) => (
                <Textarea
                  {...w}
                  className="font-mono"
                  rows={2}
                  value={form.modelsText}
                  onChange={(e) => setForm((f) => ({ ...f, modelsText: e.target.value }))}
                  placeholder="amazon.nova-pro-v1:0"
                />
              )}
            </FormField>
          )}

          <Button
            variant="primary"
            size="sm"
            disabled={busy || !form.name.trim()}
            onClick={() => void create()}
          >
            {busy ? 'saving…' : 'Add policy'}
          </Button>
        </Inline>
      )}

      {policies.length === 0 ? (
        <MetaLine
          size="sm"
          className="px-3.5 py-4"
          items={['No policies yet. Every change ships without review until one is added.']}
        />
      ) : (
        policies.map((p) => (
          <Inline key={p.id} gap="md" align="center" className="px-3.5 py-2.5 border-b border-border last:border-b-0">
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              title={p.enabled ? 'Disable policy' : 'Enable policy'}
              onClick={() => toggle(p)}
            >
              <Chip size="xs" tone={p.enabled ? 'success' : 'neutral'}>
                {p.enabled ? 'enabled' : 'disabled'}
              </Chip>
            </Button>
            <Stack gap="none" className="flex-1 min-w-0">
              <Inline gap="xs" align="baseline" className="min-w-0">
                <SectionLabel className="truncate">{p.name}</SectionLabel>
                <MetaLine size="xs" items={[KIND_LABEL[p.kind]]} />
              </Inline>
              <MetaLine size="xs" className="truncate" items={[describe(p)]} />
            </Stack>
            <Chip size="xs" className={`shrink-0 ${ACTION_TONE[p.action]}`}>{ACTION_LABEL[p.action]}</Chip>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              disabled={deletingId === p.id}
              onClick={() => setConfirmDelete(p)}
            >
              Delete
            </Button>
          </Inline>
        ))
      )}

      <ConfirmDialog
        open={confirmDelete != null}
        tone="destructive"
        title="Delete policy?"
        body={confirmDelete ? `"${confirmDelete.name}" no longer checks agent changes. This cannot be undone.` : ''}
        confirmLabel={confirmDelete && deletingId === confirmDelete.id ? 'Deleting…' : 'Delete policy'}
        confirmDisabled={confirmDelete != null && deletingId === confirmDelete.id}
        onConfirm={() => { if (confirmDelete) void remove(confirmDelete); }}
        onCancel={() => setConfirmDelete(null)}
      />
    </Card>
  );
}
