// Policy sandbox: dry-run "what happens if user with role X does action Y"
// against AVP. Shows the decision and the determining policy IDs.

import { useMemo, useState } from 'react';
import { TagEditor } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

interface SchemaResponse {
  schema: { OrgIQ?: { actions?: Record<string, unknown> } };
}

interface PolicyEntry {
  policyId: string;
  description: string;
}

interface TestResult {
  decision?: 'ALLOW' | 'DENY';
  determiningPolicies?: Array<{ policyId: string }>;
  errors?: Array<{ errorDescription?: string }>;
  error?: string;
  ts: string;
  request: { role: string; action: string };
}

const ROLE_OPTIONS = ['member', 'org-leader', 'hr-admin'];

function PolicyTestPage() {
  const { data: schema } = useFetch<SchemaResponse>('/api/identity/schema');
  const { data: policies } = useFetch<{ policies: PolicyEntry[] }>('/api/identity/policies');
  const allActions = useMemo(
    () => Object.keys(schema?.schema?.OrgIQ?.actions ?? {}).sort(),
    [schema],
  );
  const policyById = useMemo(() => {
    const m = new Map<string, PolicyEntry>();
    for (const p of policies?.policies ?? []) m.set(p.policyId, p);
    return m;
  }, [policies]);

  const [role, setRole] = useState<string>('member');
  const [actions, setActions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [history, setHistory] = useState<TestResult[]>([]);

  async function runTests() {
    if (actions.length === 0) {
      setErrMsg('Pick at least one action to test.');
      return;
    }
    setBusy(true); setErrMsg(null);
    const results: TestResult[] = [];
    try {
      for (const action of actions) {
        const res = await fetch('/api/identity/policies/test', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role, action }),
        });
        const j = await res.json();
        results.push({
          ...(res.ok ? j : { error: j.error ?? `${res.status}` }),
          ts: new Date().toISOString(),
          request: { role, action },
        });
      }
      setHistory(prev => [...results, ...prev].slice(0, 50));
    } catch (e) {
      setErrMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Policy Sandbox</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: 13 }}>
          Dry-run AVP authorization. Pick a role + one or more actions to see what each policy would decide.
        </p>
      </header>

      <article style={card}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FormRow label="Role">
            <select value={role} onChange={e => setRole(e.target.value)} style={selectStyle}>
              {ROLE_OPTIONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </FormRow>
          <FormRow label="Actions">
            <TagEditor
              value={actions}
              onChange={setActions}
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
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={runTests} disabled={busy} style={btnPrimary}>
              {busy ? 'Testing…' : `Test ${actions.length || 0} action${actions.length === 1 ? '' : 's'}`}
            </button>
          </div>
          {errMsg && <div style={errorBanner}>{errMsg}</div>}
        </div>
      </article>

      {history.length > 0 && (
        <section>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: '8px 0 12px' }}>Recent results</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((r, i) => (
              <div key={`${r.ts}-${i}`} style={resultRow}>
                <DecisionBadge value={r.decision} hasError={!!r.error} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>
                    <code style={{ fontSize: 12 }}>{r.request.role}</code>
                    <span style={{ color: 'var(--color-text-tertiary)', margin: '0 6px' }}>→</span>
                    <code style={{ fontSize: 12 }}>{r.request.action}</code>
                  </div>
                  {r.error && (
                    <div style={{ fontSize: 11, color: 'var(--color-error, #ef4444)', marginTop: 2 }}>{r.error}</div>
                  )}
                  {r.determiningPolicies && r.determiningPolicies.length > 0 && (
                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {r.determiningPolicies.map(dp => {
                        const p = policyById.get(dp.policyId);
                        return (
                          <span key={dp.policyId} style={policyChip} title={dp.policyId}>
                            {p?.description || dp.policyId.slice(0, 12) + '…'}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {r.errors && r.errors.length > 0 && (
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-error, #ef4444)' }}>
                      {r.errors.map((e, j) => <div key={j}>{e.errorDescription}</div>)}
                    </div>
                  )}
                </div>
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>
                  {new Date(r.ts).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function DecisionBadge({ value, hasError }: { value?: string; hasError: boolean }) {
  if (hasError) return <span style={{ ...badge, background: '#fee2e2', color: '#991b1b' }}>ERROR</span>;
  const allow = value === 'ALLOW';
  return (
    <span style={{ ...badge, background: allow ? '#d1fae5' : '#fee2e2', color: allow ? '#065f46' : '#991b1b' }}>
      {value ?? '—'}
    </span>
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

const card: React.CSSProperties = {
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
  padding: 16,
};

const resultRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: 12,
  background: 'var(--color-surface)',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-md)',
};

const badge: React.CSSProperties = {
  display: 'inline-block',
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.5,
  borderRadius: 'var(--radius-sm, 4px)',
  minWidth: 60,
  textAlign: 'center',
};

const policyChip: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 8px',
  background: 'var(--color-surface-hover)',
  border: '1px solid var(--color-border)',
  borderRadius: 999,
  color: 'var(--color-text-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

const selectStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: 12,
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm, 4px)',
  background: 'var(--color-surface)',
  color: 'var(--color-text-primary)',
  minWidth: 220,
};

const btnPrimary: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--color-primary)',
  color: 'white',
  border: 'none',
  borderRadius: 'var(--radius-sm, 4px)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const errorBanner: React.CSSProperties = {
  padding: 10,
  background: '#fee2e2',
  border: '1px solid #ef4444',
  borderRadius: 'var(--radius-md)',
  color: '#991b1b',
  fontSize: 12,
};

export default PolicyTestPage;
