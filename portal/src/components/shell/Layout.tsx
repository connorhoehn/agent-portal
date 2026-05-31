import { NavLink, Outlet } from 'react-router';
import {
  ChannelHeader,
  CommandPalette,
  CommandPaletteHint,
  CommandPaletteProvider,
  SubNavLayout,
  type SubNavItem,
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
  // "Search" = former Agent Tools (/iq/invoke). The legacy /iq/search route is
  // now a redirect to /iq/invoke — all conversational search goes through the
  // agent invocation surface.
  { path: '/iq/invoke',    label: 'Search',            tenant: 'orgiq' },
  { path: '/iq/explore',   label: 'Explore',           tenant: 'orgiq' },
  { path: '/iq/prompts',   label: 'Prompt Management', tenant: 'orgiq' },
  { path: '/iq/scores',    label: 'Reports',           tenant: 'orgiq' },
  { path: '/iq/projects',  label: 'Projects',          tenant: 'orgiq' },
  { path: '/newsroom',     label: 'Newsroom',          tenant: 'newsroom' },
  { path: '/settings',     label: 'Settings',          tenant: 'universal' },
];

// Admin sub-items rendered inside the collapsible Platform group via SubNavItem.group.
const PLATFORM_ITEMS: NavItem[] = [
  { path: '/iq/agents',             label: 'Architecture',    tenant: 'admin' },
  { path: '/admin/knowledge-bases', label: 'Knowledge Bases', tenant: 'admin', requireRoles: ['hr-admin'] },
  { path: '/admin/ingest',          label: 'Ingest',          tenant: 'admin', requireRoles: ['hr-admin'] },
  { path: '/admin/observability',   label: 'Observability',   tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'] },
  { path: '/admin/capabilities',    label: 'Capabilities',    tenant: 'admin' },
  { path: '/admin/identity',        label: 'Identity',        tenant: 'admin', requireRoles: ['hr-admin'] },
];

const TENANT_LABELS: Record<Tenant, string> = {
  orgiq: 'OrgIQ',
  newsroom: 'Newsroom',
  admin: 'Admin',
};

export function Layout() {
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  const { session } = useSession();
  const commands = usePortalCommands();
  const getDynamicCommands = usePortalDynamicCommands();

  const navItems = NAV_ITEMS.filter((item) => {
    if (item.tenant === 'universal') return true;
    if (session?.role === 'admin') return item.tenant === session?.tenant;
    if (item.requireRoles && !(session && item.requireRoles.includes(session.role ?? ''))) return false;
    return item.tenant === session?.tenant;
  });

  const showPlatform =
    session?.role === 'hr-admin' ||
    session?.role === 'org-leader' ||
    session?.role === 'admin';

  const platformItems = showPlatform
    ? PLATFORM_ITEMS.filter((item) => {
        if (!item.requireRoles) return true;
        return session && item.requireRoles.includes(session.role ?? '');
      })
    : [];

  const subNavItems: SubNavItem[] = [
    ...navItems.map((i) => ({ path: i.path, label: i.label })),
    ...platformItems.map((i) => ({ path: i.path, label: i.label, group: 'Platform' })),
  ];

  const mockedSubsystems = health
    ? Object.entries(health.mocks).filter(([, v]) => v).map(([k]) => k)
    : [];
  const statusLabel = !health
    ? '…'
    : mockedSubsystems.length === 0
      ? `Live · ${health.region}`
      : `Mock: ${mockedSubsystems.join(', ')}`;

  const tenantLabel = TENANT_LABELS[session?.tenant ?? 'orgiq'];

  return (
    <CommandPaletteProvider commands={commands} getDynamicCommands={getDynamicCommands}>
      <div data-tenant={session?.tenant ?? 'orgiq'} className="flex flex-col h-screen">
        <ChannelHeader
          name={tenantLabel}
          description={statusLabel}
          online={mockedSubsystems.length === 0 && !!health}
          actions={
            <div className="flex items-center gap-3">
              <TenantSwitcher />
              <CommandPaletteHint />
              <GatewayStatusBadge />
              <MasqueradeMenu />
            </div>
          }
        />
        <div className="flex-1 min-h-0">
          <SubNavLayout
            title="OrgIQ"
            items={subNavItems}
            railWidth={200}
            storageKey="orgiq-shell"
            renderNavItem={(item, children, baseStyle) => (
              <NavLink
                to={item.path}
                style={({ isActive }) =>
                  isActive
                    ? { ...baseStyle, borderLeft: '3px solid var(--color-primary)', background: 'var(--color-surface-hover)', color: 'var(--color-text-primary)' }
                    : baseStyle
                }
              >
                {children}
              </NavLink>
            )}
          >
            <div className="p-6 h-full overflow-auto">
              <Outlet />
            </div>
          </SubNavLayout>
        </div>
        <CommandPalette placeholder="Jump to a page, paste an invocation id, search runs…" />
      </div>
    </CommandPaletteProvider>
  );
}
