import { NavLink, Outlet } from 'react-router';
import { useFetch } from '../../hooks/useFetch';

interface Health {
  status: string;
  service: string;
  mocks: Record<string, boolean>;
  region: string;
}

const NAV_ITEMS = [
  { path: '/explore', label: 'Explore' },
  { path: '/agents', label: 'Architecture' },
  { path: '/invoke', label: 'Agent Tools' },
  { path: '/scores', label: 'Scores' },
  { path: '/ingest', label: 'Ingest' },
  { path: '/observability', label: 'Observability' },
  { path: '/capabilities', label: 'Capabilities' },
];

export function Layout() {
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  const mockedSubsystems = health
    ? Object.entries(health.mocks).filter(([, v]) => v).map(([k]) => k)
    : [];
  const statusLabel = !health
    ? '…'
    : mockedSubsystems.length === 0
      ? `Live · ${health.region}`
      : `Mock: ${mockedSubsystems.join(', ')}`;
  const statusColor = !health
    ? 'var(--color-text-tertiary)'
    : mockedSubsystems.length === 0
      ? 'var(--color-success, #10b981)'
      : 'var(--color-warning, #f59e0b)';

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{
        width: 200,
        borderRight: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '16px 16px',
          fontWeight: 700,
          fontSize: 18,
          borderBottom: '1px solid var(--color-border)',
          color: 'var(--color-primary)',
        }}>
          OrgIQ
        </div>
        <nav style={{ padding: '12px 8px', flex: 1 }}>
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.path}
              to={item.path}
              style={({ isActive }) => ({
                display: 'block',
                padding: '8px 12px',
                borderRadius: 'var(--radius-md)',
                color: isActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                background: isActive ? 'var(--color-surface-hover)' : 'transparent',
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: isActive ? 500 : 400,
                marginBottom: 2,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)', fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
          <span>{statusLabel}</span>
        </div>
      </aside>
      <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
