// Communication — the Social application plane inside the orgiq, assessment
// and pipelines tenants (/iq/communication, /assessment/communication,
// /pipelines/communication). The user, 2026-10-07: "Org calls should be renamed
// Communication and be the social app plane like the tenant features." It
// replaces each tenant's former Calls page; that call log is part of the
// plane's Calls destination, and `/<tenant>/calls` redirects there.
//
// ONE composition with the Social tenant: this page renders the Social
// workspace itself (pages/social/SocialChatWorkspace.tsx — the full
// ConversationRail: Activity, Mentions, Calls, Recordings; Active now; Teams;
// Rooms; Direct messages; Channels; and the conversation surface with Chat |
// Files | Documents | Pinned | Calls), pointed through `SocialPlaneContext` at
// the grant-gated plane router (`/api/social/plane`, the SAME handlers as
// `/api/social/*`, gated on the actor's CURRENT Social grants through
// live-principal.ts) and at this page's own routes. The session never leaves
// its tenant; the shell's one gateway socket, realtime token and call host
// carry chat and calls, and the gateway's guards are unchanged.
//
// The rail per route (the user, 2026-10-13): the plane's home
// (`/<tenant>/communication`) keeps every section — the org context, Teams,
// Rooms, Direct messages, Channels — arrangeable; each sub-route
// (`…/channels`, `…/dms`, `…/teams`, `…/rooms`, `…/calls`, `…/recordings`)
// shows only its own section, the same rule as /social/* (one workspace).
//
// Layout (docs/layout-cascade.md): the primary rail, then the ConversationRail
// as the page's one section rail, flush and full height, then the content
// column whose first row is the trail (Work › Communication) and whose title
// follows it — `SectionContent`.
//
// A session without a Social grant (u-hr, the non-curated SMEs, the pipelines
// cast, the cookie-less demo identity) never mounts the workspace and makes no
// `/api/social` request: it gets the library EmptyState "Ask an admin for
// Social access", and its Calls destination still lists the huddles on its own
// tenant's pages (GET /api/calls/tenant, the source tenant's authority).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { SidePane, ViewportFillRegion } from '@connorhoehn/ui-components';
import { ConversationRail, RAIL_SECTION_CONTENT_INSET, buildRailSection, type ConversationRailSection } from '@connorhoehn/ui-components/social';
import { Button, EmptyState, ExternalLinkIcon, IconButton, Inline, InlineAlert, PhoneIcon, Stack, T } from '@connorhoehn/ui-components/shared';
import { useShellBreadcrumbItems } from '../../components/shell/Breadcrumbs';
import { SectionContent } from '../../components/shell/SectionContent';
import { useTenantCalls } from '../../hooks/usePageCalls';
import { useSession } from '../../lib/auth';
import { tenantEnabled } from '../../lib/features';
import { communicationAccess, communicationPath } from '../../lib/communicationPlane';
import SocialChatWorkspace, { type SocialChatRoute } from '../social/SocialChatWorkspace';
import { SocialPlaneContext, embeddedPlane } from '../social/socialPlane';
import TenantCallLog from './TenantCallLog';
import { useFetch } from '../../hooks/useFetch';
import { useEmbeddedSocial } from '../../components/shell/EmbeddedSocial';
import { writeJson } from '../../lib/writeJson';
import { channelHref, dmHref, type SocialPerson } from '../social/socialChat';
import SharedWorkView from '../social/SharedWorkView';
import { PlaneGroupPane } from '../../components/communication/PlaneGroupPane';
import { OrgTeamPane } from '../../components/communication/OrgTeamPane';
import { PersonSharedWork } from '../../components/communication/PersonSharedWork';
import { CommunicationLanding } from '../../components/communication/CommunicationLanding';
import { sharedItemDetail, workNodeDetail, type PlaneDetail } from '../../components/communication/PlaneDetails';
import { usePlaneOrg, type PlaneOrg } from '../../components/communication/usePlaneOrg';
import { activeQuery, enrichActive, liveLobbies, readPlaneActive } from '../../components/communication/planeSharingModel';
import { ShareNodeForm } from '../../components/communication/WorkSharing';
import { CommunicationAccessState } from '../../components/communication/CommunicationAccessState';
import {
  GROUP_NOUN, GROUP_SECTION_LABEL, ORG_TEAMS_LABEL, groupBindingContext, groupDiscussionChannel, groupRowKey, groupRowPreview,
  orgTeamBindingContext, orgTeamFromRow, orgTeamRowKey, orgTeamRowPreview, parseGroupRef, planeTenant, planeView, planeViewHref, unreadFor,
  type OrgTeam, type PlaneTenant, type PlaneView,
} from '../../components/communication/planeRailModel';

/** The detail pane's width bounds (px), whatever the remembered split. */
const PLANE_DETAIL_WIDTH = { min: 320, max: 420 } as const;

/** Shown instead of rows to an account with no linked org-graph person. */
const UNLINKED_LABEL = 'Link your account to a person to see your groups';

/**
 * The plane's org-context rail sections, as data for the library rail
 * (`buildRailSection`, the rail model): My initiatives / My teams / My
 * pipelines — the host tenant's groups the user belongs to, each naming its
 * bound Social channel or saying its page discussion opens here, with the
 * server's unread and the live-huddle marker — and, in orgiq, My org teams
 * with how many members are online. The rail draws the headings, folds,
 * counts, rows and empty lines.
 */
function planeSections({ org, tenant, query, online, live, view, onSelect }: {
  org: PlaneOrg; tenant: PlaneTenant; query: string; online: ReadonlySet<string>; live: ReadonlySet<string>; view: PlaneView; onSelect(key: string): void;
}): ConversationRailSection[] {
  const active = view?.kind === 'group' ? groupRowKey(view.group) : view?.kind === 'org-team' ? orgTeamRowKey(view.teamId) : null;
  const note = org.linked === false ? UNLINKED_LABEL : null;
  const groups = buildRailSection({
    id: 'plane-groups', label: GROUP_SECTION_LABEL[tenant], items: org.groups, query, active, onSelect,
    key: groupRowKey, name: (g) => g.name,
    row: (group) => {
      const context = groupBindingContext(group);
      const facts = context ? org.bindings.get(context) : undefined;
      const binding = facts?.binding ?? null;
      const channel = groupDiscussionChannel(group);
      // The page discussion's unread is the server's; a bound channel's own unread is on its Channels row.
      const unread = unreadFor(channel, org.unreadThreads);
      return {
        lastMessagePreview: groupRowPreview(group, { binding, bindingUnknown: !!context && !facts }),
        ...(unread > 0 ? { unreadCount: unread } : {}),
        ...(live.has(channel) || (!!binding && live.has(binding.channel)) ? { live: true } : {}),
      };
    },
    state: { loading: org.groupsLoading, error: org.groupsError, noun: GROUP_NOUN[tenant], note },
    'data-testid': 'plane-groups',
  });
  if (tenant !== 'orgiq') return [groups];
  const teams = buildRailSection({
    id: 'plane-org-teams', label: ORG_TEAMS_LABEL, items: org.orgTeams?.teams ?? [], query, active, onSelect,
    key: (team) => orgTeamRowKey(team.id), name: (team) => team.name,
    row: (team) => ({ lastMessagePreview: orgTeamRowPreview(team, online, org.bindings.get(orgTeamBindingContext(team.id))?.binding ?? null) }),
    state: { loading: !org.orgTeams, error: org.orgTeamsError, noun: 'org teams', emptyLabel: 'You are not on an org team yet.', note },
    'data-testid': 'plane-org-teams',
  });
  return [groups, teams];
}

/** A Social destination named by a work-graph node (`/social/channels/x`) opens under this page instead. */
function planeHref(href: string | null, base: string): string | null {
  if (!href) return null;
  return /^\/social\/(channels|dms|teams|rooms|calls|recordings)(\/|\?|$)/.test(href) ? `${base}${href.slice('/social'.length)}` : href;
}

/** The Social plane for a session holding a Social grant: the workspace, shaped by the user's org context. */
function SocialPlaneMount({ route, tenant, base, crumbs, pageCalls, pageMissed }: {
  route: SocialChatRoute; tenant: PlaneTenant; base: string;
  crumbs: ReturnType<typeof useShellBreadcrumbItems>; pageCalls: ReactNode; pageMissed: number;
}) {
  const { session, enterContext } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const me = session?.sub ?? '';
  const socialRole = session?.grants.social?.[0] ?? null;
  const org = usePlaneOrg(tenant);
  const view = planeView(params);
  const here = useEmbeddedSocial()?.presencePeople ?? [];
  const online = useMemo(() => new Set(here.filter((p) => !p.idle).map((p) => p.id)), [here]);
  const capabilities = useFetch<{ actions: Record<string, boolean> }>('/api/social/plane/capabilities', 60_000, { share: true });
  const mayManageTeams = !!capabilities.data?.actions['ManageTeams'];
  const mayManageChannels = !!capabilities.data?.actions['ManageChannels'];
  const peopleFetch = useFetch<{ people: SocialPerson[] }>('/api/social/plane/people', 120_000, { share: true });
  const nameOf = useCallback((userId: string) => peopleFetch.data?.people.find((p) => p.userId === userId)?.displayName ?? userId, [peopleFetch.data]);
  // Active now, enriched per viewer on the server (status, a visible call, activity, shared work), narrowed to the
  // shell's one presence roster — never a second presence subscription.
  const activeQ = activeQuery(here.map((p) => p.id).filter((id) => id !== me));
  const activeFetch = useFetch<unknown>(activeQ ? `/api/social/plane/active${activeQ}` : null, 30_000);
  const active = useMemo(() => readPlaneActive(activeFetch.data), [activeFetch.data]);
  const live = useMemo(() => liveLobbies(active), [active]);

  // Detail in the far-right pane; any navigation closes it.
  const [detail, setDetail] = useState<PlaneDetail | null>(null);
  useEffect(() => { setDetail(null); }, [location.pathname, location.search]);

  const [problem, setProblem] = useState<string | null>(null);
  const startDm = async (userId: string) => {
    const res = await writeJson<{ channel: string }>('/api/social/dms', 'POST', { userId });
    if (res.ok && res.data) navigate(dmHref(res.data.channel, base)); else setProblem(res.error ?? 'The conversation could not be opened.');
  };

  // "Create team channel": a private Social channel named for the org team, then bound to it (`team:<id>`).
  const [creating, setCreating] = useState(false);
  const createTeamChannel = async (team: OrgTeam) => {
    setCreating(true); setProblem(null);
    const created = await writeJson<{ channel: { channel: string; slug: string } }>('/api/social/plane/channels', 'POST',
      { name: team.name, description: `The ${team.name} org team`, privacy: 'private' });
    if (!created.ok || !created.data) { setCreating(false); setProblem(created.error ?? 'The team channel could not be created.'); return; }
    const bound = await writeJson(`/api/social/bindings?context=${encodeURIComponent(orgTeamBindingContext(team.id))}`, 'PUT', { channel: created.data.channel.channel });
    setCreating(false);
    org.refreshBindings();
    if (!bound.ok) { setProblem(bound.error ?? `#${created.data.channel.slug} was created but could not be bound to the team.`); return; }
    navigate(channelHref(created.data.channel.slug, base));
  };

  const selectRow = (rowKey: string) => {
    const group = parseGroupRef(rowKey);
    if (group) {
      const context = groupBindingContext(group);
      const bound = context ? org.bindings.get(context)?.binding : null;
      // A bound group opens its Social channel's conversation; an unbound one its page discussion, here.
      navigate(bound?.slug ? channelHref(bound.slug, base) : planeViewHref(base, { kind: 'group', group }));
      return;
    }
    const teamId = orgTeamFromRow(rowKey);
    if (!teamId) return;
    const bound = org.bindings.get(orgTeamBindingContext(teamId))?.binding;
    if (bound?.slug) navigate(channelHref(bound.slug, base));
    else if (bound?.channel.startsWith('social:team:')) navigate(`${base}/teams?channel=${encodeURIComponent(bound.channel)}`);
    else navigate(planeViewHref(base, { kind: 'org-team', teamId }));
  };
  const openNode = (node: { id: string; title: string; kind: string }, href: string | null) => setDetail(workNodeDetail(node, planeHref(href, base)));
  const footerGroup = view?.kind === 'group' ? org.groups.find(group => group.kind === view.group.kind && group.id === view.group.id) : null;

  const pane = view?.kind === 'group' ? <PlaneGroupPane org={org} group={view.group} base={base} />
    : view?.kind === 'org-team' ? (
      <OrgTeamPane org={org} teamId={view.teamId} me={me} here={here} online={online} mayManageTeams={mayManageTeams && mayManageChannels}
        onCreateTeamChannel={(team) => { void createTeamChannel(team); }} busy={creating}
        onMessage={(userId) => { void startDm(userId); }} onSharedWork={(userId) => navigate(planeViewHref(base, { kind: 'person', userId }))} />
    ) : view?.kind === 'person' && view.userId !== me && peopleFetch.data && !peopleFetch.data.people.some((p) => p.userId === view.userId) ? (
      // An id the plane's directory does not know (D4): a not-found state, never a view titled with the raw id.
      <EmptyState align="start" testId="plane-person-missing" title="No such person here"
        description="Nobody with that id is in your Social directory. Pick someone from Active now or a conversation." />
    ) : view?.kind === 'person' ? (
      <PersonSharedWork userId={view.userId} self={view.userId === me}
        name={view.userId === me ? session?.name ?? me : nameOf(view.userId)} online={online.has(view.userId)}
        onMessage={() => { void startDm(view.userId); }} onOpenNode={openNode}
        onShareNode={(node, refresh) => setDetail({ key: `share:${node.id}`, title: node.title, subtitle: `${node.kind} · share with a conversation`,
          body: <ShareNodeForm node={node} href={planeHref(node.href, base)} onShared={refresh} /> })} />
    ) : null;

  return (
    <>
      <SocialChatWorkspace route={route} embedding={{
        breadcrumbs: crumbs, title: 'Communication', pageCalls, pageMissed,
        // The plane's home keeps every section (org context, Teams, Rooms, DMs, Channels, arrangeable);
        // its sub-routes show one section each, like the Social tenant (the user, 2026-10-13).
        overview: location.pathname.replace(/\/+$/, '') === base,
        pane: pane && problem ? <Stack gap="sm" className="min-h-0 min-w-0 flex-1"><InlineAlert tone="error" onDismiss={() => setProblem(null)}>{problem}</InlineAlert>{pane}</Stack> : pane,
        footerConversation: footerGroup ? { channel: groupDiscussionChannel(footerGroup), title: footerGroup.name } : null,
        // The title row's actions at the app's body step: a small secondary button and an outline icon button, never link text.
        actions: (
          <Inline gap="sm" align="center" wrap={false}>
            <Button variant="secondary" size="sm" onClick={() => navigate(planeViewHref(base, { kind: 'person', userId: me }))} data-testid="communication-my-work">Your work</Button>
            {socialRole && (
              <IconButton variant="outline" size="sm" aria-label="Open in Social" title="Open in Social — the same workspace as its own tenant (switches workspace)"
                icon={<ExternalLinkIcon size={14} />} onClick={() => void enterContext('social', socialRole, '/social/channels')} data-testid="communication-open-social" />
            )}
          </Inline>
        ),
        landing: (data) => (
          <CommunicationLanding base={base} org={org} ready={data.ready} channels={data.channels} conversations={data.conversations}
            activePeople={data.activePeople} active={active} liveLobbies={live} onSelectGroup={selectRow}
            onMessage={(userId) => { void startDm(userId); }} onSharedWork={(userId) => navigate(planeViewHref(base, { kind: 'person', userId }))} />
        ),
        onSelectSharedWork: (userId) => navigate(planeViewHref(base, { kind: 'person', userId })),
        activePeople: (people) => enrichActive(people, active),
        railSections: (rail) => planeSections({ org, tenant, query: rail.query, online: rail.online, live, view, onSelect: selectRow }),
        sharedWork: ({ channel, name, messages }) => (
          <SharedWorkView channel={channel} name={name} messages={messages} plane onOpenNode={openNode}
            onOpenItem={(open) => setDetail(sharedItemDetail(open, () => navigate(location.pathname)))} />
        ),
      }} />
      {/* Detail opens far right first (docs/communication-plane-goal.md §4): the library SidePane, owned by this page. */}
      {detail && <SidePane title={detail.title} {...(detail.subtitle ? { subtitle: detail.subtitle } : {})} onClose={() => setDetail(null)}
        paneId="plane-detail" widthPx={PLANE_DETAIL_WIDTH}>{detail.body}</SidePane>}
    </>
  );
}

export default function CommunicationPlane({ route }: { route: SocialChatRoute }) {
  const { session, sessionStatus, isLoading, refresh, ssoEnabled, signInWithSso } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const crumbs = useShellBreadcrumbItems();
  const access = communicationAccess(session, tenantEnabled('social'));
  const routeTenant = location.pathname.startsWith('/assessment/') ? 'assessment' : location.pathname.startsWith('/pipelines/') ? 'pipelines' : 'orgiq';
  const base = communicationPath(session?.tenant) ?? communicationPath(routeTenant)!;
  const calls = useTenantCalls(sessionStatus === 'ready');
  const pageCalls = <TenantCallLog calls={calls} />;
  const pageMissed = calls.data?.counts.missed ?? 0;

  // Retire the whole private workspace after a confirmed session failure;
  // otherwise each section repeats that same failure as an empty chat.
  if (sessionStatus !== 'ready' || access === 'signed-out') {
    const state = sessionStatus === 'ready' ? 'signed-out' : sessionStatus;
    return <Stack gap="none" className="min-h-0 min-w-0 bg-surface" data-shell-flush
      data-testid="communication-page" data-access={state}>
      <ViewportFillRegion className="flex min-w-0" data-testid="communication-plane">
        <SectionContent breadcrumbs={crumbs} title="Communication" body="fill" data-testid="communication-content">
          <CommunicationAccessState state={state} busy={isLoading}
            {...(state !== 'loading' ? { onRetry: () => void refresh() } : {})}
            onSignIn={() => ssoEnabled ? signInWithSso() : navigate('/workspaces')} />
        </SectionContent>
      </ViewportFillRegion>
    </Stack>;
  }

  const tenant = planeTenant(session?.tenant);
  if (access === 'social' && tenant) {
    return (
      <Stack gap="none" className="min-h-0 min-w-0" data-testid="communication-page" data-access={access}>
        <SocialPlaneContext.Provider value={embeddedPlane(base)}>
          <SocialPlaneMount route={route} tenant={tenant} base={base} crumbs={crumbs} pageCalls={pageCalls} pageMissed={pageMissed} />
        </SocialPlaneContext.Provider>
      </Stack>
    );
  }

  // No Social grant (or Social is off): no Social request at all. At the app's body step, like the Initiatives list
  // (/iq/projects): a 14/600 heading, one 14/400 line, a 12/400 meta line and a small "Open Calls" button.
  const onCalls = route === 'calls';
  const disabled = access === 'social-disabled';
  const openCalls = <Button variant="primary" size="sm" onClick={() => navigate(`${base}/calls`)} data-testid="communication-open-calls">Open Calls</Button>;
  return (
    <Stack gap="none" className="min-h-0 min-w-0 bg-surface" data-shell-flush data-testid="communication-page" data-access={access}>
      <ViewportFillRegion className="flex min-w-0" data-testid="communication-plane">
        {/* The note is a 12px meta line (the rail's own emptyLabel draws 13px, docs/ui-components-queue.md). */}
        <ConversationRail title="Chat" shelfLayout="bar" shelf={[{ id: 'calls', label: 'Calls', icon: <PhoneIcon size={15} />, count: pageMissed, urgent: true }]}
          conversations={[]} selected={onCalls ? { kind: 'shelf', id: 'calls' } : null} onSelect={() => navigate(`${base}/calls`)}
          emptyLabel="" beforeList={(
            <T as="p" size="xs" tone="secondary" wrap className={RAIL_SECTION_CONTENT_INSET} data-testid="communication-rail-note">
              {disabled ? 'Social is turned off here.' : 'Social conversations need a Social grant.'}
            </T>
          )}
          data-testid="social-chat-rail" />
        <SectionContent breadcrumbs={crumbs} title="Communication" body="fill" data-testid="communication-content">
          {onCalls ? pageCalls : (
            <EmptyState align="start" testId="communication-no-social"
              title={disabled ? 'Social is turned off' : 'Ask an admin for Social access'}
              description={(
                <Stack gap="xs">
                  <T>{disabled ? 'Social is not enabled in this deployment.' : 'Your account holds no Social grant, so there are no channels or messages to show.'}</T>
                  <T size="xs" tone="tertiary">The huddles on this workspace’s pages are under Calls.</T>
                </Stack>
              )}
              action={openCalls} />
          )}
        </SectionContent>
      </ViewportFillRegion>
    </Stack>
  );
}
