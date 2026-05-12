import { useState } from 'react';
import { useFetch } from '../../hooks/useFetch';

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

const NEW_POLICY_TEMPLATE = `// New Cedar policy. Edit and save.
permit (
  principal,
  action in [OrgIQ::Action::"Search"],
  resource
)
when { principal.role == "member" };
`;

function PoliciesPage() {
  const { data, isLoading, error, refresh } = useFetch<PoliciesResponse>('/api/identity/policies');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ description: string; statement: string }>({ description: '', statement: '' });
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState({ description: '', statement: NEW_POLICY_TEMPLATE });
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  if (isLoading) return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading policies…</div>;
  if (error) return <div style={{ padding: 24, color: 'var(--color-error, #ef4444)' }}>Error: {error}</div>;
  if (!data) return null;

  function startEdit(p: PolicyEntry) {
    setEditingId(p.policyId);
    setDraft({ description: p.description, statement: p.statement });
    setErrMsg(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setErrMsg(null);
  }

  async function saveEdit(policyId: string) {
    setBusy(true); setErrMsg(null);
    try {
      const res = await fetch(`/api/identity/policies/${policyId}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? j.error ?? `${res.status}`);
      }
      setEditingId(null);
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deletePolicy(policyId: string) {
    if (!confirm('Delete this policy? This is immediate and AVP enforcement updates within ~1 minute.')) return;
    setBusy(true); setErrMsg(null);
    try {
      const res = await fetch(`/api/identity/policies/${policyId}`, {
        method: 'DELETE',
        credentials: 'include',
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
        body: JSON.stringify(createDraft),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? j.error ?? `${res.status}`);
      }
      setCreating(false);
      setCreateDraft({ description: '', statement: NEW_POLICY_TEMPLATE });
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
            Live in AWS Verified Permissions. Edits take effect within ~60s (decision cache TTL).
          </p>
        </div>
        {!creating && (
          <button onClick={() => { setCreating(true); setErrMsg(null); }} style={btnPrimary}>+ New Policy</button>
        )}
      </header>

      {data.note && (
        <div style={notice}>{data.note}</div>
      )}

      {errMsg && (
        <div style={errorBanner}>{errMsg}</div>
      )}

      {creating && (
        <article style={card}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>New policy</div>
          <input
            type="text"
            placeholder="Description (e.g. 'Finance leaders can view salary')"
            value={createDraft.description}
            onChange={e => setCreateDraft({ ...createDraft, description: e.target.value })}
            style={input}
          />
          <textarea
            value={createDraft.statement}
            onChange={e => setCreateDraft({ ...createDraft, statement: e.target.value })}
            spellCheck={false}
            rows={10}
            style={textarea}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setCreating(false)} disabled={busy} style={btnSecondary}>Cancel</button>
            <button onClick={createPolicy} disabled={busy} style={btnPrimary}>Create</button>
          </div>
        </article>
      )}

      {data.policies.map(p => {
        const isEditing = editingId === p.policyId;
        return (
          <article key={p.policyId} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-text-primary)' }}>
                  {p.description || '(no description)'}
                </div>
                <code style={{ fontSize: 10, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{p.policyId}</code>
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

            {isEditing ? (
              <>
                <input
                  type="text"
                  placeholder="Description"
                  value={draft.description}
                  onChange={e => setDraft({ ...draft, description: e.target.value })}
                  style={input}
                />
                <textarea
                  value={draft.statement}
                  onChange={e => setDraft({ ...draft, statement: e.target.value })}
                  spellCheck={false}
                  rows={Math.max(8, draft.statement.split('\n').length + 1)}
                  style={textarea}
                />
              </>
            ) : (
              <pre style={preBlock}>{p.statement || '(empty)'}</pre>
            )}
          </article>
        );
      })}
    </div>
  );
}

const card: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: 16,
};

const preBlock: React.CSSProperties = {
  margin: 0,
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

const textarea: React.CSSProperties = {
  width: '100%',
  padding: 12,
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--color-text-primary)',
  resize: 'vertical',
  boxSizing: 'border-box',
  marginTop: 8,
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 13,
  color: 'var(--color-text-primary)',
  marginBottom: 8,
  boxSizing: 'border-box',
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

export default PoliciesPage;
