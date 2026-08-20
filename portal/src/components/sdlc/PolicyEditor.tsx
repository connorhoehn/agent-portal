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
import { Card } from '@connorhoehnslalom/ui-components/shared';
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
    const tid = toastPending('Deleting policy', p.name);
    try {
      const res = await fetch(`/api/sdlc/policies/${p.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, 'Deleted', p.name);
      refresh();
    } catch (err) {
      toastError(tid, 'Could not delete', (err as Error).message);
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

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">GOVERNANCE POLICIES</span>
        <span className="text-[11px] text-text-tertiary">
          decide when an agent's change can ship on its own and when it needs a human — every change is
          evaluated against all enabled policies
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setCreating((v) => !v)}
          className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors"
        >
          {creating ? 'Cancel' : '+ Add policy'}
        </button>
      </div>

      {creating && (
        <div className="px-3.5 py-3 border-b border-border flex flex-wrap items-end gap-2.5">
          <label className="flex-1 min-w-[200px]">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
              Name
            </span>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="No unreviewed infra changes"
              className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
            />
          </label>
          <label>
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
              Kind
            </span>
            <select
              value={form.kind}
              onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as PolicyKind }))}
              className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
            >
              <option value="require_review">Require review</option>
              <option value="protected_paths">Protected paths</option>
              <option value="max_files">Max files changed</option>
              <option value="model_allowlist">Model allowlist</option>
            </select>
          </label>
          {!FIXED_ACTION[form.kind] && (
            <label>
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                Action
              </span>
              <select
                value={form.action}
                onChange={(e) => setForm((f) => ({ ...f, action: e.target.value as PolicyAction }))}
                className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
              >
                <option value="require_approval">Require approval</option>
                <option value="block">Block</option>
              </select>
            </label>
          )}

          {form.kind === 'protected_paths' && (
            <label className="w-full">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                Path globs (comma or newline separated)
              </span>
              <textarea
                value={form.globsText}
                onChange={(e) => setForm((f) => ({ ...f, globsText: e.target.value }))}
                placeholder="infra/**, **/auth/**"
                rows={2}
                className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] font-mono text-text-primary"
              />
            </label>
          )}
          {form.kind === 'max_files' && (
            <label>
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                Max files
              </span>
              <input
                type="number"
                min={0}
                value={form.maxText}
                onChange={(e) => setForm((f) => ({ ...f, maxText: e.target.value }))}
                placeholder="40"
                className="w-24 px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
              />
            </label>
          )}
          {form.kind === 'model_allowlist' && (
            <label className="w-full">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                Allowed models (comma or newline separated)
              </span>
              <textarea
                value={form.modelsText}
                onChange={(e) => setForm((f) => ({ ...f, modelsText: e.target.value }))}
                placeholder="amazon.nova-pro-v1:0"
                rows={2}
                className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] font-mono text-text-primary"
              />
            </label>
          )}

          <button
            disabled={busy || !form.name.trim()}
            onClick={() => void create()}
            className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
          >
            {busy ? 'saving…' : 'Add policy'}
          </button>
        </div>
      )}

      {policies.length === 0 ? (
        <div className="px-3.5 py-4 text-[12px] text-text-tertiary">
          No policies yet. Every change ships without review until one is added.
        </div>
      ) : (
        policies.map((p) => (
          <div key={p.id} className="px-3.5 py-2.5 border-b border-border last:border-b-0 flex items-center gap-3">
            <button
              onClick={() => toggle(p)}
              title={p.enabled ? 'Disable policy' : 'Enable policy'}
              className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded cursor-pointer border-none transition-colors ${
                p.enabled ? 'bg-success-bg text-success' : 'bg-surface-hover text-text-tertiary'
              }`}
            >
              {p.enabled ? 'enabled' : 'disabled'}
            </button>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-text-primary truncate">
                {p.name}
                <span className="ml-2 text-[10px] font-normal text-text-tertiary">{KIND_LABEL[p.kind]}</span>
              </div>
              <div className="text-[11px] text-text-tertiary truncate">{describe(p)}</div>
            </div>
            <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded ${ACTION_TONE[p.action]}`}>
              {ACTION_LABEL[p.action]}
            </span>
            <button
              onClick={() => void remove(p)}
              className="shrink-0 px-2 py-1 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:border-danger hover:text-danger transition-colors"
            >
              Delete
            </button>
          </div>
        ))
      )}
    </Card>
  );
}
