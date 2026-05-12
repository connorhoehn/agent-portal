import { useFetch } from '../../hooks/useFetch';

interface PolicyEntry {
  policyId: string;
  policyType: string;
  createdDate: string;
  statement?: string;
}

interface PoliciesResponse {
  policies: PolicyEntry[];
  note?: string;
}

function PoliciesPage() {
  const { data, isLoading, error } = useFetch<PoliciesResponse>('/api/identity/policies');

  if (isLoading) return <div style={{ color: 'var(--color-text-tertiary)' }}>Loading policies…</div>;
  if (error) return <div style={{ color: 'var(--color-error, #ef4444)' }}>Error: {error}</div>;
  if (!data) return null;

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Cedar Policies</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: 13 }}>
          Source-of-truth policies stored in AWS Verified Permissions. Read-only here — edits will land in a follow-up.
        </p>
      </header>

      {data.note && (
        <div style={{
          padding: 12,
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          fontSize: 12,
          color: 'var(--color-text-secondary)',
        }}>{data.note}</div>
      )}

      {data.policies.map(p => (
        <article key={p.policyId} style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          padding: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <code style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>{p.policyId}</code>
            <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
              {p.policyType} · {new Date(p.createdDate).toLocaleString()}
            </span>
          </div>
          <pre style={{
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
          }}>{p.statement ?? '(empty)'}</pre>
        </article>
      ))}
    </div>
  );
}

export default PoliciesPage;
