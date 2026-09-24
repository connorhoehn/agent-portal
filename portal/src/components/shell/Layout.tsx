import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import {
  ChannelHeader,
  CommandPalette,
  CommandPaletteHint,
  CommandPaletteProvider,
  DropdownMenu,
  Inline,
  Stack,
  SubNavLayout,
  type SubNavItem,
  SkipLink,
  type Command,
  activeNavItemClassName,
  inactiveNavItemClassName,
} from '@connorhoehnslalom/ui-components/shared';

// activeNavItemClassName / inactiveNavItemClassName come from the library, not
// from local copies. They were briefly replaced with local strings on the
// premise that "ui-components 2.276.0 removed some exports" — checked against
// the installed dist and that is not so: the pin is 2.277.2 and both names
// resolve from `/shared`. The local copies were also not equivalent. The real
// active class is
// `block px-[14px] py-2 border-l-[3px] border-primary bg-surface-hover text-text-primary …`;
// the substitute was `font-semibold text-foreground`, which drops the left
// accent bar, the highlight and ALL the padding, and names tokens this app does
// not define (`text-foreground` appears in 2 files here, `text-text-primary` in
// 101). Measured on the shell rail with the substitute in place: borderLeft 0px,
// background transparent, padding 0px — every rail item flush to the edge with
// no active state. Seven other layouts never stopped importing these, so the
// rails had also stopped agreeing with each other.
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { Breadcrumbs } from './Breadcrumbs';
import { MasqueradeMenu } from './MasqueradeMenu';
import { GatewayStatusBadge } from './GatewayStatusBadge';
import { ActiveRunsBadge } from './ActiveRunsBadge';
import { LocalComputeBadge } from './LocalComputeBadge';
import { usePortalCommands, usePortalDynamicCommands, groupRank } from './portalCommands';
import { DevboxQuickSwitch, type PaletteScope } from './DevboxQuickSwitch';
import { brandMarkUri, gradientStops } from './brandMark';
import { ToastHost } from './ToastHost';
import { ComputeDock } from '@connorhoehnslalom/ui-components/compute';
import { ASSESSMENT_ENABLED } from '../../lib/features';

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

type Tenant = 'orgiq' | 'assessment' | 'admin';
type NavItem = { path: string; label: string; requireRoles?: string[]; tenant: Tenant | 'universal'; group?: string };

// The app is an SDLC agent platform first — agents that link codebases, run in
// computers, and deliver reviewed changes. The rail IS the SDLC, phase by
// phase: PLAN (what and why — initiatives, sprints-as-a-lens, the money) →
// DESIGN (what the agents know and how they behave — prompts, knowledge) →
// BUILD (the machinery doing the work — queue, bots, computer lab, codebases)
// → RELEASE (what ships — change review today, pipelines eventually) →
// OPERATE (is it healthy) — then ORG (the people layer) and SYSTEM. The same
// hierarchy serves every role; a role simply sees fewer doors per phase
// (an SME gets Build without Codebases, a program owner gets Plan + Release
// without Identity), so an SME and a PM are always looking at one map.


// The palette's hint is the tenant's own vocabulary — "invocation id" and
// "runs" mean nothing to an assessor.
const PALETTE_PLACEHOLDER: Record<string, string> = {
  orgiq: 'Jump to a page, paste an invocation id, search runs…',
  assessment: 'Jump to a page, find a team (TEAM-0NN) or a command…',
};

// ⌘I scopes the same ⌘K dialog down to just the Devbox group (see
// DevboxQuickSwitch's own comment on why there's no real pre-filtered-dialog
// API to open instead). The placeholder used to stay the tenant default even
// while scoped, advertising "paste an invocation id, search runs…" search
// that scope isn't offering — every one of those commands is hidden.
const DEVBOX_PALETTE_PLACEHOLDER = 'Search computers, or + New computer…';

// Tenant/universal items (visible per tenant + role, not just to admins).
const NAV_ITEMS: NavItem[] = [
  // Plan's front door. Sprints are a lens on this page (?lens=sprints), not a
  // sibling item — a sprint is one initiative's iteration.
  { path: '/iq/projects',   label: 'Initiatives', tenant: 'orgiq',     group: 'Plan' },
  // ONE Build door for the whole agentic loop. "Automate" opens on the
  // overview; its sub-rail carries Queue, Findings (DLQ), Bots and Changes —
  // work is automated by a bot configuration on a queue, and when it needs a
  // human it lands in review. Every signed-in role can read the loop.
  { path: '/iq/work',       label: 'Automate',    tenant: 'orgiq',     group: 'Build' },
  // The other half of the loop: Automate is what the fleet DOES, Distillation
  // is what it LEARNED — the run log of the pipeline that turns session
  // observations into reusable runbooks and skills.
  { path: '/iq/distillation/knowledge', label: 'Distillation', tenant: 'orgiq',   group: 'Build' },
  { path: '/iq/local-compute', label: 'Local compute', tenant: 'orgiq', group: 'Build' },
  { path: '/iq/invoke',     label: 'Ask',         tenant: 'orgiq',     group: 'Org' },
  { path: '/iq/explore',    label: 'Explore',     tenant: 'orgiq',     group: 'Org' },
  // Ask is also the "find help" surface: its empty state offers questions
  // from your own work, and answers grow an evidence rail (people + matched
  // skills + documents, score-free) via /api/graph/help. Scores stays the
  // separate HR analytics view — ViewLeaderboard tier, leadership only; an
  // ungated nav item just handed every SME a 403'd leaderboard.
  { path: '/iq/scores',     label: 'Scores',      tenant: 'orgiq',     group: 'Org', requireRoles: ['org-leader', 'hr-admin'] },
  // DESIGN — before anything runs. Designs: the ADR threads where agents
  // ideate a plan on an initiative, people resolve intent and sign off, and
  // the approved decision gates other designs + feeds the knowledge base.
  // Rail order follows the loop: the decision that gates the work (Designs),
  // then what is earning its way in (Promotions), then the approved catalog
  // (Library). Leading with the catalog put the decision third.
  { path: '/iq/designs',    label: 'Designs',     tenant: 'orgiq',     group: 'Design' },
  // What the fleet learned, waiting to become reusable: observations clustered
  // into patterns, promoted by a human into insights, runbooks and skills.
  { path: '/iq/promotions', label: 'Promotions',  tenant: 'orgiq',     group: 'Design' },
  // The Design catalog: everything the fleet is instructed by. Filtered to
  // kind=skill it is the skill browser — a skill and a prompt differ in who
  // invokes them, which is a facet, not a separate product.
  { path: '/iq/library',    label: 'Library',     tenant: 'orgiq',     group: 'Design' },
  // No standalone "Prompts" door: /iq/prompt-ops ("What is deployed") already
  // sits inside the Library's rail, and a second top-level entry to the same
  // page is the duplication this IA keeps removing everywhere else. The
  // Library is the front door; prompt work lives behind it.
  // Release: the session bundle every devbox Claude Code session boots with.
  { path: '/iq/release',    label: 'Session config', tenant: 'orgiq',  group: 'Release' },
  // The assessment tenant is a different product with a different map: not
  // the SDLC arc but the assessment programme's own — ASSESS (the intake and
  // scoring cockpit) → ANALYZE (what the scores say across teams) →
  // INFORMATICS (the knowledge the assessors and agents work from) → SYSTEM.
  // These are the shell rail for that tenant, grouped under its own kickers,
  // exactly as the source app's sidebar is — there is no second rail inside.
  { path: '/assessment/teams',         label: 'Dashboard',     tenant: 'assessment', group: 'Assess' },
  { path: '/assessment/submissions',   label: 'Submissions',   tenant: 'assessment', group: 'Assess' },
  { path: '/assessment/reports',       label: 'Reports',       tenant: 'assessment', group: 'Analyze' },
  { path: '/assessment/feedback',      label: 'Feedback',      tenant: 'assessment', group: 'Analyze' },
  { path: '/assessment/enterprise',    label: 'Enterprise',    tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/workspace',     label: 'Workspace',     tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/prompts',       label: 'Prompts',       tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/rules',         label: 'Rules',         tenant: 'assessment', group: 'Informatics' },
  { path: '/assessment/runs',          label: 'Activity',      tenant: 'assessment', group: 'System' },
  // Every assessment role may READ this — `GET /configuration` is gated
  // `ViewAssessment`, which all three hold, and the page disables every input
  // and hides Save behind `canManage` (program-lead only). The palette was
  // widened to all three when that was settled; this rail entry was not, so
  // an assessor could reach the page by ⌘K or URL and see it render, while
  // the rail insisted it did not exist. `admin` is listed explicitly because
  // the tenant-nav filter has no admin bypass (the PLATFORM_ITEMS one does).
  { path: '/assessment/configuration', label: 'Configuration', tenant: 'assessment', group: 'System',
    requireRoles: ['program-lead', 'assessor', 'lead-assessor', 'admin'] },
  { path: '/settings',      label: 'Settings',    tenant: 'universal', group: 'System' },
];

// Platform/admin surfaces, gated by role and grouped SDLC-first.
const PLATFORM_ITEMS: NavItem[] = [
  // PLAN — the money that funds the plan. Budgets renders directly after
  // Initiatives (in NAV_ITEMS above): the allocation ledger sits beside the
  // initiatives it funds. Read-wide (org-leader + hr-admin); writes are
  // capability-gated inside the page.
  { path: '/admin/budgets',         label: 'Budgets',         tenant: 'admin', requireRoles: ['org-leader', 'hr-admin', 'program-owner'], group: 'Plan' },
  // BUILD — the SDLC core: the repos and the machines agents run on. Bots and
  // Changes are NOT here: they are children of the Automate door above
  // (pages/work/automateNav.tsx), not top-level destinations.
  // 'Codebases', not 'Projects': /iq/projects is already the org's initiatives —
  // epics, features, the people who own them. This is the code that delivers them.
  // RELEASE — what ships to the fleet itself. Session config is the first
  // citizen: the SessionStart hook and bundled skills every Claude Code devbox
  // session boots with. The GitHub pipeline surfaces join this group when they
  // arrive; change review lives under Automate (it is the loop's human gate).
  // 'Computers', not 'Devbox': the page is a fleet of microVMs agents work in,
  // and the top-level menu reads as a place, not a single box.
  //
  // Open to every role that directs agent work, not just the two that
  // administer it: an SME spends an envelope by assigning computers, a program
  // owner runs the cadence those computers serve, and an org-leader funds it.
  // If you can dispatch work onto the fleet you can see the fleet. The list
  // each of them gets is scoped server-side to their own computers plus the
  // ones shared on their initiatives (middleware lib/devbox-visibility.ts), so
  // this is a door, not a key.
  { path: '/admin/devbox',          label: 'Computer Lab',    tenant: 'admin', requireRoles: ['hr-admin', 'sme', 'org-leader', 'program-owner'], group: 'Build' }, // ManageDevbox + the /api/devbox read tier
  // After Computer Lab so the two machine doors (Local compute — your own
  // paired laptop; Computer Lab — the microVM fleet) sit together rather than
  // with the repos wedged between them.
  { path: '/admin/projects',        label: 'Codebases',       tenant: 'admin', requireRoles: ['hr-admin'], group: 'Build' },
  // OPERATE — platform + ops.
  { path: '/admin/observability',   label: 'Observability',   tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  { path: '/iq/agents',             label: 'Architecture',    tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' }, // matches the route guard in App.tsx
  // One entry, not two: sources, ingestion, storage and knowledge bases are
  // consecutive stages of one pipeline. Operate, not Design: the page is the
  // running pipeline — sources pulled, ingestion runs, registry vs the live
  // account — and the palette and the breadcrumb already said so; the rail
  // was the odd one out.
  { path: '/admin/knowledge',       label: 'Knowledge',       tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  { path: '/admin/capabilities',    label: 'Capabilities',    tenant: 'admin', requireRoles: ['org-leader', 'hr-admin'], group: 'Operate' },
  // SYSTEM — administration, not runtime. Identity sits with Settings: who can
  // do what is configuration of the platform, not operating it.
  { path: '/admin/identity',        label: 'Identity',        tenant: 'admin', requireRoles: ['hr-admin'], group: 'System' },
];

const TENANT_LABELS: Record<Tenant, string> = {
  orgiq: 'Org',
  assessment: 'Assessment',
  admin: 'Admin',
};

export function Layout() {
  const { session } = useSession();
  const { data: health } = useFetch<Health>('/api/health', 30_000);
  // /api/work is orgiq-only (requireTenant('orgiq')); polling it from an
  // out-of-tenant session logged a DENY in the authz audit every 15s.
  const { data: work } = useFetch<WorkSummary>(
    session?.tenant === 'orgiq' ? '/api/work/summary' : null, 15_000);
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Routes that render their own SubNavLayout (iq/admin) go
  // full-bleed — the outer p-6 was double-framing them and wasting a 24px
  // ring of content space around every nested layout. Standalone pages
  // (settings, etc.) keep the comfortable padding.
  // One content padding, everywhere: ui-components' SubNavLayout pads its own
  // <main> (24px) and app.css zeroes only the NESTED section layouts' mains
  // (they inherit the shell's), so this column adds none — the old full-bleed
  // list existed to avoid double-padding nested rails and is not needed.
  const rawCommands = usePortalCommands();
  const rawGetDynamicCommands = usePortalDynamicCommands();

  // The palette has exactly one built-in hotkey (⌘K). DevboxQuickSwitch's
  // ⌘I command narrows the same dialog to its own "Devbox" group by asking
  // every OTHER command (static pages + query-derived ones) to hide for as
  // long as it's scoped — the closest a single-palette API gets to "open
  // pre-filtered to a group". Devbox's own commands are registered directly
  // into the palette via useRegisterCommand, so they're untouched by this.
  const [paletteScope, setPaletteScope] = useState<PaletteScope>('all');
  const scopeCommand = useCallback(
    (c: Command): Command => ({
      ...c,
      when: () => (paletteScope === 'devbox' ? false : (c.when ? c.when() : true)),
    }),
    [paletteScope],
  );
  const commands = useMemo(
    () => rawCommands.map(scopeCommand),
    [rawCommands, scopeCommand],
  );
  const getDynamicCommands = useCallback(
    (query: string) => rawGetDynamicCommands(query).map(scopeCommand),
    [rawGetDynamicCommands, scopeCommand],
  );

  const navItems = NAV_ITEMS.filter((item) => {
    if (item.tenant === 'assessment' && !ASSESSMENT_ENABLED) return false;
    if (item.tenant === 'universal') return true;
    if (session?.role === 'admin') return item.tenant === session?.tenant;
    if (item.requireRoles && !(session && item.requireRoles.includes(session.role ?? ''))) return false;
    return item.tenant === session?.tenant;
  });

  // Platform surfaces (Build tooling, Operate, Identity) are org-tenant
  // scoped: a session parked on another tenant gets that tenant's nav,
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
      // The blocked-on-a-human count rides the Delivery door now that the
      // Work queue lives behind it rather than beside it.
      ...(i.path === '/iq/projects' && needsYou > 0 ? { count: needsYou } : {}),
    }))
    // Group order is the tenant's (shared with the palette, portalCommands.ts).
    .sort((a, b) => groupRank(session?.tenant ?? 'orgiq', a.group) - groupRank(session?.tenant ?? 'orgiq', b.group));

  // Guard on shape, not presence: a /api/health body from a restarting or
  // misrouted backend can arrive without `mocks`, and this line used to
  // white-screen the whole shell on it (Object.entries(undefined)).
  const mockedSubsystems = health?.mocks && typeof health.mocks === 'object'
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

  // The tenant mark: the brand gradient's stops, read from this shell's own
  // computed tokens (they live on the [data-tenant] element, so a tenant or
  // theme switch re-reads them), drawn as an SVG data URI for ChannelHeader —
  // which would otherwise hash the label into a colour unrelated to the brand.
  const shellRef = useRef<HTMLDivElement>(null);
  const [brandMark, setBrandMark] = useState<string | undefined>(undefined);

  // The tenant marker ALSO goes on <html>, mirroring how `data-theme` is set
  // (lib/preferences.ts). It has to: custom properties inherit downward only,
  // and the shell <Stack> below is a grandchild of <body> — so
  // `body { background: var(--color-bg) }` resolves the token from :root and
  // can never see the tenant's value. The practical effect was that a tenant
  // could restyle anything INSIDE the app div (buttons, chips, the nav tint)
  // but structurally could not change the page ground, which is why every
  // tenant has so far read as orgiq wearing a different accent. Two files
  // already carry workarounds for the same root cause (ChatSessionPicker,
  // graphOverlay) — they read the token from the tenant element because the
  // ambient one is wrong there.
  const tenantAttr = session?.tenant ?? 'orgiq';
  useEffect(() => {
    document.documentElement.setAttribute('data-tenant', tenantAttr);
  }, [tenantAttr]);
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const stops = gradientStops(cs.getPropertyValue('--background-image-brand-gradient'));
    const brand = cs.getPropertyValue('--color-brand').trim();
    const [from, to] = stops ?? [brand, brand];
    setBrandMark(from ? brandMarkUri(tenantLabel, from, to) : undefined);
  }, [tenantLabel, session?.tenant]);

  return (
    <CommandPaletteProvider commands={commands} getDynamicCommands={getDynamicCommands}>
      <Stack ref={shellRef} gap="none" data-tenant={tenantAttr} className="h-screen">
        {/* First in the tab order, visible only while focused: a keyboard
            user lands on the page content without walking the header, the
            rail and the nested rail first (WCAG 2.4.1, Bypass Blocks). */}
        <SkipLink targetId="main-content" />
        <ChannelHeader
          as="header"
          className="shell-header"
          avatarUrl={brandMark}
          name={tenantLabel}
          description={statusLabel}
          online={mockedSubsystems.length === 0 && !!health && !credsExpired && !dbDown}
          actions={
            <Inline gap="md" wrap>
              <DropdownMenu
                trigger="Navigation"
                triggerLabel={`${tenantLabel} navigation`}
                triggerClassName="md:hidden text-xs"
                className="max-h-[70vh] overflow-y-auto"
                sections={Array.from(new Set(subNavItems.map((item) => item.group))).map((group) => ({
                  label: group,
                  items: subNavItems.filter((item) => item.group === group).map((item) => ({
                    label: item.label,
                    active: pathname === item.path || pathname.startsWith(`${item.path}/`),
                    onSelect: () => navigate(item.path),
                  })),
                }))}
              />
              <CommandPaletteHint />
              {/* The user's own machine in the fleet — renders nothing until
                  a machine is paired, so most sessions never see it.
                  orgiq only, like DevboxQuickSwitch and ComputeDock below:
                  unguarded, it put an orgiq machine (and the initiative and
                  branch it was working on) in the assessment header, with an
                  "Open Computer Lab" action leading out of the tenant. The
                  server filters these nodes by OWNER, which is not the same
                  question as which workspace you are standing in. */}
              {/* What the fleet is running right now. Not tenant-guarded like
                  LocalComputeBadge: the runs are the caller's own org work
                  either way, and losing track of a live run is the failure
                  this exists to prevent. Renders nothing when nothing runs. */}
              <ActiveRunsBadge />
              {session?.tenant === 'orgiq' && <LocalComputeBadge />}
              <GatewayStatusBadge />
              <MasqueradeMenu />
            </Inline>
          }
        />
        <Stack gap="none" className="flex-1 min-h-0" data-shell-nav>
          <SubNavLayout
            title={tenantLabel}
            items={subNavItems}
            railWidth={200}
            storageKey="orgiq-shell"
            railLabel={`${tenantLabel} navigation`}
            renderNavItem={(item, children) => (
              <NavLink
                to={item.path}
                // className, not the inline `style` the composite's own doc
                // comment used to force: ui-components 2.275.1 exports the
                // class-name equivalents of `activeNavItemStyle`, so the whole
                // app's primary rail paints from tokens through Tailwind like
                // every nested rail does. See docs/ui-components-queue.md.
                className={({ isActive }) => {
                  // Two door-widening rules: /iq/sprints still redirects into
                  // the sprints lens (keep Initiatives lit for that instant),
                  // and Bots/Changes live BEHIND the Automate door.
                  const active = isActive || (
                    item.path === '/iq/projects' && pathname.startsWith('/iq/sprints')
                  ) || (
                    item.path === '/iq/work' &&
                    (pathname.startsWith('/admin/bots') || pathname.startsWith('/admin/changes'))
                  ) || (
                    // The rail opens Distillation on Knowledge; Review and
                    // Activity are tabs of the same module.
                    item.path.startsWith('/iq/distillation/') && pathname.startsWith('/iq/distillation')
                  ) || (
                    // The prompt-management family all lives behind Library.
                    item.path === '/iq/library' && (
                      pathname.startsWith('/iq/prompt-ops') ||
                      pathname.startsWith('/iq/prompts') ||
                      pathname.startsWith('/iq/history') ||
                      pathname.startsWith('/iq/diff') ||
                      pathname.startsWith('/iq/evaluations') ||
                      pathname.startsWith('/iq/canary')
                    )
                  );
                  // The library's active class fills with `bg-surface-hover`,
                  // which is right for a nested rail but drops the brand tint
                  // the shell's PRIMARY rail is recorded as carrying
                  // (docs/branding-journeys/*.md measure the active fill as
                  // --color-brand-soft, and `bg-primary-soft` resolves to it
                  // per tenant). Compose rather than fork: structure and the
                  // brand border come from the library, the tint is ours.
                  // It must REPLACE the library's fill rather than sit beside
                  // it: two same-specificity utilities are resolved by
                  // stylesheet order, not class-attribute order, so appending
                  // `bg-primary-soft` silently lost to `bg-surface-hover`.
                  return active
                    ? activeNavItemClassName.replace('bg-surface-hover', 'bg-primary-soft')
                    : inactiveNavItemClassName;
                }}
              >
                {children}
              </NavLink>
            )}
          >
            <Stack gap="none" className="h-full bg-bg">
              {/* Where you are, once you're 3+ levels deep — stacked rails say
                  what you can open, the trail says where you stand. */}
              <Breadcrumbs />
              <Stack id="main-content" tabIndex={-1} gap="none" className="flex-1 min-h-0 overflow-auto outline-none">
                <Outlet />
              </Stack>
            </Stack>
          </SubNavLayout>
        </Stack>
        <CommandPalette
          placeholder={
            paletteScope === 'devbox'
              ? DEVBOX_PALETTE_PLACEHOLDER
              : PALETTE_PLACEHOLDER[session?.tenant ?? 'orgiq'] ?? 'Jump to a page…'
          }
        />
        {/* The Computer Lab is an orgiq surface. Mounting its quick-switch and
            dock in every tenant's shell put orgiq journeys one click away from
            an assessment session — the tenants are separate products on a
            shared BFF, and a session scoped to one must not see the other's
            chrome. */}
        {session?.tenant === 'orgiq' && <DevboxQuickSwitch onScopeChange={setPaletteScope} />}
        <ToastHost />
        {session?.tenant === 'orgiq' && <ComputeDock />}
      </Stack>
    </CommandPaletteProvider>
  );
}
