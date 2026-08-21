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
import { Breadcrumbs } from './Breadcrumbs';
import { MasqueradeMenu } from './MasqueradeMenu';
import { GatewayStatusBadge } from './GatewayStatusBadge';
import { usePortalCommands, usePortalDynamicCommands } from './portalCommands';
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
type NavItem = { path: string; label: string; requireRoles?: string[]; tenant: Tenant | 'universal'; group?: string };

// The app is an SDLC agent platform first — agents that link codebases, run in
// computers, and deliver reviewed changes. OrgIQ (organizational intelligence)
// is one feature subset of that, not the frame. So the rail leads with BUILD
// (the SDLC loop), then ORGIQ, then OPERATE (platform/ops). Rail groups are
// derived from each item's `group`; ordering is by GROUP_ORDER below.

// Rail group order (top → bottom).
const GROUP_ORDER = ['Build', 'Org', 'Operate', 'System'];

// Tenant/universal items (visible per tenant + role, not just to admins).
const NAV_ITEMS: NavItem[] = [
  { path: '/iq/work',       label: 'Work',        tenant: 'orgiq',     group: 'Build' },
  // The planning layer. Changes trace to the initiative they serve, so the
  // "why are we building this" page belongs in the lifecycle group — it was
  // previously reachable only through the Explore sub-rail.
  { path: '/iq/projects',   label: 'Initiatives', tenant: 'orgiq',     group: 'Build' },
  { path: '/iq/invoke',     label: 'Ask',         tenant: 'orgiq',     group: 'Org' },
  { path: '/iq/explore',    label: 'Explore',     tenant: 'orgiq',     group: 'Org' },
  { path: '/iq/scores',     label: 'Scores',      tenant: 'orgiq',     group: 'Org' },
  { path: '/iq/prompt-ops', label: 'Prompts',     tenant: 'orgiq',     group: 'Operate' },
  { path: '/newsroom',      label: 'Newsroom',    tenant: 'newsroom' },
  { path: '/settings',      label: 'Settings',    tenant: 'universal', group: 'System' },
];

// Platform/admin surfaces, gated by role and grouped SDLC-first.
const PLATFORM_ITEMS: NavItem[] = [
  // BUILD — the SDLC core: the repos, the reviews, and the machines agents run on.
  // Bots first: the standing missions that drive the loop, rendered between
  // Initiatives (in NAV_ITEMS above) and Codebases.
  { path: '/admin/bots',            label: 'Bots',            tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  // 'Codebases', not 'Projects': /iq/projects is already the org's initiatives —
  // epics, features, the people who own them. This is the code that delivers them.
  { path: '/admin/projects',        label: 'Codebases',       tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  { path: '/admin/changes',         label: 'Changes',         tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  // 'Computers', not 'Devbox': the page is a fleet of microVMs agents work in,
  // and the top-level menu reads as a place, not a single box.
  { path: '/admin/devbox',          label: 'Computers',       tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  // OPERATE — platform + ops.
  { path: '/admin/observability',   label: 'Health',          tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  { path: '/iq/agents',             label: 'Architecture',    tenant: 'admin', group: 'Operate' },
  // One entry, not two: sources, ingestion, storage and knowledge bases are
  // consecutive stages of one pipeline.
  { path: '/admin/knowledge',       label: 'Knowledge',       tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  { path: '/admin/capabilities',    label: 'Capabilities',    tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  // SYSTEM — administration, not runtime. Identity sits with Settings: who can
  // do what is configuration of the platform, not operating it.
  { path: '/admin/identity',        label: 'Identity',        tenant: 'admin', requireRoles: ['hr-admin'], group: 'System' },
];

const TENANT_LABELS: Record<Tenant, string> = {
  orgiq: 'Org',
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

  // Platform surfaces (Build tooling, Operate, Identity) are org-tenant
  // scoped: a session parked on the newsroom tenant gets the newsroom nav,
  // not the org platform's — switching workspace brings it back.
  const showPlatform =
    (session?.tenant ?? 'orgiq') === 'orgiq' &&
    (session?.role === 'hr-admin' ||
      session?.role === 'org-leader' ||
      session?.role === 'admin');

  const platformItems = showPlatform
    ? PLATFORM_ITEMS.filter((item) => {
        if (!item.requireRoles) return true;
        // The cross-tenant admin role passes every role gate.
        return session && (session.role === 'admin' || item.requireRoles.includes(session.role ?? ''));
      })
    : [];

  // The one number worth interrupting for: work that is blocked on a human.
  // Findings and queued jobs are not counted — those are the system working,
  // not the system waiting.
  const needsYou =
    (work?.jobs['awaiting_review'] ?? 0) + (work?.proposals['pending'] ?? 0);

  // Combine the tenant + platform items and order them by rail group
  // (Build → OrgIQ → Operate → System). Array.sort is stable, so items keep
  // their definition order within a group.
  const subNavItems: SubNavItem[] = [...navItems, ...platformItems]
    .map((i) => ({
      path: i.path,
      label: i.label,
      ...(i.group ? { group: i.group } : {}),
      ...(i.path === '/iq/work' && needsYou > 0 ? { count: needsYou } : {}),
    }))
    .sort((a, b) => {
      const rank = (g?: string) => { const n = GROUP_ORDER.indexOf(g ?? 'System'); return n < 0 ? GROUP_ORDER.length : n; };
      return rank(a.group) - rank(b.group);
    });

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
              <CommandPaletteHint />
              <GatewayStatusBadge />
              <MasqueradeMenu />
            </div>
          }
        />
        <div className="flex-1 min-h-0">
          <SubNavLayout
            title={tenantLabel}
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
            <div className={`${fullBleed ? '' : 'p-6'} h-full flex flex-col`}>
              {/* Where you are, once you're 3+ levels deep — stacked rails say
                  what you can open, the trail says where you stand. */}
              <Breadcrumbs />
              <div className="flex-1 min-h-0 overflow-auto">
                <Outlet />
              </div>
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
