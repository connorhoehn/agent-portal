import { useEffect, useMemo, useState } from 'react';
import { CodeEditor, TagEditor } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { parsePolicy, buildPolicy, type Effect, type ParsedPolicy } from '../../lib/cedarPolicy';

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

const ROLE_OPTIONS: Array<{ value: string | ''; label: string }> = [
  { value: '', label: '— No role condition (matches everyone)' },
  { value: 'member', label: 'member' },
  { value: 'org-leader', label: 'org-leader' },
  { value: 'hr-admin', label: 'hr-admin' },
];

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
  const { data, isLoading, error, refresh } = useFetch<PoliciesResponse>('/api/identity/policies');
  const { data: schema } = useFetch<SchemaResponse>('/api/identity/schema');
  const allActions = useMemo(
    () => Object.keys(schema?.schema?.OrgIQ?.actions ?? {}).sort(),
    [schema],
  );

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<Draft>(() => makeDraft('', buildPolicy(NEW_TEMPLATE)));
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  if (isLoading) return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading policies…</div>;
  if (error) return <div style={{ padding: 24, color: 'var(--color-error, #ef4444)' }}>Error: {error}</div>;
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
    try {
      const res = await fetch(`/api/identity/policies/${policyId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: draft.description, statement: draft.statement }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? j.error ?? `${res.status}`);
      }
      cancelEdit();
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deletePolicy(policyId: string) {
    if (!confirm('Delete this policy? This is immediate; AVP enforcement updates within ~60 s.')) return;
    setBusy(true); setErrMsg(null);
    try {
      const res = await fetch(`/api/identity/policies/${policyId}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createPolicy() {
    setBusy(true); setErrMsg(null);
    try {
      const res = await fetch('/api/identity/policies', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: createDraft.description, statement: createDraft.statement }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? j.error ?? `${res.status}`);
      }
      setCreating(false);
      setCreateDraft(makeDraft('', buildPolicy(NEW_TEMPLATE)));
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Cedar Policies</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: 13 }}>
            Live in AVS Verified Permissions. Edits take effect within ~60s (decision cache TTL).
          </p>
        </div>
        {!creating && (
          <button onClick={() => { setCreating(true); setErrMsg(null); }} style={btnPrimary}>+ New Policy</button>
        )}
      </header>

      {data.note && <div style={notice}>{data.note}</div>}
      {errMsg && <div style={errorBanner}>{errMsg}</div>}

      {creating && (
        <article style={card}>
          <div style={cardHeader}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>New policy</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setCreating(false)} disabled={busy} style={btnSecondary}>Cancel</button>
              <button onClick={createPolicy} disabled={busy} style={btnPrimary}>Create</button>
            </div>
          </div>
          <PolicyEditor draft={createDraft} setDraft={setCreateDraft} allActions={allActions} />
        </article>
      )}

      {data.policies.map(p => {
        const isEditing = editingId === p.policyId;
        const parsed = parsePolicy(p.statement);
        return (
          <article key={p.policyId} style={card}>
            <div style={cardHeader}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                  {p.description || '(no description)'}
                </div>
                <code style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{p.policyId}</code>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {!isEditing && (
                  <>
                    <button onClick={() => startEdit(p)} disabled={busy} style={btnSecondary}>Edit</button>
                    <button onClick={() => deletePolicy(p.policyId)} disabled={busy} style={btnDanger}>Delete</button>
                  </>
                )}
                {isEditing && (
                  <>
                    <button onClick={cancelEdit} disabled={busy} style={btnSecondary}>Cancel</button>
                    <button onClick={() => saveEdit(p.policyId)} disabled={busy} style={btnPrimary}>Save</button>
                  </>
                )}
              </div>
            </div>

            {isEditing && draft ? (
              <PolicyEditor draft={draft} setDraft={(next) => setDraft(typeof next === 'function' ? (next as (d: Draft) => Draft)(draft) : next)} allActions={allActions} />
            ) : (
              <PolicySummary parsed={parsed} statement={p.statement} />
            )}
          </article>
        );
      })}
    </div>
  );
}

// ── PolicyEditor: Builder vs Raw modes ────────────────────────────────────────

function PolicyEditor({
  draft,
  setDraft,
  allActions,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  allActions: string[];
}) {
  // Switch back to builder when toggling, but only if the current raw text
  // can still be parsed. Otherwise force the user to fix syntax first.
  function switchMode(mode: 'builder' | 'raw') {
    if (mode === 'builder') {
      const parsed = parsePolicy(draft.statement);
      if (!parsed) {
        alert('This Cedar source uses constructs the builder can\'t represent yet (e.g. complex when clauses). Stay in Raw mode.');
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
      <input
        type="text"
        placeholder="Description (e.g. 'Finance leaders can view salary')"
        value={draft.description}
        onChange={e => setDescription(e.target.value)}
        style={input}
      />

      <div style={modeToggleRow}>
        <ModeButton active={draft.mode === 'builder'} onClick={() => switchMode('builder')} disabled={!draft.parsed && draft.mode === 'raw'}>
          Builder
        </ModeButton>
        <ModeButton active={draft.mode === 'raw'} onClick={() => switchMode('raw')}>
          Raw Cedar
        </ModeButton>
        {!draft.parsed && draft.mode === 'raw' && (
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 'auto' }}>
            (advanced syntax — builder unavailable)
          </span>
        )}
      </div>

      {draft.mode === 'builder' && draft.parsed ? (
        <BuilderForm parsed={draft.parsed} allActions={allActions} onChange={patchParsed} />
      ) : null}

      {draft.mode === 'builder' && draft.parsed && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ fontSize: 11, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
            Cedar preview
          </summary>
          <div style={{ marginTop: 6 }}>
            <CodeEditor value={draft.statement} onChange={() => undefined} readOnly minLines={4} maxLines={12} />
          </div>
        </details>
      )}

      {draft.mode === 'raw' && (
        <CodeEditor value={draft.statement} onChange={setRawStatement} minLines={6} maxLines={20} />
      )}
    </div>
  );
}

function BuilderForm({
  parsed,
  allActions,
  onChange,
}: {
  parsed: ParsedPolicy;
  allActions: string[];
  onChange: (patch: Partial<ParsedPolicy>) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 12, background: 'var(--color-surface-hover)', borderRadius: 'var(--radius-sm, 4px)', border: '1px solid var(--color-border)' }}>
      <FormRow label="Effect">
        <div style={{ display: 'flex', gap: 8 }}>
          {(['permit', 'forbid'] as Effect[]).map(eff => (
            <label key={eff} style={radioLabel(parsed.effect === eff)}>
              <input
                type="radio"
                name={`effect-${parsed.effect}`}
                checked={parsed.effect === eff}
                onChange={() => onChange({ effect: eff })}
                style={{ margin: 0 }}
              />
              <span>{eff}</span>
            </label>
          ))}
        </div>
      </FormRow>

      <FormRow label="Role">
        <select
          value={parsed.role ?? ''}
          onChange={e => onChange({ role: e.target.value === '' ? null : e.target.value })}
          style={select}
        >
          {ROLE_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </FormRow>

      <FormRow label="Actions">
        <TagEditor
          value={parsed.actions}
          onChange={(actions: string[]) => onChange({ actions })}
          suggestions={allActions}
          placeholder={allActions.length ? 'add action…' : 'loading schema…'}
          lowercase={false}
        />
      </FormRow>

      <FormRow label="Resource">
        <span style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>
          Application <code style={{ fontSize: 11 }}>(fixed)</code>
        </span>
      </FormRow>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <div style={{ width: 80, fontSize: 11, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, paddingTop: 6 }}>
        {label}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function ModeButton({ active, onClick, disabled, children }: { active: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '4px 12px',
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        background: active ? 'var(--color-primary)' : 'transparent',
        color: active ? 'white' : 'var(--color-text-secondary)',
        border: '1px solid ' + (active ? 'var(--color-primary)' : 'var(--color-border)'),
        borderRadius: 'var(--radius-sm, 4px)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >{children}</button>
  );
}

// ── PolicySummary: read-only view of a saved policy ──────────────────────────

function PolicySummary({ parsed, statement }: { parsed: ParsedPolicy | null; statement: string }) {
  if (!parsed) {
    return (
      <details>
        <summary style={{ fontSize: 11, color: 'var(--color-text-tertiary)', cursor: 'pointer', marginTop: 8 }}>
          Cedar source (advanced — no builder representation)
        </summary>
        <pre style={preBlock}>{statement || '(empty)'}</pre>
      </details>
    );
  }
  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline', fontSize: 12 }}>
        <SummaryField label="Effect" value={parsed.effect} accent={parsed.effect === 'permit' ? '#10b981' : '#ef4444'} />
        <SummaryField label="Role" value={parsed.role ?? 'any role'} />
        <SummaryField label="Actions" value={`${parsed.actions.length} action${parsed.actions.length === 1 ? '' : 's'}`} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {parsed.actions.map(a => (
          <span key={a} style={actionChip}>{a}</span>
        ))}
      </div>
      <details>
        <summary style={{ fontSize: 11, color: 'var(--color-text-tertiary)', cursor: 'pointer' }}>
          Cedar source
        </summary>
        <pre style={preBlock}>{statement}</pre>
      </details>
    </div>
  );
}

function SummaryField({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginRight: 4 }}>{label}</span>
      <span style={{ fontWeight: 500, color: accent ?? 'var(--color-text-primary)' }}>{value}</span>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: 16,
};

const cardHeader: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 16,
};

const modeToggleRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
};

const radioLabel = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '4px 10px',
  border: '1px solid ' + (active ? 'var(--color-primary)' : 'var(--color-border)'),
  borderRadius: 'var(--radius-sm, 4px)',
  background: active ? 'rgba(99,102,241,0.08)' : 'var(--color-surface)',
  fontSize: 12,
  cursor: 'pointer',
  color: 'var(--color-text-primary)',
});

const select: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  minWidth: 220,
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 13,
  color: 'var(--color-text-primary)',
  boxSizing: 'border-box',
};

const preBlock: React.CSSProperties = {
  margin: '6px 0 0',
  padding: 12,
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--color-text-primary)',
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
};

const actionChip: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 999,
  color: 'var(--color-text-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const btnPrimary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'var(--color-primary)',
  color: 'white',
  border: 'none',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const btnSecondary: React.CSSProperties = {
  padding: '5px 12px',
  background: 'var(--color-surface-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 12,
  cursor: 'pointer',
};

const btnDanger: React.CSSProperties = {
  padding: '5px 12px',
  background: 'transparent',
  color: 'var(--color-error, #ef4444)',
  border: '1px solid var(--color-error, #ef4444)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 12,
  cursor: 'pointer',
};

const errorBanner: React.CSSProperties = {
  padding: 10,
  background: '#fee2e2',
  border: '1px solid #ef4444',
  borderRadius: 'var(--radius-md)',
  color: '#991b1b',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const notice: React.CSSProperties = {
  padding: 10,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

// Effect dropdown wrapper to silence unused-import warning during incremental dev.
useEffect; // tree-shaken in production

export default PoliciesPage;
