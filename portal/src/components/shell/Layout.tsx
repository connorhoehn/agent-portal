import { NavLink, Outlet } from 'react-router';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { MasqueradeMenu } from './MasqueradeMenu';
import { CommandPalette, CommandPaletteHint } from './CommandPalette';

interface Health {
  status: string;
  service: string;
  mocks: Record<string, boolean>;
  region: string;
}

type NavItem = { path: string; label: string; requireRoles?: string[] };

const NAV_ITEMS: NavItem[] = [
  { path: '/search', label: 'Search' },
  { path: '/explore', label: 'Explore' },
  { path: '/agents', label: 'Architecture' },
  { path: '/invoke', label: 'Agent Tools' },
  { path: '/scores', label: 'Scores' },
  { path: '/decisions', label: 'Decisions' },
  { path: '/projects', label: 'Projects' },
  { path: '/newsroom', label: 'Newsroom' },
  { path: '/knowledge-base', label: 'Knowledge Base', requireRoles: ['hr-admin'] },
  { path: '/ingest', label: 'Ingest', requireRoles: ['hr-admin'] },
  { path: '/observability', label: 'Observability', requireRoles: ['org-leader', 'hr-admin'] },
  { path: '/capabilities', label: 'Platform Services' },
  { path: '/identity', label: 'Identity', requireRoles: ['hr-admin'] },
  { path: '/settings', label: 'Settings' },
];

export function Layout() {
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  const { session } = useSession();
  const navItems = NAV_ITEMS.filter(item =>
    !item.requireRoles || (session && item.requireRoles.includes(session.role)),
  );
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
          {navItems.map(item => (
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
      <main style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <header style={{
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: 12,
          padding: '10px 24px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}>
          <CommandPaletteHint />
          <MasqueradeMenu />
        </header>
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          <Outlet />
        </div>
      </main>
      <CommandPalette />
    </div>
  );
}
