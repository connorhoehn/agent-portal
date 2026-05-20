import { NavLink, Outlet } from 'react-router';
import {
  CommandPalette,
  CommandPaletteHint,
  CommandPaletteProvider,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { MasqueradeMenu } from './MasqueradeMenu';
// TODO: GatewayStatusBadge temporarily disabled - realtime-modules/proxy-client needs dist build fix
// import { GatewayStatusBadge } from './GatewayStatusBadge';
import { usePortalCommands, usePortalDynamicCommands } from './portalCommands';
import { TenantSwitcher } from './TenantSwitcher';

interface Health {
  status: string;
  service: string;
  mocks: Record<string, boolean>;
  region: string;
}

type Tenant = 'orgiq' | 'newsroom' | 'admin';
type NavItem = { path: string; label: string; requireRoles?: string[]; tenant: Tenant | 'universal' };

const NAV_ITEMS: NavItem[] = [
  { path: '/iq/search',            label: 'Search',           tenant: 'orgiq' },
  { path: '/iq/explore',           label: 'Explore',          tenant: 'orgiq' },
  { path: '/iq/agents',            label: 'Architecture',     tenant: 'orgiq' },
  { path: '/iq/invoke',            label: 'Agent Tools',      tenant: 'orgiq' },
  { path: '/iq/canary',            label: 'Canary',           tenant: 'orgiq' },
  { path: '/iq/scores',            label: 'Scores',           tenant: 'orgiq' },
  { path: '/iq/decisions',         label: 'Decisions',        tenant: 'orgiq' },
  { path: '/iq/projects',          label: 'Projects',         tenant: 'orgiq' },
  { path: '/newsroom',             label: 'Newsroom',         tenant: 'newsroom' },
  { path: '/admin/knowledge-base', label: 'Knowledge Base',   tenant: 'admin', requireRoles: ['hr-admin'] },
  { path: '/admin/ingest',         label: 'Ingest',           tenant: 'admin', requireRoles: ['hr-admin'] },
  { path: '/admin/observability',  label: 'Observability',    tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'] },
  { path: '/admin/capabilities',   label: 'Platform Services', tenant: 'admin' },
  { path: '/admin/identity',       label: 'Identity',         tenant: 'admin', requireRoles: ['hr-admin'] },
  { path: '/settings',             label: 'Settings',         tenant: 'universal' },
];

export function Layout() {
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  const { session } = useSession();
  const commands = usePortalCommands();
  const getDynamicCommands = usePortalDynamicCommands();
  const navItems = NAV_ITEMS.filter(item => {
    // Universal: everyone sees it
    if (item.tenant === 'universal') return true;

    // Admin role: see admin items + own tenant's items, but NOT the other tenant's
    if (session?.role === 'admin') {
      if (item.tenant === 'admin') return true;
      return item.tenant === session?.tenant;
    }

    // Non-admin: requireRoles gate (checked before tenant so it can narrow admin items too)
    if (item.requireRoles && !(session && item.requireRoles.includes(session.role))) {
      return false;
    }

    // Admin-tenant items: visible to admin-adjacent roles
    if (item.tenant === 'admin') {
      return session?.role === 'hr-admin' || session?.role === 'org-leader';
    }

    // Tenant-specific items: only own tenant
    return item.tenant === session?.tenant;
  });
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
    <CommandPaletteProvider commands={commands} getDynamicCommands={getDynamicCommands}>
    <div data-tenant={session?.tenant ?? 'orgiq'} style={{ display: 'flex', height: '100vh' }}>
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
          {/* TODO: Re-enable when realtime-modules build is fixed */}
          {/* <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <GatewayStatusBadge />
            <span>gw</span>
          </span> */}
        </div>
      </aside>
      <main style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <header style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 24px',
          borderBottom: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
        }}>
          <TenantSwitcher />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <CommandPaletteHint />
            <MasqueradeMenu />
          </div>
        </header>
        <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
          <Outlet />
        </div>
      </main>
      <CommandPalette placeholder="Jump to a page, paste an invocation id, search runs…" />
    </div>
    </CommandPaletteProvider>
  );
}
