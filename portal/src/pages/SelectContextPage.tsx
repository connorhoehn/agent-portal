// Post-login chooser, modelled on the AWS access-portal "pick an account →
// assume a role" screen: a GRID of account tiles, each listing the roles you
// hold there, rather than one long scrolling list.
//
// The page answers two DIFFERENT questions, so it has two tabs. Conflating
// them into one list was the original layout's real problem:
//   • Workspaces — which account (tenant), and which role in it. Authorization.
//   • Sign in as — WHO you are. Identity. Dev-only, and a curated cast rather
//     than every row in app_users, because the point is to demo a persona, not
//     to browse a directory.
//
// This page and the header tenant menu share the same authoritative boundary.
// The chooser can pick a role; the compact header menu switches tenants only.
// Entering a workspace hard-navigates via enterContext, which re-mints the
// cookie for the new tenant AND scrubs the previous tenant's client caches
// (auth.tsx → clearTenantScopedCaches). Making that exit legible here is part
// of the security story: a switch is a deliberate act that leaves the current
// workspace behind, not a soft in-place toggle.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { ChoiceList, ChoiceRow } from '@connorhoehn/ui-components';
import { BranchIcon, ChatIcon, ChecklistIcon, GraphIcon, LockIcon, T } from '@connorhoehn/ui-components/shared';
import {
  Avatar,
  Button,
  Card,
  CatalogGrid,
  Chip,
  EmptyState,
  Inline,
  PageHeader,
  PersonHoverCard,
  SearchInput,
  Stack,
  TabPanel,
  Tabs,
} from '@connorhoehn/ui-components/shared';
import { useSession, type DirectoryUser, type Tenant } from '../lib/auth';
import { toastError } from '../lib/toastStore';
import { tenantEnabled } from '../lib/features';
import { orgiqReferenceReturnHref } from '../lib/dmPageReferences';
import { markContextChosen } from '../lib/contextChoice';
import demoPortraits from '../lib/demoPortraits.json';
import { roleGrants } from '../lib/capabilityGrants';

const TENANT_META: Record<Tenant, { label: string; blurb: string; accent: string }> = {
  orgiq: { label: 'Work', blurb: 'Initiatives, people, decisions, and the work you do together', accent: 'var(--color-primary)' },
  assessment: { label: 'Assessment', blurb: 'Engineering-maturity cockpit — teams, evidence, certification', accent: 'var(--color-warning)' },
  social: { label: 'Social', blurb: 'Channels, direct messages, calls and rooms — the people you work with', accent: 'var(--color-tenant-social)' },
  pipelines: { label: 'Pipelines', blurb: 'Definitions, runs and approvals — what the fleet ran, and for whom', accent: 'var(--color-tenant-pipelines)' },
  access: { label: 'Access', blurb: 'Request, approve and audit access — roles and memberships across every workspace', accent: 'var(--color-tenant-access)' },
};

const ROLE_META: Record<string, { label: string; hint: string }> = {
  member: { label: 'Member', hint: 'Search and view the org chart' },
  sme: { label: 'SME', hint: 'Dispatch agent runs against a sprint envelope' },
  'program-owner': { label: 'Program Owner', hint: 'Allocates and grants on their own initiatives; sprints, board and bots' },
  'org-leader': { label: 'Org Leader', hint: 'Leaderboards + transaction approvals' },
  'hr-admin': { label: 'HR Admin', hint: 'People ops, guardrails, identity admin' },
  admin: { label: 'Admin', hint: 'Cross-tenant operator — every role, every account' },
  assessor: { label: 'Assessor', hint: 'Score dimensions, manage submission intake' },
  'lead-assessor': { label: 'Lead Assessor', hint: 'Approve exceptions, publish reports' },
  'program-lead': { label: 'Program Lead', hint: 'Own the assessment program end to end' },
  participant: { label: 'Participant', hint: 'Post in channels and DMs, start and join calls' },
  moderator: { label: 'Moderator', hint: 'Manage channels, teams and recordings' },
  'community-admin': { label: 'Community Admin', hint: 'Own the social workspace — configuration and users' },
  author: { label: 'Author', hint: 'Write, version and dry-run pipeline definitions' },
  operator: { label: 'Operator', hint: 'Run pipelines, approve waiting steps, cancel runs' },
  'pipeline-admin': { label: 'Pipeline Admin', hint: 'Operator plus the workspace configuration and users' },
  requester: { label: 'Requester', hint: 'Request access for yourself and follow its approvals' },
  approver: { label: 'Approver', hint: 'Decide requests from your reports and the resources you steward' },
  'access-admin': { label: 'Access Admin', hint: 'Approver plus the catalog, separation-of-duties policies and provisioning' },
};

/**
 * The curated cast — one identity per persona in the program operating model
 * (docs/program-operating-model.md), in the order you'd walk a demo. The seed
 * carries near-duplicates (three more SMEs, a second org-leader, a bare
 * hr-admin); those are still reachable behind "Show everyone", they just don't
 * earn a slot in the first screen.
 *
 * Curation is BY ID and degrades: an id the directory doesn't carry is
 * skipped, and if none of them match — a deployment with its own users, not
 * our seed — the whole directory becomes the roster rather than an empty tab.
 */
const CURATED: Array<{ id: string; persona: string }> = [
  { id: 'u-operator', persona: 'Platform operator — the only identity that may masquerade' },
  { id: 'u-release', persona: 'Release manager — allocates budgets, grants SME envelopes' },
  // The org leader the audits sign in as (docs/*-journeys/PROTOCOL.md); the
  // roster is curated, and she was missing from it.
  { id: 'u-vera', persona: 'Org leader — leaderboards, approvals, runbook proposals' },
  // Assessment tenant cast — one per persona in docs/assessment-tenant.md.
  // Without these the only way into the assessment product from this
  // picker was the cross-tenant operator, which proves nothing about what an
  // assessor, a lead or a program lead actually sees.
  { id: 'u-asha',  persona: 'Assessor — scores dimensions, manages submission intake' },
  { id: 'u-jonas', persona: 'Lead assessor — approves exceptions, publishes reports' },
  { id: 'u-farah', persona: 'Program lead — owns the assessment programme end to end' },
  { id: 'u-mia', persona: 'Program owner — allocates for their initiatives, runs sprints and the board' },
  { id: 'u-nora', persona: 'SME — spends a sprint envelope by assigning agents to work' },
  { id: 'u-rachel', persona: 'Program operator — identity, guardrails, governance' },
  { id: 'u-theo', persona: 'Member — the read-only floor: search and the org chart' },
  // Social tenant cast — one per role (docs/social-tenant-design.md §4.1),
  // each holding a grant only in social.
  { id: 'u-mira', persona: 'Community admin — owns the social workspace, its configuration and users' },
  { id: 'u-lena', persona: 'Moderator — manages channels, teams and recordings' },
  { id: 'u-sana', persona: 'Participant — posts, messages and calls; moderates nothing' },
  // Pipelines tenant cast — one per role (docs/pipelines-tenant-goal.md §Cast),
  // each holding a grant only in pipelines.
  { id: 'u-ines', persona: 'Pipeline author — writes and dry-runs definitions, never approves them' },
  { id: 'u-kofi', persona: 'Pipeline operator — runs, approves and cancels, never writes a definition' },
  { id: 'u-dara', persona: 'Pipeline admin — an operator plus configuration and users' },
  // Also holds Social (the Communication-plane walker); outside the pure pipelines-only cast.
  { id: 'u-tomas', persona: 'Pipeline author with Social — writes definitions and joins the Communication plane' },
  // Access tenant cast — one per role (docs/access-tenant-goal.md §Cast),
  // each holding a grant only in access.
  { id: 'u-rhea', persona: 'Requester — asks for roles and memberships, never decides them' },
  { id: 'u-omar', persona: "Approver — Rhea's manager; decides requests, never configures or grants by hand" },
  { id: 'u-priya', persona: 'Access admin — the catalog, separation-of-duties policies and provisioning' },
];

function roleLabel(role: string): string { return ROLE_META[role]?.label ?? role; }
function tenantLabel(tenant: string): string { return TENANT_META[tenant as Tenant]?.label ?? tenant; }

// Per-tenant tile tint, as whole class strings so Tailwind's scanner sees
// every one (a composed `border-${x}` would not be generated).
const TENANT_MARK_TINT: Record<Tenant, string> = {
  orgiq: 'border-primary bg-primary/10 text-primary',
  assessment: 'border-warning bg-warning/10 text-warning',
  social: 'border-tenant-social bg-tenant-social/10 text-tenant-social',
  pipelines: 'border-tenant-pipelines bg-tenant-pipelines/10 text-tenant-pipelines',
  access: 'border-tenant-access bg-tenant-access/10 text-tenant-access',
};

/** Inline tenant mark — a tinted rounded badge with a per-tenant glyph. No
 *  external assets. Purely decorative, so aria-hidden.
 *
 *  Fixed at 34px (the badge's one real call site never asks for another
 *  size) so the tint/size can be plain per-tenant Tailwind classes instead
 *  of a computed `style` object — the validator now bans a JSX `style=` prop
 *  even when the object is hoisted to a named const. */
function TenantMark({ tenant }: { tenant: Tenant }) {
  // Library glyphs paint in currentColor, so the tint class carries the accent.
  const glyph =
    tenant === 'assessment' ? <ChecklistIcon size={18} />
    : tenant === 'social' ? <ChatIcon size={18} />
    : tenant === 'pipelines' ? <BranchIcon size={18} />
    : tenant === 'access' ? <LockIcon size={18} />
    : <GraphIcon size={18} />;
  return (
    <Inline
      as="span"
      aria-hidden
      align="center"
      justify="center"
      gap="none"
      className={`inline-flex shrink-0 w-[34px] h-[34px] rounded-[9px] border ${TENANT_MARK_TINT[tenant] ?? TENANT_MARK_TINT.orgiq}`}
    >
      {glyph}
    </Inline>
  );
}

export default function SelectContextPage() {
  const { session, enterContext, logout, ssoEnabled, signInWithSso, listUsers, login } = useSession();
  const [params] = useSearchParams();
  const referenceReturn = orgiqReferenceReturnHref(params.get('to'));

  // The dev sign-in list. This page is the pre-app boundary, which makes it
  // the right — and now only — home for the user picker: the header menu
  // stopped listing people deliberately, and Identity → Users needs a role
  // most identities do not hold. Without this, signing out in dev stranded
  // you on a chooser whose Enter buttons cannot work (the cookie-less demo
  // identity has grants to render but no session to re-scope) and no way to
  // become anyone. SSO deployments never see it — the real IdP is the way in.
  const [directory, setDirectory] = useState<DirectoryUser[] | null>(null);
  useEffect(() => {
    if (ssoEnabled) return;
    let cancelled = false;
    listUsers().then((users) => { if (!cancelled) setDirectory(users); }).catch(() => setDirectory([]));
    return () => { cancelled = true; };
  }, [ssoEnabled, listUsers]);

  // Build the account → roles structure from what the identity may SWITCH
  // to, with the assessment filter applied. For a real user that is its grants. For the
  // demo persona the session is narrowed to the one role it picked (so an
  // SME demo really is an SME everywhere else in the app) while this picker
  // keeps offering every persona — otherwise a demo dead-ended at one tile
  // with Sign out as the only way to another role.
  const accounts = useMemo(() => {
    const grants = session?.switchable ?? session?.grants ?? {};
    return (Object.keys(grants) as Tenant[])
      .filter(t => tenantEnabled(t))
      .filter(t => roleGrants(grants, t).length > 0)
      .map(t => ({ tenant: t, roles: roleGrants(grants, t).sort() }));
  }, [session?.switchable, session?.grants]);

  const roleCount = accounts.reduce((n, a) => n + a.roles.length, 0);

  // Split the directory into the curated cast and everyone else. When none of
  // the curated ids exist here, the directory IS the cast — better a full list
  // than a tab that renders nothing on a deployment with its own users.
  const { cast, others } = useMemo(() => {
    const all = directory ?? [];
    const byId = new Map(all.map(u => [u.id, u]));
    const picked = CURATED
      .map(c => { const user = byId.get(c.id); return user ? { user, persona: c.persona } : null; })
      .filter((x): x is { user: DirectoryUser; persona: string } => x !== null);
    if (picked.length === 0) return { cast: all.map(user => ({ user, persona: '' })), others: [] };
    const pickedIds = new Set(picked.map(p => p.user.id));
    return { cast: picked, others: all.filter(u => !pickedIds.has(u.id)) };
  }, [directory]);

  const peopleEnabled = !ssoEnabled && cast.length > 0;

  // Which tab is showing. Null means "not chosen yet" so the default can follow
  // the situation: an identity with no grants has nothing to pick on the
  // workspaces tab, and becoming someone else is its only way forward.
  const [tab, setTab] = useState<string | null>(null);
  const activeTab = tab ?? (accounts.length === 0 && peopleEnabled ? 'people' : 'workspaces');

  // Filter across both axes an AWS account tile is found by: the account and
  // the role. An account survives if it matches itself OR keeps any role.
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    const hit = (s: string) => s.toLowerCase().includes(q);
    return accounts
      .map(({ tenant, roles }) => {
        const accountHit = hit(tenant) || hit(tenantLabel(tenant));
        const kept = accountHit ? roles : roles.filter(r => hit(r) || hit(roleLabel(r)) || hit(ROLE_META[r]?.hint ?? ''));
        return { tenant, roles: kept };
      })
      .filter(a => a.roles.length > 0);
  }, [accounts, query]);

  const [showEveryone, setShowEveryone] = useState(false);
  // The row the user pressed, held until the hard redirect lands. The server
  // answers in milliseconds; the seconds that follow are the browser loading
  // the workspace, and without this the pressed row showed nothing at all.
  const [pending, setPending] = useState<{ tenant: Tenant; role: string } | null>(null);

  async function choose(tenant: Tenant, role: string) {
    if (pending) return;
    setPending({ tenant, role });
    // Mark chosen before entering, since enterContext hard-redirects into the
    // workspace (re-driving the layout from the re-minted cookie).
    markContextChosen(session?.sub ?? '');
    try {
      await enterContext(tenant, role, tenant === 'orgiq' ? referenceReturn : undefined);
    } catch (err) {
      setPending(null);
      // enterContext hard-navigates on success, so a swallowed failure has NO
      // observable outcome — a chooser full of buttons that sometimes do
      // nothing. The cookie-less fallback identity hits exactly this: the
      // permissive demo grants render every workspace, but there is no real
      // session to re-scope, so every Enter fails. Say so, and the people tab
      // is the way forward.
      toastError(null, 'Could not enter that workspace', (err as Error).message);
    }
  }

  const name = session?.name ?? session?.sub ?? 'you';
  // Your own face, from the directory the people tab already loaded (initials when absent).
  const selfAvatar = directory?.find(u => u.id === session?.sub)?.avatarUrl ?? undefined;
  const currentTenant = session?.tenant;
  const currentRole = session?.role;

  // A demo identity should not be choosing real workspaces when a real IdP is
  // configured — offer the actual sign-in instead of the grant list.
  const demoWithRealIdp = session?.sub === 'demo-user' && ssoEnabled;

  if (demoWithRealIdp) {
    return (
      <Screen>
        <Stack gap="none" className="mx-auto max-w-xl py-16">
          <EmptyState
            title="Sign in to continue"
            description={
              <>
                You're on the fallback <strong>demo-user</strong> identity, but this
                deployment has enterprise sign-in configured. Sign in with your real
                identity to choose a workspace.
              </>
            }
            actions={[
              { label: 'Sign in with SSO', onClick: () => signInWithSso(), variant: 'primary' },
              { label: 'Sign out', onClick: () => void logout(), variant: 'secondary' },
            ]}
          />
        </Stack>
      </Screen>
    );
  }

  const onPeople = peopleEnabled && activeTab === 'people';

  return (
    <Stack gap="none" className="min-h-screen bg-[var(--color-bg)]">
      {/* Band 1 — chrome. Brand on the left, identity and the way out on the
          right, exactly where an app's top nav puts them. */}
      <Band>
        <Inline wrap align="center" justify="between" gap="sm" className="py-2.5">
          <T size="sm" className="font-bold tracking-[0.14em] text-[var(--color-primary)] uppercase">
            Work
          </T>
          <Inline align="center" gap="sm">
            <Avatar name={name} size={24} src={selfAvatar} />
            <T size="sm" className="font-semibold text-[var(--color-text-primary)]">{name}</T>
            <Button variant="ghost" size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </Inline>
        </Inline>
      </Band>

      {/* Band 2 — what this screen is, and the tabs, anchored to the band's
          bottom edge so the active tab reads as connected to the panel below. */}
      <Band>
        <Stack gap="none" className="pt-6">
          <PageHeader
            title={onPeople ? 'Sign in as someone else' : 'Choose a workspace'}
            description={
              onPeople
                ? 'Changes who you are, not which workspace you are in — you land back here to pick an account with that person’s grants.'
                : `Signed in as ${name}. Pick an account, then the role to assume in it.`
            }
            badge={
              <Inline align="center" gap="xs">
                {currentTenant && (
                  <Chip tone="info" size="sm" title="The workspace you are in now">
                    in {tenantLabel(currentTenant)} · {roleLabel(currentRole ?? '')}
                  </Chip>
                )}
                {onPeople && <Chip tone="warning" size="xs" uppercase>dev only</Chip>}
              </Inline>
            }
          />
        </Stack>
        {referenceReturn && <T size="sm" className="text-text-secondary" wrap>Choose an Work workspace role to open the shared page.</T>}
        {peopleEnabled ? (
          <Tabs
            className="-mb-px"
            aria-label="Choose a workspace or a different identity"
            idPrefix="selctx"
            variant="underline"
            value={activeTab}
            onValueChange={setTab}
            items={[
              { id: 'workspaces', label: 'Workspaces', badge: <Chip size="xs" mono>{roleCount}</Chip> },
              { id: 'people', label: 'Sign in as', badge: <Chip size="xs" mono>{cast.length}</Chip> },
            ]}
          />
        ) : (
          <Stack gap="none" className="pb-5" />
        )}
      </Band>

      {/* Band 3 — the content itself, on the tinted page ground so the two
          surface bands above read as chrome rather than more content. */}
      <Stack gap="none" className="mx-auto w-full max-w-5xl px-6 py-8">
      <TabPanel id="workspaces" when={activeTab} idPrefix="selctx">
        {/* The security story, said once, in prose — not a banner competing
            with the grid for the top of the page. */}
        {currentTenant && (
          <T size="xs" as="p" className="mb-5 max-w-2xl leading-relaxed text-[var(--color-text-tertiary)]">
            Entering another workspace fully leaves this one — your session is re-scoped to
            that tenant and this tenant's cached data is cleared from the browser.
          </T>
        )}

        {roleCount > 5 && (
          <Inline align="center" gap="sm" className="mb-4">
            <SearchInput
              value={query}
              onChange={setQuery}
              onClear={() => setQuery('')}
              placeholder="Filter accounts and roles"
              aria-label="Filter accounts and roles"
              className="max-w-xs"
            />
            <T size="xs" className="text-[var(--color-text-tertiary)]">
              {filtered.length} account{filtered.length === 1 ? '' : 's'} ·{' '}
              {filtered.reduce((n, a) => n + a.roles.length, 0)} role
              {filtered.reduce((n, a) => n + a.roles.length, 0) === 1 ? '' : 's'}
            </T>
          </Inline>
        )}

        {accounts.length === 0 ? (
          <EmptyState
            title="No workspace grants"
            body={
              peopleEnabled
                ? 'This identity holds no workspace grants. Sign in as someone else, or ask an administrator to add you from Identity → Users.'
                : 'Your account holds no workspace grants. An administrator can add you from Identity → Users; until then there is nothing to enter.'
            }
            actions={[
              ...(peopleEnabled
                ? [{ label: 'Sign in as someone else', onClick: () => setTab('people'), variant: 'primary' as const }]
                : []),
              { label: 'Sign out', onClick: () => void logout(), variant: 'secondary' as const },
            ]}
          />
        ) : filtered.length === 0 ? (
          <EmptyState title="No match" body={`Nothing matches "${query}".`} actionLabel="Clear filter" onAction={() => setQuery('')} />
        ) : (
          // Equal rows (auto-rows-fr) and full-height cards: every workspace card
          // is the same size, whatever its role count (user direction, 2026-10-07).
          <CatalogGrid columns={3} className="auto-rows-fr" data-testid="select-workspace-grid">
            {filtered.map(({ tenant, roles }) => {
              const isCurrentAccount = currentTenant === tenant;
              return (
                <Card
                  key={tenant}
                  padding="none"
                  className="flex h-full flex-col overflow-hidden"
                  aria-label={`${tenantLabel(tenant)} workspace`}
                >
                  <Inline align="start" gap="sm" className="border-b border-[var(--color-border)] bg-[var(--color-surface-panel)] px-4 py-3">
                    <TenantMark tenant={tenant} />
                    <Stack gap="none" className="min-w-0 flex-1">
                      <Inline align="center" gap="xs">
                        <T size="sm" className="truncate font-bold text-[var(--color-text-primary)]">
                          {tenantLabel(tenant)}
                        </T>
                        {isCurrentAccount && <Chip tone="info" size="xs" uppercase>current</Chip>}
                      </Inline>
                      <T size="xs" tone="tertiary" className="mt-0.5 block truncate">
                        {roles.length} role{roles.length === 1 ? '' : 's'}
                      </T>
                    </Stack>
                  </Inline>

                  <T size="xs" as="p" className="px-4 pt-3 pb-1 leading-relaxed text-[var(--color-text-tertiary)]">
                    {TENANT_META[tenant]?.blurb}
                  </T>

                  {/* Library rows (ChoiceList/ChoiceRow, 2026-09-29): a title
                      and a one-line hint per role. These were two-line labels
                      inside a `Button`, and the library's one-box-per-size
                      button (h-9 since 2.407.14) clipped the hint. */}
                  <ChoiceList className="mt-2" data-testid={`select-roles-${tenant}`}>
                    {roles.map(role => {
                      const isCurrent = isCurrentAccount && currentRole === role;
                      return (
                        <ChoiceRow
                          key={role}
                          title={roleLabel(role)}
                          description={ROLE_META[role]?.hint ?? role}
                          selected={isCurrent}
                          busy={pending?.tenant === tenant && pending?.role === role}
                          disabled={pending != null && !(pending.tenant === tenant && pending.role === role)}
                          onSelect={() => void choose(tenant, role)}
                          data-testid={`select-role-${tenant}-${role}`}
                        />
                      );
                    })}
                  </ChoiceList>
                </Card>
              );
            })}
          </CatalogGrid>
        )}
      </TabPanel>

      {peopleEnabled && (
        <TabPanel id="people" when={activeTab} idPrefix="selctx">
          <CatalogGrid columns={3} className="auto-rows-fr" data-testid="select-people-grid">
            {cast.map(({ user, persona }) => (
              <UserCard
                key={user.id}
                user={user}
                persona={persona}
                isCurrent={user.id === session?.sub}
                onPick={() => pick(user)}
              />
            ))}
          </CatalogGrid>

          {others.length > 0 && (
            <Stack gap="none" className="mt-5">
              <Button variant="ghost" size="sm" onClick={() => setShowEveryone(v => !v)}>
                {showEveryone ? 'Show only the demo cast' : `Show everyone (${others.length} more)`}
              </Button>
              {showEveryone && (
                <Stack gap="none" className="mt-4">
                  <CatalogGrid columns={3} className="auto-rows-fr" data-testid="select-others-grid">
                    {others.map(user => (
                      <UserCard
                        key={user.id}
                        user={user}
                        persona=""
                        isCurrent={user.id === session?.sub}
                        onPick={() => pick(user)}
                      />
                    ))}
                  </CatalogGrid>
                </Stack>
              )}
            </Stack>
          )}
          </TabPanel>
        )}
      </Stack>
    </Stack>
  );

  function pick(user: DirectoryUser) {
    login(user.id).catch((err: unknown) =>
      toastError(null, `Could not sign in as ${user.displayName}`, (err as Error).message));
  }
}

/** One identity, as a card: who they are, what they can reach, and the verb.
 *  The name carries a PersonHoverCard so the full per-tenant grant list is one
 *  hover away without the card itself growing into a wall of chips. */
function UserCard({
  user, persona, isCurrent, onPick,
}: {
  user: DirectoryUser;
  persona: string;
  isCurrent: boolean;
  onPick: () => void;
}) {
  const portraitPersona = demoPortraits.personas.find(p => p.userId === user.id && p.name === user.displayName);
  const tenants = user.tenants
    .filter(t => tenantEnabled(t.tenant));
  return (
    <Card padding="none" className="flex h-full flex-col overflow-hidden" data-testid="select-user-card">
      <Inline align="start" gap="sm" className="px-4 pt-4">
        <Avatar name={user.displayName} size={36} src={user.avatarUrl ?? undefined} />
        <Stack gap="none" className="min-w-0 flex-1">
          <Inline align="center" gap="xs">
            <PersonHoverCard
              person={{
                userId: user.id,
                displayName: user.displayName,
                email: user.email ?? undefined,
                avatarUrl: user.avatarUrl ?? undefined,
                title: persona ? persona.split(' — ')[0] : undefined,
                department: tenants.map(t => tenantLabel(t.tenant)).join(' · ') || undefined,
              }}
              details={
                <Stack gap="xs">
                  {portraitPersona && <T size="sm" wrap>{portraitPersona.biography}</T>}
                  {tenants.map(t => (
                    <Inline key={t.tenant} wrap align="center" gap="xs">
                      <T size="xs" className="font-semibold text-[var(--color-text-secondary)]">
                        {tenantLabel(t.tenant)}
                      </T>
                      {t.roles.map(r => (
                        <Chip key={r} size="xs" tone="neutral">{roleLabel(r)}</Chip>
                      ))}
                    </Inline>
                  ))}
                </Stack>
              }
            >
              <T size="sm" className="truncate font-bold text-[var(--color-text-primary)]">
                {user.displayName}
              </T>
            </PersonHoverCard>
            {isCurrent && <Chip tone="info" size="xs" uppercase>you</Chip>}
          </Inline>
          {user.email && (
            <T size="xs" className="mt-0.5 block truncate text-[var(--color-text-tertiary)]">
              {user.email}
            </T>
          )}
        </Stack>
      </Inline>

      {persona && (
        <T size="xs" as="p" className="line-clamp-3 px-4 pt-2.5 leading-relaxed text-[var(--color-text-secondary)]" title={persona}>
          {persona}
        </T>
      )}

      <Inline wrap gap="xs" className="mt-3 mb-4 px-4">
        {tenants.map(t => (
          <Chip key={t.tenant} size="xs" tone={t.tenant === 'assessment' ? 'accent' : 'neutral'}>
            {tenantLabel(t.tenant)} · {t.roles.map(roleLabel).join(', ')}
          </Chip>
        ))}
      </Inline>

      {/* mt-auto pins the action row to the card's foot, so it lines up across a row of equal-height cards. */}
      <Stack gap="none" className="mt-auto border-t border-[var(--color-border)] px-4 py-2.5">
        {/* Label is the bare verb: the card above already names the person,
            and a first-name split turns "Platform Operator" into "Platform".
            The full name goes to the accessible name instead. */}
        <Button
          variant={isCurrent ? 'ghost' : 'secondary'}
          size="sm"
          fullWidth
          disabled={isCurrent}
          onClick={onPick}
          aria-label={isCurrent ? `Signed in as ${user.displayName}` : `Sign in as ${user.displayName}`}
        >
          {isCurrent ? 'Signed in' : 'Sign in'}
        </Button>
      </Stack>
    </Card>
  );
}

/** One full-bleed horizontal band, with the content held to the page measure.
 *  The chooser is composed of three of them — chrome, header, content — because
 *  a single flat field gives the eye nothing to divide the page by. The rule
 *  and the surface/ground shift do that work; both are deliberately quiet, a
 *  step of tint rather than a block of colour. */
function Band({ children }: { children: ReactNode }) {
  return (
    <Stack gap="none" className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <Stack gap="none" className="mx-auto w-full max-w-5xl px-6">{children}</Stack>
    </Stack>
  );
}

/** Full-bleed chooser shell — this screen sits outside the app Layout, so it
 *  owns its own page background and content measure. Used by the SSO branch,
 *  which is a single centred message with no bands to divide. */
function Screen({ children }: { children: ReactNode }) {
  return (
    <Stack gap="none" className="min-h-screen bg-[var(--color-bg)] px-6 py-10">
      <Stack gap="none" className="mx-auto w-full max-w-5xl">{children}</Stack>
    </Stack>
  );
}
