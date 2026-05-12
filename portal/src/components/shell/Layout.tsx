import { NavLink, Outlet } from 'react-router';

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
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)', fontSize: 10, color: 'var(--color-text-tertiary)' }}>
          v0.2.0 · Mock Mode
        </div>
      </aside>
      <main style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <Outlet />
      </main>
    </div>
  );
}
