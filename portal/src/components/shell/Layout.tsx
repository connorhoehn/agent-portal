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
import { ComputeDock } from '@connorhoehnslalom/ui-components/compute';
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
  // The cadence the planning layer actually runs on: an SME's own sprint —
  // their work, their envelope, their dates — and the org-wide board for a
  // release manager. Sits next to Initiatives because a sprint is one
  // initiative's iteration, and it is intentionally ungated: every orgiq role
  // has sprints, and the privileged (org-wide) scope is refused by the API.
  { path: '/iq/sprints',    label: 'Sprints',     tenant: 'orgiq',     group: 'Build' },
  { path: '/iq/invoke',     label: 'Ask',         tenant: 'orgiq',     group: 'Org' },
  { path: '/iq/explore',    label: 'Explore',     tenant: 'orgiq',     group: 'Org' },
  // Ask is also the "find help" surface: its empty state offers questions
  // from your own work, and answers grow an evidence rail (people + matched
  // skills + documents, score-free) via /api/graph/help. Scores stays the
  // separate HR analytics view — ViewLeaderboard tier, leadership only; an
  // ungated nav item just handed every SME a 403'd leaderboard.
  { path: '/iq/scores',     label: 'Scores',      tenant: 'orgiq',     group: 'Org', requireRoles: ['org-leader', 'hr-admin'] },
  { path: '/iq/prompt-ops', label: 'Prompts',     tenant: 'orgiq',     group: 'Operate' },
  { path: '/newsroom',      label: 'Newsroom',    tenant: 'newsroom' },
  { path: '/settings',      label: 'Settings',    tenant: 'universal', group: 'System' },
];

// Platform/admin surfaces, gated by role and grouped SDLC-first.
const PLATFORM_ITEMS: NavItem[] = [
  // BUILD — the SDLC core: the repos, the reviews, and the machines agents run on.
  // Budgets first: it renders directly after Initiatives (in NAV_ITEMS above) —
  // the allocation ledger sits beside the initiatives it funds. Read-wide
  // (org-leader + hr-admin); writes are capability-gated inside the page.
  { path: '/admin/budgets',         label: 'Budgets',         tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Build' },
  // Bots next: the standing missions that drive the loop.
  { path: '/admin/bots',            label: 'Bots',            tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  // 'Codebases', not 'Projects': /iq/projects is already the org's initiatives —
  // epics, features, the people who own them. This is the code that delivers them.
  { path: '/admin/projects',        label: 'Codebases',       tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  { path: '/admin/changes',         label: 'Changes',         tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  // 'Computers', not 'Devbox': the page is a fleet of microVMs agents work in,
  // and the top-level menu reads as a place, not a single box.
  //
  // Open to `sme` as well: the role exists to spend a sprint envelope by
  // assigning computers to work, and it is the role that has to get into a
  // cluster and run a command. The fleet an SME sees is scoped server-side to
  // their own computers plus the ones shared on their initiatives
  // (middleware lib/devbox-visibility.ts), so this is a door, not a key.
  { path: '/admin/devbox',          label: 'Computers',       tenant: 'admin', requireRoles: ['hr-admin', 'sme'], group: 'Build' },
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
  const { session } = useSession();
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  // /api/work is orgiq-only (requireTenant('orgiq')); polling it from a
  // newsroom session logged a DENY in the authz audit every 15s. Only in orgiq.
  const { data: work } = useFetch<WorkSummary>(
    session?.tenant === 'orgiq' ? '/api/work/summary' : null, 15_000);
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
  // Platform surfaces are orgiq-only. Within that, the gate is PER ITEM rather
  // than a second role list in front of the first.
  //
  // It used to be both: a broad `showPlatform` (hr-admin / org-leader / admin)
  // and then each item's `requireRoles`. Naming a role on an item therefore did
  // nothing unless that role was also in the outer list — which is how `sme`
  // stayed locked out of Computers after being added to its requireRoles. Two
  // gates for one question is a gate you will forget to open.
  //
  // An item with no `requireRoles` is unrestricted among the platform roles, so
  // it still needs the broad check; an item that names roles is authoritative.
  const onOrgiq = (session?.tenant ?? 'orgiq') === 'orgiq';
  const isPlatformRole =
    session?.role === 'hr-admin' || session?.role === 'org-leader' || session?.role === 'admin';

  const platformItems = onOrgiq
    ? PLATFORM_ITEMS.filter((item) => {
        if (!session) return false;
        // The cross-tenant admin role passes every role gate.
        if (session.role === 'admin') return true;
        if (!item.requireRoles) return isPlatformRole;
        return item.requireRoles.includes(session.role ?? '');
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
        <ComputeDock />
      </div>
    </CommandPaletteProvider>
  );
}
