// SchemaPage — view and edit the AVP Cedar schema. The full JSON edit lets
// HRAdmin add/remove actions or entity types in one shot. AVP server-side
// validation rejects malformed schemas; the error surfaces inline.

import { useEffect, useState } from 'react';
import { useFetch } from '../../hooks/useFetch';

interface SchemaResponse {
  schema: unknown;
  raw: string;
}

function SchemaPage() {
  const { data, isLoading, error, refresh } = useFetch<SchemaResponse>('/api/identity/schema');
  const [draft, setDraft] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      const pretty = JSON.stringify(data.schema, null, 2);
      setDraft(pretty);
    }
  }, [data]);

  if (isLoading) return <div style={{ padding: 24, color: 'var(--color-text-tertiary)' }}>Loading schema…</div>;
  if (error) return <div style={{ padding: 24, color: 'var(--color-error, #ef4444)' }}>Error: {error}</div>;
  if (!data) return null;

  async function save() {
    setBusy(true); setErrMsg(null);
    try {
      // Validate JSON locally first — gives a faster + clearer error than AVP.
      let parsed: unknown;
      try { parsed = JSON.parse(draft); } catch (e) {
        throw new Error(`JSON parse error: ${(e as Error).message}`);
      }
      const res = await fetch('/api/identity/schema', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schema: parsed }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.detail ?? j.error ?? `${res.status}`);
      }
      setEditing(false);
      await refresh();
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Build a flattened action list view for the read-only display.
  const namespaces = (data.schema && typeof data.schema === 'object')
    ? Object.entries(data.schema as Record<string, { actions?: Record<string, unknown>; entityTypes?: Record<string, unknown> }>)
    : [];

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Schema</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: 13 }}>
            Cedar schema enforced by AVP. Removing actions referenced by live policies will fail validation.
          </p>
        </div>
        {!editing && <button onClick={() => setEditing(true)} style={btnPrimary}>Edit</button>}
        {editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { setEditing(false); setErrMsg(null); setDraft(JSON.stringify(data.schema, null, 2)); }} disabled={busy} style={btnSecondary}>Cancel</button>
            <button onClick={save} disabled={busy} style={btnPrimary}>Save</button>
          </div>
        )}
      </header>

      {errMsg && <div style={errorBanner}>{errMsg}</div>}

      {editing ? (
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          spellCheck={false}
          rows={Math.max(20, draft.split('\n').length + 2)}
          style={textarea}
        />
      ) : (
        <>
          {namespaces.map(([ns, body]) => (
            <article key={ns} style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Namespace: <code>{ns}</code></div>

              <div style={{ marginBottom: 16 }}>
                <div style={sectionLabel}>Entity types</div>
                <div style={chipRow}>
                  {Object.keys(body.entityTypes ?? {}).map(t => (
                    <span key={t} style={chip}>{t}</span>
                  ))}
                </div>
              </div>

              <div>
                <div style={sectionLabel}>Actions</div>
                <div style={chipRow}>
                  {Object.keys(body.actions ?? {}).map(a => (
                    <span key={a} style={chip}>{a}</span>
                  ))}
                </div>
              </div>
            </article>
          ))}

          <article style={card}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--color-text-secondary)' }}>Raw schema (JSON)</div>
            <pre style={preBlock}>{JSON.stringify(data.schema, null, 2)}</pre>
          </article>
        </>
      )}
    </div>
  );
}

const card: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: 16,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--color-text-tertiary)',
  marginBottom: 6,
};

const chipRow: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
};

const chip: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 999,
  color: 'var(--color-text-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
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

const errorBanner: React.CSSProperties = {
  padding: 10,
  background: '#fee2e2',
  border: '1px solid #ef4444',
  borderRadius: 'var(--radius-md)',
  color: '#991b1b',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export default SchemaPage;
