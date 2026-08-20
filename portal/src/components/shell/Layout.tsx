import { NavLink, Outlet, useLocation } from 'react-router';
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
import { DevboxQuickSwitch } from './DevboxQuickSwitch';
import { ToastHost } from './ToastHost';
import { TerminalDock } from '../devbox/TerminalDock';
import { NEWSROOM_ENABLED } from '../../lib/features';

interface Health {
  status: string;
  service: string;
  mocks: Record<string, boolean>;
  region: string;
  awsCredentials?: { ok: boolean; error?: string };
  datastore?: { ok: boolean; error?: string };
}

interface WorkSummary {
  jobs: Record<string, number>;
  proposals: Record<string, number>;
  findings: { open: number; critical: number; warning: number };
}

type Tenant = 'orgiq' | 'newsroom' | 'admin';
type NavItem = { path: string; label: string; requireRoles?: string[]; tenant: Tenant | 'universal' };

// Top-level nav — orgiq + universal items only. Admin items live in PLATFORM_ITEMS.
// Five jobs-to-be-done. Everything else is reachable from inside one of these
// (or from Operate's drill-ins) — a flat list of 20 destinations made the app
// read as a pile of dashboards rather than a tool with a purpose.
const NAV_ITEMS: NavItem[] = [
  { path: '/iq/invoke',     label: 'Ask',      tenant: 'orgiq' },
  { path: '/iq/explore',    label: 'Explore',  tenant: 'orgiq' },
  { path: '/iq/work',       label: 'Work',     tenant: 'orgiq' },
  { path: '/iq/prompt-ops', label: 'Prompts',  tenant: 'orgiq' },
  { path: '/newsroom',      label: 'Newsroom', tenant: 'newsroom' },
  { path: '/settings',      label: 'Settings', tenant: 'universal' },
];

// Admin sub-items rendered inside the collapsible Platform group via SubNavItem.group.
// Operate — the admin surfaces, grouped under one heading instead of seven
// peers competing with the product surfaces above.
const PLATFORM_ITEMS: NavItem[] = [
  { path: '/admin/observability',   label: 'Health',          tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'] },
  // 'Codebases', not 'Projects': /iq/projects is already the org's
  // initiatives — epics, features, the people who own them. This is the
  // code that delivers them, and two nav items called Projects would be
  // a coin toss every time.
  { path: '/admin/projects',        label: 'Codebases',       tenant: 'admin' },
  { path: '/admin/changes',         label: 'Changes',         tenant: 'admin' },
  { path: '/admin/devbox',          label: 'Devbox',          tenant: 'admin' },
  { path: '/iq/agents',             label: 'Architecture',    tenant: 'admin' },
  // One entry, not two: sources, ingestion, storage and knowledge bases are
  // consecutive stages of one pipeline, and splitting them across two nav
  // items made you check both to find out whether either was working.
  { path: '/admin/knowledge',       label: 'Knowledge',       tenant: 'admin', requireRoles: ['hr-admin'] },
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
  const { data: work } = useFetch<WorkSummary>('/api/work/summary', 15_000);
  const { session } = useSession();
  const { pathname } = useLocation();

  // Routes that render their own SubNavLayout (iq/admin/newsroom) go
  // full-bleed — the outer p-6 was double-framing them and wasting a 24px
  // ring of content space around every nested layout. Standalone pages
  // (settings, etc.) keep the comfortable padding.
  const fullBleed =
    pathname.startsWith('/iq') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/newsroom');
  const commands = usePortalCommands();
  const getDynamicCommands = usePortalDynamicCommands();

  const navItems = NAV_ITEMS.filter((item) => {
    if (item.tenant === 'newsroom' && !NEWSROOM_ENABLED) return false;
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

  // The one number worth interrupting for: work that is blocked on a human.
  // Findings and queued jobs are not counted — those are the system working,
  // not the system waiting.
  const needsYou =
    (work?.jobs['awaiting_review'] ?? 0) + (work?.proposals['pending'] ?? 0);

  const subNavItems: SubNavItem[] = [
    ...navItems.map((i) => ({
      path: i.path,
      label: i.label,
      ...(i.path === '/iq/work' && needsYou > 0 ? { count: needsYou } : {}),
    })),
    ...platformItems.map((i) => ({ path: i.path, label: i.label, group: 'Operate' })),
  ];

  const mockedSubsystems = health
    ? Object.entries(health.mocks).filter(([, v]) => v).map(([k]) => k)
    : [];
  const credsExpired = health?.awsCredentials?.ok === false;
  const dbDown = health?.datastore?.ok === false;
  // Credentials first: an expired session explains a dead database, but not
  // the other way round, so leading with the database would send someone
  // chasing the wrong thing.
  const statusLabel = !health
    ? '…'
    : credsExpired
      ? 'AWS credentials expired — re-login, then restart the middleware'
      : dbDown
        ? `Database unavailable — ${health.datastore?.error ?? 'Aurora unreachable'}`
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
          online={mockedSubsystems.length === 0 && !!health && !credsExpired && !dbDown}
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
            <div className={`${fullBleed ? '' : 'p-6'} h-full overflow-auto`}>
              <Outlet />
            </div>
          </SubNavLayout>
        </div>
        <CommandPalette placeholder="Jump to a page, paste an invocation id, search runs…" />
        <DevboxQuickSwitch />
        <ToastHost />
        <TerminalDock />
      </div>
    </CommandPaletteProvider>
  );
}
