import { useFetch } from '../../hooks/useFetch';

interface RoleInfo {
  id: string;
  label: string;
  summary: string;
  capabilities: string[];
}

const ALL_ACTIONS = [
  'Search', 'ViewOrgChart', 'ViewLeaderboard',
  'ViewSalary', 'ViewPerformance',
  'EditGuardrail', 'EditPolicy', 'ViewIdentityAdmin',
];

function RolesPage() {
  const { data, isLoading, error } = useFetch<RoleInfo[]>('/api/identity/roles');

  if (isLoading) return <div style={{ color: 'var(--color-text-tertiary)' }}>Loading roles…</div>;
  if (error) return <div style={{ color: 'var(--color-error, #ef4444)' }}>Error: {error}</div>;
  if (!data) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <header>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Roles</h2>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: 13 }}>
          Cedar policies enforced by Verified Permissions on every middleware request.
        </p>
      </header>

      <section style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        gap: 16,
      }}>
        {data.map(role => (
          <article key={role.id} style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 16,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{role.label}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>{role.id}</div>
            <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '10px 0' }}>
              {role.summary}
            </p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {role.capabilities.map(c => (
                <li key={c} style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  background: 'var(--color-surface-hover)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 999,
                  color: 'var(--color-text-primary)',
                }}>{c}</li>
              ))}
            </ul>
          </article>
        ))}
      </section>

      <section>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px' }}>Permission matrix</h3>
        <div style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-md)',
          overflow: 'auto',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-hover)' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600 }}>Action</th>
                {data.map(r => (
                  <th key={r.id} style={{ textAlign: 'center', padding: '8px 12px', fontWeight: 600 }}>{r.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ALL_ACTIONS.map(action => (
                <tr key={action} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '8px 12px', color: 'var(--color-text-primary)' }}>{action}</td>
                  {data.map(r => (
                    <td key={r.id} style={{ textAlign: 'center', padding: '8px 12px' }}>
                      {r.capabilities.includes(action)
                        ? <span style={{ color: 'var(--color-success, #10b981)' }}>✓</span>
                        : <span style={{ color: 'var(--color-text-tertiary)' }}>—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default RolesPage;
