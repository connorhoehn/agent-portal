import { NavLink, Outlet, useLocation } from 'react-router';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import {
  CommandPalette,
  CommandPaletteHint,
  CommandPaletteProvider,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { MasqueradeMenu } from './MasqueradeMenu';
import { GatewayStatusBadge } from './GatewayStatusBadge';
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

// Top-level nav — orgiq + universal items only. Admin items live in PLATFORM_ITEMS.
const NAV_ITEMS: NavItem[] = [
  { path: '/iq/search',    label: 'Search',            tenant: 'orgiq' },
  { path: '/iq/explore',   label: 'Explore',           tenant: 'orgiq' },
  { path: '/iq/agents',    label: 'Architecture',      tenant: 'orgiq' },
  { path: '/iq/invoke',    label: 'Agent Tools',       tenant: 'orgiq' },
  { path: '/iq/prompts',   label: 'Prompt Management', tenant: 'orgiq' },
  { path: '/iq/scores',    label: 'Scores',            tenant: 'orgiq' },
  { path: '/iq/decisions', label: 'Decisions',         tenant: 'orgiq' },
  { path: '/iq/projects',  label: 'Projects',          tenant: 'orgiq' },
  { path: '/newsroom',     label: 'Newsroom',          tenant: 'newsroom' },
  { path: '/settings',     label: 'Settings',          tenant: 'universal' },
];

// Admin sub-items rendered inside the collapsible Platform group.
const PLATFORM_ITEMS: NavItem[] = [
  { path: '/admin/knowledge-base', label: 'Knowledge Base', tenant: 'admin', requireRoles: ['hr-admin'] },
  { path: '/admin/ingest',         label: 'Ingest',         tenant: 'admin', requireRoles: ['hr-admin'] },
  { path: '/admin/observability',  label: 'Observability',  tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'] },
  { path: '/admin/capabilities',   label: 'Capabilities',   tenant: 'admin' },
  { path: '/admin/identity',       label: 'Identity',       tenant: 'admin', requireRoles: ['hr-admin'] },
];

// ── Collapsible Platform group ────────────────────────────────────────────────

function PlatformGroup({
  items,
  session,
}: {
  items: NavItem[];
  session: { role?: string } | null;
}) {
  const { pathname } = useLocation();
  const isOnAdmin = pathname.startsWith('/admin');
  const [open, setOpen] = useState(isOnAdmin);

  const visible = items.filter((item) => {
    if (!item.requireRoles) return true;
    return session && item.requireRoles.includes(session.role ?? '');
  });
  if (visible.length === 0) return null;

  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={groupHeaderStyle(isOnAdmin)}
      >
        <span style={{ flex: 1, textAlign: 'left' }}>Platform</span>
        <span style={{ fontSize: 9, opacity: 0.5 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ paddingLeft: 8 }}>
          {visible.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              style={({ isActive }) => childItemStyle(isActive)}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

function groupHeaderStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    width: '100%',
    padding: '7px 12px',
    borderRadius: 'var(--radius-md)',
    color: active ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
    fontFamily: 'inherit',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    marginBottom: 2,
  };
}

function childItemStyle(isActive: boolean): CSSProperties {
  return {
    display: 'block',
    padding: '6px 12px',
    borderRadius: 'var(--radius-md)',
    color: isActive ? 'var(--color-primary)' : 'var(--color-text-tertiary)',
    background: isActive ? 'var(--color-surface-hover)' : 'transparent',
    textDecoration: 'none',
    fontSize: 12,
    fontWeight: isActive ? 500 : 400,
    marginBottom: 1,
  };
}

// ── Layout ────────────────────────────────────────────────────────────────────

export function Layout() {
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  const { session } = useSession();
  const commands = usePortalCommands();
  const getDynamicCommands = usePortalDynamicCommands();

  const navItems = NAV_ITEMS.filter(item => {
    if (item.tenant === 'universal') return true;
    if (session?.role === 'admin') return item.tenant === session?.tenant;
    if (item.requireRoles && !(session && item.requireRoles.includes(session.role ?? ''))) return false;
    return item.tenant === session?.tenant;
  });

  const showPlatform =
    session?.role === 'hr-admin' ||
    session?.role === 'org-leader' ||
    session?.role === 'admin';

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
        <nav style={{ padding: '12px 8px', flex: 1, overflowY: 'auto' }}>
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

          {showPlatform && (
            <PlatformGroup items={PLATFORM_ITEMS} session={session} />
          )}
        </nav>
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--color-border)', fontSize: 10, color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: statusColor, display: 'inline-block' }} />
          <span>{statusLabel}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <GatewayStatusBadge />
            <span>gw</span>
          </span>
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
