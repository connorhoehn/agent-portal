// The social tenant's chat workspace — ONE composition that /social/channels,
// /social/dms, /social/teams, /social/rooms, /social/calls and
// /social/recordings all render (docs/social-tenant-design.md §4.5;
// docs/rail-parity-goal.md, "the chat-rail variant"). The route decides what
// the pane opens on — a channel, a DM, a team's channel or roster, a room, the
// call log, the recordings — AND which rail section shows: one section per
// route (the user, 2026-10-13; `railSectionsFor` in socialChat.ts, the
// library's `ConversationRail showSections`). Channels shows only Channels,
// Direct messages only Direct messages, Teams only Teams, Rooms only Rooms;
// Calls and Recordings are shelf destinations and show no section. The shelf
// and Active now stay on every route. Contacts and Configuration stay pages.
// Embedded, the Communication plane's home (`embedding.overview`) is the one
// rail that keeps every section (and Arrange); its sub-routes follow the rule.
//
// It is the chat app's left sidebar, the way realtime-examples' MessagesPage
// draws it, from the library's parts: `ConversationRail` flush against the
// shell rail, full height, with
//
//   - the shelf: Activity (the workspace's unread inbox count), Mentions,
//     Calls (the missed count; the log is CallLogPane.tsx) and Recordings
//     (RecordingsPane.tsx) — destinations that are not conversations;
//   - "Active now": who is in the workspace (presence on `social:lobby`),
//     as the library's `ActivePeopleGrid` — a tile opens a DM with them;
//   - Teams: the library's `TeamChannelTree` (+ New team for ManageTeams;
//     a team's ⋯ opens its roster or leaves it);
//   - Rooms: the library's hook-bound rooms section (SocialRoomsSection.tsx —
//     ConversationRail has no rooms group); a row opens the room (RoomPane.tsx);
//   - Direct messages, then Channels (`sectionOrder="dms-first"`), each with
//     its + (New message; Create a channel for ManageChannels).
//
// Each section above appears only on its own route (see the head).
//
// An open conversation is SocialConversation (the library's conversation
// surface: Chat | Documents | Pinned | Calls, `?view=` in the URL, the call
// actions and the ⋯ menu).
//
// The page root is `data-shell-flush`: the shell draws no 24px ring and no
// breadcrumb row around it, so the rail starts at the content top at x=200.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import {
  ActivePeopleGrid, AddPeoplePicker, ChannelMentionsPanel, ConversationRail, CreateChannelDialog, CreateTeamDialog, MembersPanel,
  NewConversationPanel, RAIL_SECTION_CONTENT_INSET, RailSectionHeader, TeamChannelTree, useRailSectionMemory,
  type ActivePerson, type ConversationRailSection, type CreateChannelDialogInput, type CreateTeamDialogInput, type RailSelection,
} from '@connorhoehnslalom/ui-components/social';
import {
  ActivityIcon, AtIcon, Button, ChannelHeader, EmptyState, ErrorState, IconButton, InlineAlert, LoadingState,
  PhoneIcon, PlayCircleIcon, PlusIcon, Stack, VisuallyHidden,
} from '@connorhoehnslalom/ui-components/shared';
import { WrappedNotificationCenter } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { useSharedNotifications } from '../../components/shell/SharedNotifications';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { useEmbeddedSocial } from '../../components/shell/EmbeddedSocial';
import SocialConversation, { conversationView } from './SocialConversation';
import CallLogPane, { type CallsResponse } from './CallLogPane';
import RecordingsPane from './RecordingsPane';
import { roomSummaryTargets } from './socialRoomSummary';
import RoomPane from './RoomPane';
import SocialRoomsSection, { RoomCreateDialog, useRoomsModel, type RoomsResponse } from './SocialRoomsSection';
import {
  CHANNEL_PREFIX, DM_PREFIX, activeNow, railSectionsFor, channelHref, channelRailItems, dmCandidates, dmHref, dmPeers, dmRailItems, dmTitle,
  conversationRecordings, matchesRailFilter, mentionItems, privacyForApi, slugFromChannel, socialInbox, withPresence,
  type SocialActivePerson, type SocialChannel, type SocialDm, type SocialPeer, type SocialPerson,
} from './socialChat';
import type { SharedWorkMessage } from './SharedWorkView';
import { newMessageChannels } from './socialRailLive';
import {
  findTeamChannel, namesFrom, teamCandidates, teamTreeItems,
  type SocialRecording, type SocialTeam, type SocialTeamMember,
} from './socialPlatform';
import { useSocialCall, useSocialFooterContext, type SocialFooterContext } from './useSocialCall';
import { useSocialTeams } from './useSocialTeams';
import { useSocialPlane } from './socialPlane';
import { SectionContent } from '../../components/shell/SectionContent';
import { SectionLabel, useHeaderDensity } from '@connorhoehnslalom/ui-components/shared';
import { SocialReadStatus } from './SocialReadStatus';
import { conversationRailEmptyLabel } from './socialReadState';

export type SocialChatRoute = 'channels' | 'dms' | 'teams' | 'rooms' | 'calls' | 'recordings';

interface TeamDetail { team: SocialTeam; members: SocialTeamMember[] }
type Candidate = { userId: string; displayName: string; hint?: string };
/** Shelf destinations kept in local state; Calls and Recordings are routes. */
type Shelf = 'activity' | 'mentions';

const PAGE_TITLE: Record<SocialChatRoute, string> = {
  channels: 'Channels', dms: 'Direct messages', teams: 'Teams', rooms: 'Rooms', calls: 'Calls', recordings: 'Recordings',
};
const PAGE_TESTID: Record<SocialChatRoute, string> = {
  channels: 'social-channels-page', dms: 'social-dms-page', teams: 'social-teams-page',
  rooms: 'social-rooms-page', calls: 'social-calls-page', recordings: 'social-recordings-page',
};
interface RecordingsResponse { recordings: SocialRecording[] }
/**
 * The rail's per-device memory (the library rail model, `useRailSectionMemory`):
 * folded sections under `social.chatRail.folded`, the reader's section order
 * under `social.chatRail.layout`. Sections folded until the reader opens them
 * (the user, 2026-10-07: "by default some of them should be collapsed"):
 * Teams and Rooms. Active now, the plane's groups, Direct messages and
 * Channels open.
 */
const RAIL_MEMORY_KEY = 'social.chatRail';
const DEFAULT_FOLDED: Readonly<Record<string, boolean>> = { Teams: true, Rooms: true };

/**
 * Embedded as another tenant's Communication page (socialPlane.ts): the pane
 * becomes that page's content column — its trail first, then its title
 * (docs/layout-cascade.md) — and the Calls destination also lists the huddles
 * on that tenant's own pages (its former Calls page).
 */
export interface WorkspaceEmbedding {
  breadcrumbs: ComponentProps<typeof SectionContent>['breadcrumbs'];
  title: string;
  actions?: ReactNode;
  pageCalls: ReactNode;
  pageMissed: number;
  /**
   * The host tenant's org-context sections (docs/communication-plane-goal.md
   * §1.3–1.4), placed after Active now. Built outside pages/social: this
   * workspace never names another tenant's routes.
   */
  railSections?: (rail: WorkspaceRailContext) => readonly ConversationRailSection[];
  /** The host's own view in the content column (a group, an org team, a person), or null for the workspace's pane. */
  pane?: ReactNode | null;
  /** Authorized host-thread context; start uses this workspace's single call hook. */
  footerConversation?: { channel: string; title: string } | null;
  /** Active now, enriched by the host (status, in a call, activity, shared work); never a second presence subscription. */
  activePeople?: (people: readonly SocialActivePerson[]) => ActivePerson[];
  /** A tile's shared-work affordance (`ActivePeopleGrid onSelectSharedWork`). */
  onSelectSharedWork?: (userId: string) => void;
  /** The open conversation's Shared work view (`?view=shared`), beside Chat | Files | Documents | Pinned | Calls. */
  sharedWork?: (conversation: { channel: string; name: string; messages: readonly SharedWorkMessage[] }) => ReactNode;
  /**
   * The plane's landing when no conversation is named (Channels, no slug): the
   * host opens the user's default conversation or draws its overview — never a
   * "Pick a channel" placeholder (docs/layout-cascade.md rule 6).
   */
  landing?: (data: WorkspaceLandingData) => ReactNode;
  /**
   * The plane's home (`/<tenant>/communication`, no sub-route): the one rail
   * that keeps every section — the host's org context, Teams, Rooms, Direct
   * messages, Channels — in the reader's arrangeable order. Every sub-route
   * shows one section, as in the Social tenant.
   */
  overview?: boolean;
}

/** What the workspace hands the host's landing: its own lists and Active now tiles, no second fetch. */
export interface WorkspaceLandingData {
  /** The channel and DM lists have answered (with data or an error). */
  ready: boolean;
  channels: readonly SocialChannel[];
  conversations: readonly SocialDm[];
  activePeople: ComponentProps<typeof ActivePeopleGrid>['people'];
}

/** What the workspace hands a host rail section: the find box and presence. Folds are the rail's own (data sections, keyed by label). */
export interface WorkspaceRailContext {
  query: string;
  online: ReadonlySet<string>;
  here: ReadonlyArray<{ id: string; name: string; idle?: boolean }>;
}

export default function SocialChatWorkspace({ route, embedding }: { route: SocialChatRoute; embedding?: WorkspaceEmbedding }) {
  const { slug: rawSlug, lobby: rawLobby } = useParams<{ slug?: string; lobby?: string }>();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { session } = useSession();
  const me = session?.sub ?? '';
  const displayName = session?.name ?? me;
  const plane = useSocialPlane();
  const { api, route: base } = plane;
  const tenantCapabilities = useCapabilities();
  // Embedded in another tenant, `can()` there answers for THAT tenant; the
  // plane asks the actor's current Social grants instead (GET …/capabilities).
  const planeCapabilities = useFetch<{ actions: Record<string, boolean> }>(plane.embedded ? `${api}/capabilities` : null, 60_000);
  const can = (action: Parameters<typeof tenantCapabilities.can>[0]) => (plane.embedded ? !!planeCapabilities.data?.actions[action] : tenantCapabilities.can(action));
  const ready = plane.embedded ? !!planeCapabilities.data : tenantCapabilities.ready;
  const mayCreateChannel = ready && can('ManageChannels');
  const mayManageTeams = ready && can('ManageTeams');
  const mayManageRecordings = ready && can('ManageRecordings');
  // The composer is offered only to a reader whose CURRENT grants allow posting (the plane's own capabilities when embedded).
  const mayPost = ready && can('PostMessage');

  // ── Data ──────────────────────────────────────────────────────────────
  const channelsFetch = useFetch<{ channels: SocialChannel[] }>(`${api}/channels`);
  const dmsFetch = useFetch<{ conversations: SocialDm[] }>(`${api}/dms`, 30_000);
  const peopleFetch = useFetch<{ people: SocialPerson[] }>(`${api}/people`);
  const teamScope = JSON.stringify([me, session?.tenant, session?.role, session?.grants, session?.masquerading]);
  const teamsFetch = useSocialTeams(teamScope, me, api);
  const roomsFetch = useFetch<RoomsResponse>(`${api}/rooms`, 15_000);
  const callsFetch = useFetch<CallsResponse>(`${api}/calls`, 20_000);
  // Shared with RecordingsPane's read of the same URL (one request in flight).
  const recordingsFetch = useFetch<RecordingsResponse>(`${api}/recordings`, 30_000, { share: true });

  const channels = useMemo(() => channelsFetch.data?.channels ?? [], [channelsFetch.data]);
  const conversations = useMemo(() => dmsFetch.data?.conversations ?? [], [dmsFetch.data]);
  const roster: SocialPeer[] = useMemo(() => peopleFetch.data?.people ?? [], [peopleFetch.data]);
  const teams = useMemo(() => teamsFetch.data?.teams ?? [], [teamsFetch.data]);
  const rooms = useMemo(() => roomsFetch.data?.rooms ?? [], [roomsFetch.data]);
  const nameOf = useMemo(() => namesFrom(roster), [roster]);

  // ── What the pane shows: the URL, unless a shelf view or the picker is up ─
  const slug = route === 'channels' ? rawSlug ?? null : null;
  const lobby = route === 'dms' && rawLobby && rawLobby.startsWith(DM_PREFIX) ? rawLobby : null;
  const teamChannel = route === 'teams' ? params.get('channel') : null;
  const managing = route === 'teams' ? params.get('team') : null;
  const roomSlug = route === 'rooms' ? params.get('room') : null;
  // The open conversation's view (Chat | Documents | Pinned | Calls), in the URL.
  const view = conversationView(params.get('view'));
  // `?view=graph` is the conversation's work graph: the surface stays on Chat's frame, the graph fills the pane.
  // Embedded (the Communication plane), the conversation's work graph is part of its Shared work view (`?view=shared`).
  const sharedWork = embedding?.sharedWork;
  const graph = params.get('view') === (sharedWork ? 'shared' : 'graph');
  const graphPropsFor = (channel: string, name: string) => (sharedWork ? {
    graphOpen: graph, graphLabel: 'Shared work', onToggleGraph: () => setView(graph ? 'chat' : 'shared'),
    renderGraph: (messages: readonly SharedWorkMessage[]) => sharedWork({ channel, name, messages }),
  } : { graphOpen: graph, onToggleGraph: () => setView(graph ? 'chat' : 'graph') });
  const setView = (next: string) => setParams((prev) => {
    const out = new URLSearchParams(prev);
    if (next === 'chat') out.delete('view'); else out.set('view', next);
    return out;
  }, { replace: true });
  // `?summarizeRecording=<id>` (the Recordings pane's Summarize) runs `/summarize --recording <id>` once in this DM.
  const summarizeRecording = params.get('summarizeRecording');
  const finishSummarizeRecording = () => setParams((prev) => { const out = new URLSearchParams(prev); out.delete('summarizeRecording'); return out; }, { replace: true });
  // An inbox link names a Social destination; embedded, the same destination is under this page.
  const planeHref = (href: string) => (plane.embedded && /^\/social\/(channels|dms|teams|rooms|calls|recordings)(\/|\?|$)/.test(href)
    ? `${base}${href.slice('/social'.length)}` : href);
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [picking, setPicking] = useState(false);
  // Any navigation leaves the shelf and the picker: the URL names the pane again.
  useEffect(() => { setShelf(null); setPicking(false); }, [location.pathname, location.search]);

  const openTeam = findTeamChannel(teams, teamChannel);
  const focusTeamId = openTeam?.team.teamId ?? managing;
  const detail = useFetch<TeamDetail>(focusTeamId ? `${api}/teams/${encodeURIComponent(focusTeamId)}` : null);
  const members = detail.data?.members ?? [];

  // ── Presence, inbox, calls ────────────────────────────────────────────
  // The shell owns this subscription across routes. A second reader hook's
  // cleanup would unsubscribe that shared connection when this page unmounts.
  const embeddedSocial = useEmbeddedSocial();
  const here = embeddedSocial?.presencePeople ?? [];
  const presenceReady = embeddedSocial?.presenceReady === true;
  const online = useMemo(() => new Set(here.filter((p) => !p.idle).map((p) => p.id)), [here]);
  const people = useMemo(() => activeNow(here, me), [here, me]);

  const inbox = useSharedNotifications();
  const socialItems = useMemo(() => socialInbox(inbox.notifications), [inbox.notifications]);
  const unread = socialItems.filter((n) => !n.read).length;
  const mentions = useMemo(() => mentionItems(inbox.notifications), [inbox.notifications]);
  const unreadMentions = mentions.filter((m) => m.unread).length;
  // The Activity pane lists this workspace's items only, newest first.
  const inboxView = useMemo(() => ({
    ...inbox,
    notifications: [...socialItems].reverse(),
    unreadCount: unread,
  }), [inbox, socialItems, unread]);
  const markRead = useCallback((id: string) => { inbox.markAsRead(id); }, [inbox]);
  // A new message item in the inbox feed (the server only sends it to readers of that
  // channel) refetches the rail's lists, so a DM row and its badge move while another
  // conversation is open. The first pass only records what was already there.
  const seenInbox = useRef<Set<string> | null>(null);
  const refreshDmsLive = dmsFetch.refresh;
  const refreshChannelsLive = channelsFetch.refresh;
  useEffect(() => {
    const first = seenInbox.current === null;
    const seen = seenInbox.current ?? new Set<string>();
    const { channels: touched, ids } = newMessageChannels(socialItems, seen);
    for (const id of ids) seen.add(id);
    seenInbox.current = seen;
    if (first || touched.length === 0) return;
    if (touched.some((c) => c.startsWith(DM_PREFIX))) refreshDmsLive();
    if (touched.some((c) => c.startsWith(CHANNEL_PREFIX))) refreshChannelsLive();
  }, [socialItems, refreshDmsLive, refreshChannelsLive]);

  const call = useSocialCall();

  // ── The rail's rows ───────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const rail = useRailSectionMemory(RAIL_MEMORY_KEY, { defaultFolded: DEFAULT_FOLDED, opened: route === 'teams' ? ['Teams'] : route === 'rooms' ? ['Rooms'] : [] });
  // One section per route: the plane's home draws every section; a route only its own (`railSectionsFor`).
  const allSections = !!embedding?.overview;
  const showDms = allSections || route === 'dms';
  const showChannels = allSections || route === 'channels';
  const rows = useMemo(() => withPresence([
    ...(showDms ? dmRailItems(conversations, lobby, me, roster) : []),
    ...(showChannels ? channelRailItems(channels) : []),
  ], online).filter((item) => matchesRailFilter(item, query)), [conversations, lobby, me, roster, channels, online, query, showDms, showChannels]);
  // Controlled: the tree mounts before the teams load, and an uncontrolled
  // tree takes its open set from the first render (none). Open unless folded.
  const tree = useMemo(() => teamTreeItems(teams).map((t) => ({ ...t, expanded: !rail.collapsedSections[`team:${t.teamId}`] })), [teams, rail.collapsedSections]);

  const selected: RailSelection | null = shelf ? { kind: 'shelf', id: shelf }
    : picking ? null
      : route === 'calls' || route === 'recordings' ? { kind: 'shelf', id: route }
      : slug ? { kind: 'conversation', channel: `${CHANNEL_PREFIX}${slug}` }
        : lobby ? { kind: 'conversation', channel: lobby }
          : null;
  // Embedded (Communication), the content column's header takes the library
  // header density: an open conversation is rich content — the title as one
  // compact row, collapsible into the trail, remembered per device.
  const headerDensity = useHeaderDensity({ contentKind: selected?.kind === 'conversation' ? 'conversation' : 'list', headerId: 'communication' });

  // ── Writes ────────────────────────────────────────────────────────────
  const [problem, setProblem] = useState<string | null>(null);
  const [preferenceProblem, setPreferenceProblem] = useState<{ scope: string; pane: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const paneScope = `${location.key}:${shelf ?? ''}:${picking}`;
  const writeContext = useRef({ model: teamsFetch.model, pane: paneScope });
  writeContext.current = { model: teamsFetch.model, pane: paneScope };
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setBusy(false); setProblem(null); setPreferenceProblem(null); }, [teamScope]);
  const channelAnchor = useRef<HTMLElement | null>(null);
  const teamAnchor = useRef<HTMLElement | null>(null);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const roomsModel = useRoomsModel(roomsFetch);

  async function createChannel(input: CreateChannelDialogInput): Promise<void> {
    const res = await writeJson<{ channel: SocialChannel }>(`${api}/channels`, 'POST', {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      privacy: privacyForApi(input.privacy),
    });
    // A refusal (a duplicate name, a bad one) shows inline in the dialog.
    if (!res.ok || !res.data) throw new Error(res.error ?? 'The channel could not be created.');
    setCreatingChannel(false);
    channelsFetch.refresh();
    navigate(channelHref(res.data.channel.slug, base));
  }

  async function channelMembership(action: 'join' | 'leave', target: SocialChannel): Promise<void> {
    setBusy(true);
    setProblem(null);
    const res = await writeJson<{ channel: SocialChannel }>(`${api}/channels/${encodeURIComponent(target.slug)}/${action}`, 'POST');
    setBusy(false);
    if (!res.ok) { setProblem(res.error ?? `Could not ${action} #${target.slug}.`); return; }
    channelsFetch.refresh();
  }

  async function startDm(target: string): Promise<void> {
    setBusy(true);
    setProblem(null);
    const res = await writeJson<{ channel: string; peers: SocialPeer[] }>('/api/social/dms', 'POST', { userId: target });
    setBusy(false);
    if (!res.ok || !res.data) { setProblem(res.error ?? 'The conversation could not be opened.'); return; }
    setPicking(false);
    dmsFetch.refresh();
    navigate(dmHref(res.data.channel, base));
  }

  // Reading the open DM moves your cursor (its unread count clears); the list
  // is refetched so another conversation's count stays honest.
  const mine = lobby ? lobby.slice(DM_PREFIX.length).split(':').includes(me) : false;
  const refreshDms = dmsFetch.refresh;
  const markDmRead = useCallback((count: number) => {
    if (!lobby || !mine || count === 0) return;
    void writeJson('/api/social/dms/read', 'POST', { channel: lobby }).then((res) => { if (res.ok) refreshDms(); });
  }, [lobby, mine, refreshDms]);
  // The OPEN conversation's rail row (its server-derived preview and time) moves with the
  // conversation: the inbox feed carries no item for a channel its reader is viewing, so the
  // live refetch above never fires for it (D3). The open panel reports its latest line; a
  // change after the first report refetches the list that draws the row.
  const latestOpenLine = useRef<{ channel: string | null; summary: string | null } | null>(null);
  const refreshChannelsList = channelsFetch.refresh;
  const refreshTeamsList = teamsFetch.refresh;
  const openRowChanged = useCallback((channel: string, summary: string | null) => {
    const prior = latestOpenLine.current;
    latestOpenLine.current = { channel, summary };
    if (!prior || prior.channel !== channel || prior.summary === summary) return;
    if (channel.startsWith('social:team:')) refreshTeamsList(); else refreshChannelsList();
  }, [refreshChannelsList, refreshTeamsList]);

  const goTeams = (next: { channel?: string | null; team?: string | null }) => {
    const p: Record<string, string> = {};
    if (next.channel) p['channel'] = next.channel;
    if (next.team) p['team'] = next.team;
    if (route === 'teams') setParams(p, { replace: true });
    else navigate(`${base}/teams${Object.keys(p).length ? `?${new URLSearchParams(p)}` : ''}`);
  };

  async function createTeam(input: CreateTeamDialogInput) {
    const res = await writeJson<{ team: SocialTeam }>(`${api}/teams`, 'POST', input);
    if (!res.ok || !res.data) throw new Error(res.error ?? 'The team could not be created.');
    setCreatingTeam(false);
    teamsFetch.refresh();
    goTeams({ team: res.data.team.teamId });
  }

  async function teamMembership(method: 'POST' | 'DELETE', userId: string, teamId = focusTeamId) {
    if (!teamId) return;
    const context = writeContext.current;
    const stillHere = () => mounted.current && writeContext.current.model === context.model && writeContext.current.pane === context.pane;
    setBusy(true);
    setProblem(null);
    const membersUrl = `${api}/teams/${encodeURIComponent(teamId)}/members`;
    try {
      const changed = await context.model.changeMembership(teamId, async () => {
        const res = method === 'POST'
          ? await writeJson(membersUrl, 'POST', { userId })
          : await writeJson(`${membersUrl}/${encodeURIComponent(userId)}`, 'DELETE');
        if (!res.ok) throw new Error(res.error ?? 'The team could not be changed.');
      }, method === 'DELETE' && userId === me);
      if (!changed || !stillHere()) return;
      detail.refresh();
      if (method === 'DELETE' && userId === me && focusTeamId === teamId) goTeams({});
    } catch (error) {
      if (stillHere()) setProblem(error instanceof Error ? error.message : 'The team could not be changed.');
    } finally {
      if (mounted.current && writeContext.current.model === context.model) setBusy(false);
    }
  }

  async function pinTeam(teamId: string, favorite: boolean) {
    const context = writeContext.current;
    setPreferenceProblem(null);
    try {
      await context.model.pin(teamId, favorite);
    } catch (error) {
      if (mounted.current && writeContext.current.model === context.model && writeContext.current.pane === context.pane) {
        setPreferenceProblem({ scope: teamScope, pane: context.pane,
          message: error instanceof Error ? error.message : 'The team preference could not be saved.' });
      }
    }
  }

  const openNewDm = () => { setShelf(null); setPicking(true); };

  // ── The rail ──────────────────────────────────────────────────────────
  const activeTiles = embedding?.activePeople ? embedding.activePeople(people) : people;
  const railContext: WorkspaceRailContext = { query, online, here };
  const teamsReadPending = !teamsFetch.data && (teamsFetch.isLoading || !!teamsFetch.error);
  const sections: ConversationRailSection[] = [
    {
      // Presence is always visible, independent of persisted disclosure state.
      id: 'active-now', label: 'Active now', 'data-testid': 'social-active-now',
      node: <><RailSectionHeader label="Active now" {...(presenceReady ? { count: activeTiles.length } : {})} presentational={false} /><ActivePeopleGrid
        people={activeTiles}
        emptyLabel={presenceReady ? 'Nobody is sharing work or online right now.' : 'Live presence is unavailable.'}
        maxVisible={8}
        onSelectPerson={(userId) => { void startDm(userId); }}
        {...(embedding?.onSelectSharedWork ? { onSelectSharedWork: embedding.onSelectSharedWork } : {})}
        className={RAIL_SECTION_CONTENT_INSET}
        data-testid="social-active-now"
      /></>,
    },
    ...(embedding?.railSections?.(railContext) ?? []),
    {
      id: 'teams', label: 'Teams',
      ...(teamsReadPending ? { heading: true } : {}),
      node: teamsReadPending
        ? <Stack gap="none" className={RAIL_SECTION_CONTENT_INSET}><SocialReadStatus source="Teams" read={teamsFetch} retry={teamsFetch.refresh} testId="social-teams-read-status" /></Stack> : (
        <Stack gap="none">
        <TeamChannelTree
          teams={tree}
          filter={query}
          activeChannel={openTeam ? teamChannel : null}
          onSelectChannel={(channel) => goTeams({ channel })}
          onToggleTeam={(teamId, expanded) => rail.setFolded(`team:${teamId}`, !expanded)}
          onManageTeam={(teamId) => goTeams({ team: teamId })}
          onTogglePinTeam={(teamId, favorite) => { void pinTeam(teamId, favorite); }}
          onLeaveTeam={(teamId) => { void teamMembership('DELETE', me, teamId); }}
          collapsed={rail.isFolded('Teams')}
          onToggleCollapse={(next) => rail.setFolded('Teams', next)}
          {...(mayManageTeams ? { onCreateTeam: (trigger: HTMLElement) => { teamAnchor.current = trigger; setCreatingTeam(true); } } : {})}
          data-testid="social-team-tree"
        />
        {teamsFetch.error && !rail.isFolded('Teams') && <Stack gap="none" className={RAIL_SECTION_CONTENT_INSET}><SocialReadStatus source="Teams" read={teamsFetch} retry={teamsFetch.refresh} testId="social-teams-read-status" /></Stack>}
        </Stack>
      ),
    },
    {
      id: 'rooms', label: 'Rooms',
      node: <SocialRoomsSection rooms={roomsFetch} mayCreate={mayCreateChannel}
        collapsed={rail.isFolded('Rooms')} onToggleCollapse={(next) => rail.setFolded('Rooms', next)}
        onOpen={(slug) => navigate(`${base}/rooms?room=${encodeURIComponent(slug)}`)} />,
    },
  ];
  const railNode = (
    <ConversationRail
      title="Chat"
      actions={<IconButton aria-label="New message" title="New message" size="sm" variant="ghost" icon={<PlusIcon size={14} />}
        onClick={openNewDm} data-testid="social-new-dm" />}
      search={{ value: query, onChange: setQuery, placeholder: 'Find a chat', label: 'Find a chat', 'data-testid': 'social-rail-search' }}
      // One compact row of destinations (the user, 2026-10-07: they "shouldn't all stack in this window").
      shelfLayout="bar"
      shelf={[
        { id: 'activity', label: 'Activity', icon: <ActivityIcon size={15} />, count: unread },
        { id: 'mentions', label: 'Mentions', icon: <AtIcon size={15} />, count: unreadMentions, urgent: true },
        { id: 'calls', label: 'Calls', icon: <PhoneIcon size={15} />, count: (callsFetch.data?.counts.missed ?? 0) + (embedding?.pageMissed ?? 0), urgent: true },
        { id: 'recordings', label: 'Recordings', icon: <PlayCircleIcon size={15} /> },
      ]}
      conversations={rows}
      beforeList={((showChannels && channelsFetch.error) || (showDms && dmsFetch.error)) && <Stack gap="xs" className={RAIL_SECTION_CONTENT_INSET}>
        {showDms && <SocialReadStatus source="Direct messages" read={dmsFetch} retry={dmsFetch.refresh} testId="social-dms-read-status" />}
        {showChannels && <SocialReadStatus source="Channels" read={channelsFetch} retry={channelsFetch.refresh} testId="social-channels-read-status" />}
      </Stack>}
      sectionOrder="dms-first"
      sections={sections}
      {...rail.railProps}
      // A one-section view keeps the default order (Direct messages, Active now, the rest); the reader's
      // arranged order (social.chatRail.layout) applies where Arrange is offered — the plane's home.
      sectionLayout={(allSections ? rail.railProps.sectionLayout : null) ?? ['dms', ...sections.map(section => section.id), 'channels']}
      // The library hides every other section, caption and row, and offers no Arrange on a one-section view.
      showSections={allSections ? null : railSectionsFor(route)}
      maxVisible={8}
      selected={embedding?.pane ? null : selected}
      onSelect={(selection) => {
        if (selection.kind === 'shelf') {
          setPicking(false);
          if (selection.id === 'calls' || selection.id === 'recordings') { setShelf(null); navigate(`${base}/${selection.id}`); return; }
          setShelf(selection.id === 'mentions' ? 'mentions' : 'activity');
          if (embedding?.pane) navigate(base);
          return;
        }
        const channelSlug = slugFromChannel(selection.channel);
        if (channelSlug) navigate(channelHref(channelSlug, base));
        else if (selection.channel.startsWith(DM_PREFIX)) navigate(dmHref(selection.channel, base));
      }}
      {...(call.unavailable ? {} : {
        onStartCall: (channel: string) => {
          const peers = dmPeers(channel, me, roster, conversations.find((c) => c.channel === channel)?.peers);
          if (peers.length) call.callPeople(peers);
        },
      })}
      sectionActions={{
        'Direct messages': [{ label: 'New message', icon: <PlusIcon size={12} />, onClick: openNewDm, 'data-testid': 'social-rail-new-dm' }],
        ...(mayCreateChannel ? {
          Channels: [{
            label: 'Create a channel', icon: <PlusIcon size={12} />,
            onClick: (trigger: HTMLElement) => { channelAnchor.current = trigger; setCreatingChannel(true); },
            'data-testid': 'social-create-channel',
          }],
        } : {}),
      }}
      emptyLabel={conversationRailEmptyLabel([...(showDms ? [dmsFetch] : []), ...(showChannels ? [channelsFetch] : [])], query)}
      data-testid="social-chat-rail"
    />
  );

  // ── The pane ──────────────────────────────────────────────────────────
  const openChannel = slug ? channels.find((c) => c.slug === slug) ?? null : null;
  const dmListed = lobby ? conversations.find((c) => c.channel === lobby) : undefined;
  const dmPeople = lobby ? dmPeers(lobby, me, roster, dmListed?.peers) : [];
  const candidates = useMemo<Candidate[]>(
    () => teamCandidates(dmCandidates(peopleFetch.data?.people ?? [], me), members),
    [peopleFetch.data, me, members],
  );
  const isOwner = detail.data?.team.role === 'owner';
  const canEditMembers = mayManageTeams && isOwner;

  const recordingsFor = (lobbyName: string) => conversationRecordings(recordingsFetch.data?.recordings ?? [], lobbyName);
  const openRecording = (id: string) => navigate(`${base}/recordings?recording=${encodeURIComponent(id)}`);
  const conversationCall = (channel: string, title: string) => (call.unavailable ? {} : {
    onStartCall: (audioOnly: boolean) => call.callConversation({ channel, title }, { audioOnly }),
  });

  // The footer's idle group names what is open here and its Huddle runs the
  // same start as the conversation's call button (realtime-parity gap 3).
  const openRoom = route === 'rooms' && roomSlug ? rooms.find((r) => r.slug === roomSlug) ?? null : null;
  const footerContext: SocialFooterContext | null = shelf || picking ? null
    : embedding?.pane
      ? (embedding.footerConversation ? { lobbyName: embedding.footerConversation.channel, title: embedding.footerConversation.title,
        start: () => call.callConversation(embedding.footerConversation!) } : null)
    : route === 'channels' && openChannel?.joined
      ? { lobbyName: openChannel.channel, title: `#${openChannel.slug}`, start: () => call.callConversation({ channel: openChannel.channel, title: `#${openChannel.slug}` }) }
    : route === 'dms' && lobby && mine && dmPeople.length
      ? { lobbyName: lobby, title: dmTitle(dmPeople), start: () => call.callPeople(dmPeople) }
    : openRoom
      ? { lobbyName: openRoom.lobbyName, title: openRoom.name, start: () => call.joinRoom(openRoom) }
    : route === 'teams' && openTeam && teamChannel
      ? { lobbyName: teamChannel, title: `${openTeam.team.name} · ${openTeam.channel.name}`, start: () => call.callConversation({ channel: teamChannel, title: `${openTeam.team.name} · ${openTeam.channel.name}` }) }
      : null;
  useSocialFooterContext(footerContext, call.unavailable);

  function pane() {
    // The host's own view (a group's page discussion, an org team, a person's shared work) — the plane only.
    if (embedding?.pane && !shelf && !picking) return embedding.pane;
    if (route === 'calls' && !shelf && !picking) {
      const social = <CallLogPane calls={callsFetch} me={me} nameOf={nameOf} rooms={rooms} call={call} />;
      if (!embedding) return social;
      // Embedded: this tenant's page huddles (its former Calls page) first, then the Social call log.
      return (
        <Stack gap="lg" className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="communication-calls">
          <Stack gap="sm"><SectionLabel as="h2">On this workspace's pages</SectionLabel>{embedding.pageCalls}</Stack>
          <Stack gap="sm"><SectionLabel as="h2">Social calls</SectionLabel>{social}</Stack>
        </Stack>
      );
    }
    if (route === 'recordings' && !shelf && !picking) return <RecordingsPane me={me} nameOf={nameOf} rooms={rooms} mayManage={mayManageRecordings} postTargets={roomSummaryTargets(channels, conversations)} displayName={displayName} />;
    if (shelf === 'activity') {
      return <WrappedNotificationCenter notifications={inboxView} className="min-h-0 flex-1"
        onItemClick={(item, entry) => {
          markRead(item.id);
          const href = entry?.action?.href;
          if (href && href.startsWith('/') && !href.startsWith('//')) navigate(planeHref(href));
        }} data-testid="social-activity-pane" />;
    }
    if (shelf === 'mentions') {
      return mentions.length
        ? <ChannelMentionsPanel className="min-h-0 flex-1" mentions={mentions} data-testid="social-mentions-pane"
          onJump={(channel, id) => { markRead(id); const s = slugFromChannel(channel); if (s) navigate(channelHref(s, base)); }} />
        : <EmptyState align="start" testId="social-mentions-empty" title="No mentions"
          description="When someone writes @ and your name in a channel you are in, it lands here." />;
    }
    if (picking) {
      return <NewConversationPanel className="min-w-0 flex-1" people={dmCandidates(peopleFetch.data?.people ?? [], me)}
        peopleError={peopleFetch.error} busy={busy} onStartDm={startDm} onCancel={() => setPicking(false)} data-testid="social-dm-picker" />;
    }
    if (route === 'channels') {
      if (!slug && embedding?.landing) {
        return embedding.landing({
          ready: !!(channelsFetch.data || channelsFetch.error) && !!(dmsFetch.data || dmsFetch.error),
          channels, conversations, activePeople: activeTiles,
        });
      }
      if (channelsFetch.isLoading && !channelsFetch.data) return <LoadingState label="Loading channels…" />;
      if (channelsFetch.error && !channelsFetch.data) return <ErrorState title="Channels could not be loaded" description={channelsFetch.error} actionLabel="Try again" onAction={channelsFetch.refresh} />;
      if (!slug) {
        return channels.length === 0
          ? <EmptyState testId="social-empty-channels" align="start" title="No channels yet"
            description={mayCreateChannel
              ? 'Channels are where a community talks in the open. None exist in this workspace yet — create the first one.'
              : 'Channels are where a community talks in the open. None exist in this workspace yet; a moderator can create one.'}
            {...(mayCreateChannel ? { action: <Button variant="primary" size="sm" onClick={(e) => { channelAnchor.current = e.currentTarget; setCreatingChannel(true); }} data-testid="social-empty-create-channel">Create a channel</Button> } : {})} />
          : <EmptyState align="start" title="Pick a channel" description="Choose a channel on the left to read it. Channels you have not joined show a Join button first." />;
      }
      if (!openChannel) return <EmptyState align="start" testId="social-channel-missing" title={`#${slug} is not available`} description="This channel does not exist, or it is private and you are not a member." />;
      if (openChannel.joined) {
        return <SocialConversation focusTarget key={openChannel.channel} channel={openChannel.channel} name={`#${openChannel.slug}`} maySend={mayPost}
          description={`${openChannel.memberCount} ${openChannel.memberCount === 1 ? 'member' : 'members'}${openChannel.description ? ` · ${openChannel.description}` : ''}`}
          view={graph ? 'chat' : view} onViewChange={setView} {...graphPropsFor(openChannel.channel, `#${openChannel.slug}`)}
          {...conversationCall(openChannel.channel, `#${openChannel.slug}`)} callInProgress={call.activeLobby === openChannel.channel}
          recordings={recordingsFor(openChannel.channel)} onOpenRecording={openRecording}
          menu={[{ label: `Leave #${openChannel.slug}`, danger: true, disabled: busy, onSelect: () => void channelMembership('leave', openChannel), 'data-testid': 'social-leave-channel' }]}
          userId={me} displayName={displayName} nameOf={nameOf} placeholder={`Message #${openChannel.slug}`}
          onLatestMessage={(summary) => openRowChanged(openChannel.channel, summary)} />;
      }
      return (
        <Stack gap="md" className="min-w-0 flex-1">
          <ChannelHeader name={`#${openChannel.slug}`} {...(openChannel.description ? { description: openChannel.description } : {})} memberCount={openChannel.memberCount} />
          <EmptyState align="start" testId="social-channel-not-joined" title={`You are not in #${openChannel.slug}`}
            description="Join to read the conversation and post in it. Everyone in the channel will see you arrive."
            action={<Button variant="primary" size="sm" disabled={busy} onClick={() => void channelMembership('join', openChannel)} data-testid="social-join-channel">Join #{openChannel.slug}</Button>} />
        </Stack>
      );
    }
    if (route === 'dms') {
      if (dmsFetch.isLoading && !dmsFetch.data) return <LoadingState label="Loading conversations…" />;
      if (dmsFetch.error && !dmsFetch.data) return <ErrorState title="Conversations could not be loaded" description={dmsFetch.error} actionLabel="Try again" onAction={dmsFetch.refresh} />;
      if (!lobby) {
        const any = conversations.length > 0;
        return <EmptyState align="start" testId="social-empty-dms" title={any ? 'Pick a conversation' : 'No direct messages yet'}
          description={any ? 'Choose a conversation on the left, or start a new one.' : 'A direct message is visible only to the people in it. You have not started one here.'}
          action={<Button variant="primary" size="sm" onClick={openNewDm} data-testid="social-empty-new-dm">New message</Button>} />;
      }
      if (!mine) return <EmptyState align="start" testId="social-dm-missing" title="This conversation is not yours" description="A direct message opens only for the people it names." />;
      return <SocialConversation focusTarget key={lobby} channel={lobby} name={dmTitle(dmPeople)} userId={me} displayName={displayName} nameOf={nameOf} maySend={mayPost}
        {...(dmPeople.length === 1 && dmPeople[0]?.avatarUrl ? { avatarUrl: dmPeople[0].avatarUrl } : {})}
        online={dmPeople.some((p) => online.has(p.userId))}
        view={graph ? 'chat' : view} onViewChange={setView} {...graphPropsFor(lobby, dmTitle(dmPeople))}
        {...(call.unavailable ? {} : { onStartCall: (audioOnly: boolean) => call.callPeople(dmPeople, { audioOnly }) })}
        callInProgress={call.activeLobby === lobby}
        recordings={recordingsFor(lobby)} onOpenRecording={openRecording}
        {...(summarizeRecording ? { autoRun: `/summarize --recording ${summarizeRecording}`, onAutoRunDone: finishSummarizeRecording } : {})}
        placeholder={`Message ${dmTitle(dmPeople)}`} onMessages={markDmRead} />;
    }
    if (route === 'rooms') {
      if (roomsFetch.isLoading && !roomsFetch.data) return <LoadingState label="Loading rooms…" />;
      if (roomsFetch.error && !roomsFetch.data) return <ErrorState title="Rooms could not be loaded" description={roomsFetch.error} actionLabel="Try again" onAction={roomsFetch.refresh} />;
      return <RoomPane selected={roomSlug} room={rooms.find((r) => r.slug === roomSlug) ?? null} nameOf={nameOf} call={call}
        mayCreate={mayCreateChannel} onCreate={() => setCreatingRoom(true)} />;
    }
    // Teams.
    if (teamsFetch.isLoading && !teamsFetch.data) return <LoadingState label="Loading teams…" />;
    if (teamsFetch.error && !teamsFetch.data) return <ErrorState title="Teams could not be loaded" description={teamsFetch.error} actionLabel="Try again" onAction={teamsFetch.refresh} />;
    if (openTeam) {
      return <SocialConversation focusTarget key={teamChannel!} channel={teamChannel!} name={`${openTeam.team.name} · ${openTeam.channel.name}`} maySend={mayPost}
        {...(openTeam.team.description || members.length ? {
          description: [members.length ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` : '', openTeam.team.description ?? ''].filter(Boolean).join(' · '),
        } : {})}
        view={graph ? 'chat' : view} onViewChange={setView} {...graphPropsFor(teamChannel!, `${openTeam.team.name} · ${openTeam.channel.name}`)}
        {...conversationCall(teamChannel!, `${openTeam.team.name} · ${openTeam.channel.name}`)} callInProgress={call.activeLobby === teamChannel}
        recordings={recordingsFor(teamChannel!)} onOpenRecording={openRecording}
        menu={[{ label: 'Members', onSelect: () => goTeams({ team: openTeam.team.teamId }), 'data-testid': 'social-team-open-members' }]}
        userId={me} displayName={displayName} nameOf={nameOf} placeholder={`Message ${openTeam.channel.name}`}
        onLatestMessage={(summary) => openRowChanged(teamChannel!, summary)} />;
    }
    if (managing && detail.data) {
      return (
        <Stack gap="md" className="min-w-0 flex-1" data-testid="social-team-detail">
          <ChannelHeader name={detail.data.team.name} {...(detail.data.team.description ? { description: detail.data.team.description } : {})} memberCount={members.length} />
          {!canEditMembers && (
            <InlineAlert tone="info">
              {mayManageTeams ? 'Only this team\'s owner adds or removes people.' : 'A moderator who owns this team adds or removes people.'}
            </InlineAlert>
          )}
          <MembersPanel
            members={members.map((m) => {
              const avatarUrl = roster.find((p) => p.userId === m.userId)?.avatarUrl;
              return { id: m.userId, name: m.displayName, role: m.role, addedAt: m.addedAt, ...(avatarUrl ? { avatarUrl } : {}) };
            })}
            open={detail.data.team.visibility === 'org'}
            canManage={canEditMembers}
            currentUserId={me}
            {...(canEditMembers ? { onAdd: () => setAdding(true), onRemove: (userId: string) => void teamMembership('DELETE', userId) } : {})}
            data-testid="social-team-members"
          />
        </Stack>
      );
    }
    if (managing && detail.isLoading && !detail.data) return <LoadingState label="Loading team…" />;
    if (managing && detail.error) return <ErrorState title="This team could not be loaded" description={detail.error} actionLabel="Try again" onAction={detail.refresh} />;
    if (teams.length === 0) {
      return <EmptyState testId="social-empty-teams" align="start" title="You are not on a team yet"
        description={mayManageTeams
          ? 'A team groups people and their channels. Create one and add the people it is for.'
          : 'A team groups people and their channels. A moderator adds you to one.'}
        {...(mayManageTeams ? { action: <Button variant="primary" size="sm" onClick={(e) => { teamAnchor.current = e.currentTarget; setCreatingTeam(true); }} data-testid="social-empty-create-team">New team</Button> } : {})} />;
    }
    return <EmptyState align="start" title="Pick a channel" description="Choose a team's channel on the left to read it, or open a team's ⋯ menu to see who is on it." />;
  }

  function alerts() {
    return <>
      {problem && <InlineAlert tone="error" onDismiss={() => setProblem(null)}>{problem}</InlineAlert>}
      {preferenceProblem?.scope === teamScope && preferenceProblem.pane === paneScope && (
        <InlineAlert tone="error" onDismiss={() => setPreferenceProblem(null)} data-testid="social-team-preference-error">
          {preferenceProblem.message}
        </InlineAlert>
      )}
      {call.notice && <InlineAlert tone="warning" onDismiss={call.clearNotice}>{call.notice}</InlineAlert>}
    </>;
  }

  return (
    <Stack gap="none" className="min-h-0 min-w-0 bg-surface" data-shell-flush data-testid={PAGE_TESTID[route]}>
      {!embedding && <VisuallyHidden as="h1">{PAGE_TITLE[route]}</VisuallyHidden>}
      <ViewportFillRegion className="flex min-w-0" data-testid="social-chat-workspace">
        {railNode}
        {embedding ? (
          <SectionContent breadcrumbs={embedding.breadcrumbs} title={embedding.title} body="fill" inset="conversation" {...headerDensity.headerProps}
            {...(embedding.actions ? { actions: embedding.actions } : {})} data-testid="communication-content">
            <Stack as="section" aria-label={PAGE_TITLE[route]} gap="sm" className="min-h-0 min-w-0 flex-1 overflow-hidden" ref={headerDensity.contentRef} data-testid="social-chat-pane">
              {alerts()}
              {pane()}
            </Stack>
          </SectionContent>
        ) : (
          <Stack as="section" aria-label={PAGE_TITLE[route]} gap="sm" className="min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="social-chat-pane">
            {alerts()}
            {pane()}
          </Stack>
        )}
      </ViewportFillRegion>
      {/* Always anchored to the control that opened them: centred, the
          library's PopoverForm has no Escape (docs/ui-components-queue.md). */}
      <CreateChannelDialog open={creatingChannel} teamName="Social" anchor={channelAnchor}
        onCreate={createChannel} onClose={() => setCreatingChannel(false)} data-testid="social-create-channel-dialog" />
      <RoomCreateDialog open={creatingRoom} onClose={() => setCreatingRoom(false)} mayCreate={mayCreateChannel}
        createRoom={roomsModel.createRoom} onCreated={(slug) => navigate(`${base}/rooms?room=${encodeURIComponent(slug)}`)} />
      <CreateTeamDialog open={creatingTeam} anchor={teamAnchor} onCreate={createTeam} onClose={() => setCreatingTeam(false)} data-testid="social-create-team-dialog" />
      <AddPeoplePicker open={adding} onClose={() => setAdding(false)} title="Add people to the team"
        candidates={candidates.map((c) => ({ userId: c.userId, displayName: c.displayName, ...(c.hint ? { subtitle: c.hint } : {}) }))}
        searchPlaceholder="Find a person" emptyMessage="Everyone in this workspace is already on the team." busy={busy}
        onAdd={async (ids) => { for (const id of ids) await teamMembership('POST', id); setAdding(false); }}
        data-testid="social-team-candidates" />
    </Stack>
  );
}
