import { NavLink, Outlet } from 'react-router';

const NAV_ITEMS = [
  { path: '/agents', label: 'Agent Flow' },
  { path: '/graph', label: 'Org Graph' },
  { path: '/search', label: 'Search' },
  { path: '/scores', label: 'Scores' },
  { path: '/ingest', label: 'Ingest' },
  { path: '/observability', label: 'Observability' },
];

export function Layout() {
  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside style={{
        width: 240,
        borderRight: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          padding: '16px 20px',
          fontWeight: 700,
          fontSize: 18,
          borderBottom: '1px solid var(--color-border)',
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
                fontSize: 14,
                marginBottom: 2,
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main style={{ flex: 1, overflow: 'auto' }}>
        <Outlet />
      </main>
    </div>
  );
}
