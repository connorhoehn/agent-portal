// The social tenant's chat workspace — ONE composition that /social/channels,
// /social/dms, /social/teams, /social/rooms, /social/calls and
// /social/recordings all render (docs/social-tenant-design.md §4.5;
// docs/rail-parity-goal.md, "the chat-rail variant"). The route only decides
// what the pane opens on: a channel, a DM, a team's channel or roster, a room,
// the call log, the recordings. Contacts and Configuration stay pages.
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
// An open conversation is SocialConversation (the library's conversation
// surface: Chat | Documents | Pinned | Calls, `?view=` in the URL, the call
// actions and the ⋯ menu).
//
// The page root is `data-shell-flush`: the shell draws no 24px ring and no
// breadcrumb row around it, so the rail starts at the content top at x=200.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ViewportFillRegion } from '@connorhoehnslalom/ui-components';
import {
  ActivePeopleGrid, ChannelMentionsPanel, ConversationRail, CreateChannelDialog, CreateTeamDialog, MembersPanel,
  NewConversationPanel, RailSectionHeader, TeamChannelTree,
  type CreateChannelDialogInput, type CreateTeamDialogInput, type RailSelection,
} from '@connorhoehnslalom/ui-components/social';
import {
  ActivityIcon, AtIcon, Button, ChannelHeader, DataTable, EmptyState, ErrorState, IconButton, InlineAlert, LoadingState,
  Modal, PhoneIcon, PlayCircleIcon, PlusIcon, SearchInput, Stack, VisuallyHidden, type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { WrappedNotificationCenter } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { useGatewayOptional, useNotifications, usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import { presenceAvatarUsers } from '../assessment/knowledge/knowledgeFormat';
import SocialConversation, { conversationView } from './SocialConversation';
import CallLogPane, { type CallsResponse } from './CallLogPane';
import RecordingsPane from './RecordingsPane';
import RoomPane from './RoomPane';
import SocialRoomsSection, { RoomCreateDialog, useRoomsModel, type RoomsResponse } from './SocialRoomsSection';
import {
  CHANNEL_PREFIX, DM_PREFIX, activeNow, channelHref, channelRailItems, dmCandidates, dmHref, dmPeers, dmRailItems, dmTitle,
  conversationRecordings, matchesRailFilter, mentionItems, privacyForApi, slugFromChannel, socialInbox, withPresence,
  type SocialChannel, type SocialDm, type SocialPeer, type SocialPerson,
} from './socialChat';
import {
  SOCIAL_PRESENCE_CHANNEL, findTeamChannel, namesFrom, teamCandidates, teamTreeItems,
  type SocialRecording, type SocialSource, type SocialTeam, type SocialTeamMember,
} from './socialPlatform';
import { useSocialCall } from './useSocialCall';

export type SocialChatRoute = 'channels' | 'dms' | 'teams' | 'rooms' | 'calls' | 'recordings';

interface TeamsResponse { source: SocialSource; teams: SocialTeam[]; counts: { total: number; channels: number } }
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
/** The rail's folded sections survive a reload on this device (a preference, not state). */
const FOLDED_KEY = 'social.chatRail.folded';

function useFoldedSections() {
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '{}');
      return value && typeof value === 'object' ? value as Record<string, boolean> : {};
    } catch { return {}; }
  });
  const set = useCallback((label: string, next: boolean) => setFolded((value) => {
    const updated = { ...value, [label]: next };
    try { localStorage.setItem(FOLDED_KEY, JSON.stringify(updated)); } catch { /* A device preference only. */ }
    return updated;
  }), []);
  return { folded, set, isFolded: (label: string) => !!folded[label] };
}

export default function SocialChatWorkspace({ route }: { route: SocialChatRoute }) {
  const { slug: rawSlug, lobby: rawLobby } = useParams<{ slug?: string; lobby?: string }>();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { session } = useSession();
  const me = session?.sub ?? '';
  const displayName = session?.name ?? me;
  const { can, ready } = useCapabilities();
  const mayCreateChannel = ready && can('ManageChannels');
  const mayManageTeams = ready && can('ManageTeams');
  const mayManageRecordings = ready && can('ManageRecordings');

  // ── Data ──────────────────────────────────────────────────────────────
  const channelsFetch = useFetch<{ channels: SocialChannel[] }>('/api/social/channels');
  const dmsFetch = useFetch<{ conversations: SocialDm[] }>('/api/social/dms');
  const peopleFetch = useFetch<{ people: SocialPerson[] }>('/api/social/people');
  const teamsFetch = useFetch<TeamsResponse>('/api/social/teams', 30_000);
  const roomsFetch = useFetch<RoomsResponse>('/api/social/rooms', 15_000);
  const callsFetch = useFetch<CallsResponse>('/api/social/calls', 20_000);
  // Shared with RecordingsPane's read of the same URL (one request in flight).
  const recordingsFetch = useFetch<RecordingsResponse>('/api/social/recordings', 30_000, { share: true });

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
  const setView = (next: string) => setParams((prev) => {
    const out = new URLSearchParams(prev);
    if (next === 'chat') out.delete('view'); else out.set('view', next);
    return out;
  }, { replace: true });
  const [shelf, setShelf] = useState<Shelf | null>(null);
  const [picking, setPicking] = useState(false);
  // Any navigation leaves the shelf and the picker: the URL names the pane again.
  useEffect(() => { setShelf(null); setPicking(false); }, [location.pathname, location.search]);

  const openTeam = findTeamChannel(teams, teamChannel);
  const focusTeamId = openTeam?.team.teamId ?? managing;
  const detail = useFetch<TeamDetail>(focusTeamId ? `/api/social/teams/${encodeURIComponent(focusTeamId)}` : null);
  const members = detail.data?.members ?? [];

  // ── Presence, inbox, calls ────────────────────────────────────────────
  // SocialLayout joins `social:lobby` for every social page; this only reads it.
  const { roster: lobbyRoster } = usePresence(SOCIAL_PRESENCE_CHANNEL);
  const here = useMemo(() => presenceAvatarUsers(lobbyRoster), [lobbyRoster]);
  const online = useMemo(() => new Set(here.filter((p) => !p.idle).map((p) => p.id)), [here]);
  const people = useMemo(() => activeNow(here, me), [here, me]);

  const inbox = useNotifications();
  const gateway = useGatewayOptional();
  const tell = useCallback((frame: Record<string, unknown>) => {
    if (gateway?.connectionState !== 'connected') return;
    try { gateway.send({ service: 'notification', ...frame }); } catch { /* offline: the local mark stands */ }
  }, [gateway]);
  const socialItems = useMemo(() => socialInbox(inbox.notifications), [inbox.notifications]);
  const unread = socialItems.filter((n) => !n.read).length;
  const mentions = useMemo(() => mentionItems(inbox.notifications), [inbox.notifications]);
  const unreadMentions = mentions.filter((m) => m.unread).length;
  // The Activity pane lists this workspace's items only, newest first.
  const inboxView = useMemo(() => ({
    ...inbox,
    notifications: [...socialItems].reverse(),
    unreadCount: unread,
    markAllRead: () => { inbox.markAllRead(); tell({ action: 'markAllRead' }); },
  }), [inbox, socialItems, unread, tell]);
  const markRead = useCallback((id: string) => { inbox.markAsRead(id); tell({ action: 'markRead', id }); }, [inbox, tell]);

  const call = useSocialCall();

  // ── The rail's rows ───────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const folded = useFoldedSections();
  const rows = useMemo(() => withPresence([
    ...dmRailItems(conversations, lobby, me, roster),
    ...channelRailItems(channels),
  ], online).filter((item) => matchesRailFilter(item, query)), [conversations, lobby, me, roster, channels, online, query]);
  // Controlled: the tree mounts before the teams load, and an uncontrolled
  // tree takes its open set from the first render (none). Open unless folded.
  const tree = useMemo(() => teamTreeItems(teams).map((t) => ({ ...t, expanded: !folded.folded[`team:${t.teamId}`] })), [teams, folded.folded]);

  const selected: RailSelection | null = shelf ? { kind: 'shelf', id: shelf }
    : picking ? null
      : route === 'calls' || route === 'recordings' ? { kind: 'shelf', id: route }
      : slug ? { kind: 'conversation', channel: `${CHANNEL_PREFIX}${slug}` }
        : lobby ? { kind: 'conversation', channel: lobby }
          : null;

  // ── Writes ────────────────────────────────────────────────────────────
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const channelAnchor = useRef<HTMLElement | null>(null);
  const teamAnchor = useRef<HTMLElement | null>(null);
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const roomsModel = useRoomsModel(roomsFetch);

  async function createChannel(input: CreateChannelDialogInput): Promise<void> {
    const res = await writeJson<{ channel: SocialChannel }>('/api/social/channels', 'POST', {
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      privacy: privacyForApi(input.privacy),
    });
    // A refusal (a duplicate name, a bad one) shows inline in the dialog.
    if (!res.ok || !res.data) throw new Error(res.error ?? 'The channel could not be created.');
    setCreatingChannel(false);
    channelsFetch.refresh();
    navigate(channelHref(res.data.channel.slug));
  }

  async function channelMembership(action: 'join' | 'leave', target: SocialChannel): Promise<void> {
    setBusy(true);
    setProblem(null);
    const res = await writeJson<{ channel: SocialChannel }>(`/api/social/channels/${encodeURIComponent(target.slug)}/${action}`, 'POST');
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
    navigate(dmHref(res.data.channel));
  }

  // Reading the open DM moves your cursor (its unread count clears); the list
  // is refetched so another conversation's count stays honest.
  const mine = lobby ? lobby.slice(DM_PREFIX.length).split(':').includes(me) : false;
  const refreshDms = dmsFetch.refresh;
  const markDmRead = useCallback((count: number) => {
    if (!lobby || !mine || count === 0) return;
    void writeJson('/api/social/dms/read', 'POST', { channel: lobby }).then((res) => { if (res.ok) refreshDms(); });
  }, [lobby, mine, refreshDms]);

  const goTeams = (next: { channel?: string | null; team?: string | null }) => {
    const p: Record<string, string> = {};
    if (next.channel) p['channel'] = next.channel;
    if (next.team) p['team'] = next.team;
    if (route === 'teams') setParams(p, { replace: true });
    else navigate(`/social/teams${Object.keys(p).length ? `?${new URLSearchParams(p)}` : ''}`);
  };

  async function createTeam(input: CreateTeamDialogInput) {
    const res = await writeJson<{ team: SocialTeam }>('/api/social/teams', 'POST', input);
    if (!res.ok || !res.data) throw new Error(res.error ?? 'The team could not be created.');
    setCreatingTeam(false);
    teamsFetch.refresh();
    goTeams({ team: res.data.team.teamId });
  }

  async function teamMembership(method: 'POST' | 'DELETE', userId: string, teamId = focusTeamId) {
    if (!teamId) return;
    setBusy(true);
    setProblem(null);
    const base = `/api/social/teams/${encodeURIComponent(teamId)}/members`;
    const res = method === 'POST'
      ? await writeJson(base, 'POST', { userId })
      : await writeJson(`${base}/${encodeURIComponent(userId)}`, 'DELETE');
    setBusy(false);
    if (!res.ok) { setProblem(res.error ?? 'The team could not be changed.'); return; }
    detail.refresh();
    teamsFetch.refresh();
    if (method === 'DELETE' && userId === me) goTeams({});
  }

  const openNewDm = () => { setShelf(null); setPicking(true); };

  // ── The rail ──────────────────────────────────────────────────────────
  const conversationsError = dmsFetch.error && channelsFetch.error ? dmsFetch.error : null;
  const rail = (
    <ConversationRail
      title="Chat"
      actions={<IconButton aria-label="New message" title="New message" size="sm" variant="ghost" icon={<PlusIcon size={14} />}
        onClick={openNewDm} data-testid="social-new-dm" />}
      header={<SearchInput value={query} onChange={setQuery} placeholder="Find a chat" size="sm" className="w-full" aria-label="Find a chat" data-testid="social-rail-search" />}
      shelf={[
        { id: 'activity', label: 'Activity', icon: <ActivityIcon size={15} />, count: unread },
        { id: 'mentions', label: 'Mentions', icon: <AtIcon size={15} />, count: unreadMentions, urgent: true },
        { id: 'calls', label: 'Calls', icon: <PhoneIcon size={15} />, count: callsFetch.data?.counts.missed ?? 0, urgent: true },
        { id: 'recordings', label: 'Recordings', icon: <PlayCircleIcon size={15} /> },
      ]}
      conversations={rows}
      sectionOrder="dms-first"
      maxVisible={8}
      selected={selected}
      onSelect={(selection) => {
        if (selection.kind === 'shelf') {
          setPicking(false);
          if (selection.id === 'calls' || selection.id === 'recordings') { setShelf(null); navigate(`/social/${selection.id}`); return; }
          setShelf(selection.id === 'mentions' ? 'mentions' : 'activity');
          return;
        }
        const channelSlug = slugFromChannel(selection.channel);
        if (channelSlug) navigate(channelHref(channelSlug));
        else if (selection.channel.startsWith(DM_PREFIX)) navigate(dmHref(selection.channel));
      }}
      {...(call.unavailable ? {} : {
        onStartCall: (channel: string) => {
          const peers = dmPeers(channel, me, roster, conversations.find((c) => c.channel === channel)?.peers);
          if (peers.length) call.callPeople(peers);
        },
      })}
      collapsedSections={folded.folded}
      onToggleSection={folded.set}
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
      beforeList={(
        <>
          <Stack gap="none" data-testid="social-active-now-section">
            <RailSectionHeader label="Active now" presentational={false} count={people.length}
              collapsed={folded.isFolded('Active now')} onToggleCollapse={(next) => folded.set('Active now', next)}
              controls="social-active-now" />
            {!folded.isFolded('Active now') && <ActivePeopleGrid
              people={people}
              emptyLabel="Nobody is sharing work or online right now."
              maxVisible={8}
              onSelectPerson={(userId) => { void startDm(userId); }}
              data-testid="social-active-now"
            />}
          </Stack>
          {teamsFetch.error && !teamsFetch.data ? null : (
            <TeamChannelTree
              teams={tree}
              filter={query}
              activeChannel={openTeam ? teamChannel : null}
              onSelectChannel={(channel) => goTeams({ channel })}
              onToggleTeam={(teamId, expanded) => folded.set(`team:${teamId}`, !expanded)}
              onManageTeam={(teamId) => goTeams({ team: teamId })}
              onLeaveTeam={(teamId) => { void teamMembership('DELETE', me, teamId); }}
              collapsed={folded.isFolded('Teams')}
              onToggleCollapse={(next) => folded.set('Teams', next)}
              {...(mayManageTeams ? { onCreateTeam: (trigger: HTMLElement) => { teamAnchor.current = trigger; setCreatingTeam(true); } } : {})}
              data-testid="social-team-tree"
            />
          )}
          <SocialRoomsSection rooms={roomsFetch} mayCreate={mayCreateChannel}
            onOpen={(slug) => navigate(`/social/rooms?room=${encodeURIComponent(slug)}`)} />
        </>
      )}
      emptyLabel={conversationsError ? `Couldn’t load your conversations — ${conversationsError}.` : 'No conversations yet'}
      data-testid="social-chat-rail"
    />
  );

  // ── The pane ──────────────────────────────────────────────────────────
  const openChannel = slug ? channels.find((c) => c.slug === slug) ?? null : null;
  const dmListed = lobby ? conversations.find((c) => c.channel === lobby) : undefined;
  const dmPeople = lobby ? dmPeers(lobby, me, roster, dmListed?.peers) : [];
  const candidateColumns: DataTableColumn<Candidate>[] = [
    { key: 'displayName', header: 'Name', sortable: true },
    { key: 'hint', header: 'Role', width: '160px' },
  ];
  const candidates = useMemo<Candidate[]>(
    () => teamCandidates(dmCandidates(peopleFetch.data?.people ?? [], me), members),
    [peopleFetch.data, me, members],
  );
  const isOwner = detail.data?.team.role === 'owner';
  const canEditMembers = mayManageTeams && isOwner;

  const recordingsFor = (lobbyName: string) => conversationRecordings(recordingsFetch.data?.recordings ?? [], lobbyName);
  const openRecording = (id: string) => navigate(`/social/recordings?recording=${encodeURIComponent(id)}`);
  const conversationCall = (channel: string, title: string) => (call.unavailable ? {} : {
    onStartCall: (audioOnly: boolean) => call.callConversation({ channel, title }, { audioOnly }),
  });

  function pane() {
    if (route === 'calls' && !shelf && !picking) return <CallLogPane calls={callsFetch} me={me} nameOf={nameOf} rooms={rooms} call={call} />;
    if (route === 'recordings' && !shelf && !picking) return <RecordingsPane me={me} nameOf={nameOf} rooms={rooms} mayManage={mayManageRecordings} />;
    if (shelf === 'activity') {
      return <WrappedNotificationCenter notifications={inboxView} className="min-h-0 flex-1"
        onItemClick={(item, entry) => {
          markRead(item.id);
          const href = entry?.action?.href;
          if (href && href.startsWith('/') && !href.startsWith('//')) navigate(href);
        }} data-testid="social-activity-pane" />;
    }
    if (shelf === 'mentions') {
      return mentions.length
        ? <ChannelMentionsPanel className="min-h-0 flex-1" mentions={mentions} data-testid="social-mentions-pane"
          onJump={(channel, id) => { markRead(id); const s = slugFromChannel(channel); if (s) navigate(channelHref(s)); }} />
        : <EmptyState align="start" testId="social-mentions-empty" title="No mentions"
          description="When someone writes @ and your name in a channel you are in, it lands here." />;
    }
    if (picking) {
      return <NewConversationPanel className="min-w-0 flex-1" people={dmCandidates(peopleFetch.data?.people ?? [], me)}
        peopleError={peopleFetch.error} busy={busy} onStartDm={startDm} onCancel={() => setPicking(false)} data-testid="social-dm-picker" />;
    }
    if (route === 'channels') {
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
        return <SocialConversation key={openChannel.channel} channel={openChannel.channel} name={`#${openChannel.slug}`}
          description={`${openChannel.memberCount} ${openChannel.memberCount === 1 ? 'member' : 'members'}${openChannel.description ? ` · ${openChannel.description}` : ''}`}
          view={view} onViewChange={setView}
          {...conversationCall(openChannel.channel, `#${openChannel.slug}`)} callInProgress={call.activeLobby === openChannel.channel}
          recordings={recordingsFor(openChannel.channel)} onOpenRecording={openRecording}
          menu={[{ label: `Leave #${openChannel.slug}`, danger: true, disabled: busy, onSelect: () => void channelMembership('leave', openChannel), 'data-testid': 'social-leave-channel' }]}
          userId={me} displayName={displayName} placeholder={`Message #${openChannel.slug}`} />;
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
          actionLabel="New message" onAction={openNewDm} />;
      }
      if (!mine) return <EmptyState align="start" testId="social-dm-missing" title="This conversation is not yours" description="A direct message opens only for the people it names." />;
      return <SocialConversation key={lobby} channel={lobby} name={dmTitle(dmPeople)} userId={me} displayName={displayName}
        online={dmPeople.some((p) => online.has(p.userId))}
        view={view} onViewChange={setView}
        {...(call.unavailable ? {} : { onStartCall: (audioOnly: boolean) => call.callPeople(dmPeople, { audioOnly }) })}
        callInProgress={call.activeLobby === lobby}
        recordings={recordingsFor(lobby)} onOpenRecording={openRecording}
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
      return <SocialConversation key={teamChannel!} channel={teamChannel!} name={`${openTeam.team.name} · ${openTeam.channel.name}`}
        {...(openTeam.team.description || members.length ? {
          description: [members.length ? `${members.length} ${members.length === 1 ? 'member' : 'members'}` : '', openTeam.team.description ?? ''].filter(Boolean).join(' · '),
        } : {})}
        view={view} onViewChange={setView}
        {...conversationCall(teamChannel!, `${openTeam.team.name} · ${openTeam.channel.name}`)} callInProgress={call.activeLobby === teamChannel}
        recordings={recordingsFor(teamChannel!)} onOpenRecording={openRecording}
        menu={[{ label: 'Members', onSelect: () => goTeams({ team: openTeam.team.teamId }), 'data-testid': 'social-team-open-members' }]}
        userId={me} displayName={displayName} placeholder={`Message ${openTeam.channel.name}`} />;
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
            members={members.map((m) => ({ id: m.userId, name: m.displayName, role: m.role, addedAt: m.addedAt }))}
            open={detail.data.team.visibility === 'org'}
            canManage={canEditMembers}
            currentUserId={me}
            {...(canEditMembers ? { onAdd: () => setAdding(true), onRemove: (userId: string) => void teamMembership('DELETE', userId) } : {})}
            data-testid="social-team-members"
          />
        </Stack>
      );
    }
    if (managing && detail.error) return <EmptyState align="start" testId="social-team-missing" title="This team is not available" description="It does not exist, or it is private and you are not on it." />;
    if (teams.length === 0) {
      return <EmptyState testId="social-empty-teams" align="start" title="You are not on a team yet"
        description={mayManageTeams
          ? 'A team groups people and their channels. Create one and add the people it is for.'
          : 'A team groups people and their channels. A moderator adds you to one.'}
        {...(mayManageTeams ? { action: <Button variant="primary" size="sm" onClick={(e) => { teamAnchor.current = e.currentTarget; setCreatingTeam(true); }} data-testid="social-empty-create-team">New team</Button> } : {})} />;
    }
    return <EmptyState align="start" title="Pick a channel" description="Choose a team's channel on the left to read it, or open a team's ⋯ menu to see who is on it." />;
  }

  return (
    <Stack gap="none" className="min-h-0 min-w-0 bg-surface" data-shell-flush data-testid={PAGE_TESTID[route]}>
      <VisuallyHidden as="h1">{PAGE_TITLE[route]}</VisuallyHidden>
      <ViewportFillRegion className="flex min-w-0" data-testid="social-chat-workspace">
        {rail}
        <Stack as="section" aria-label={PAGE_TITLE[route]} gap="sm" className="min-h-0 min-w-0 flex-1 overflow-hidden px-5 py-4" data-testid="social-chat-pane">
          {problem && <InlineAlert tone="error" onDismiss={() => setProblem(null)}>{problem}</InlineAlert>}
          {call.notice && <InlineAlert tone="warning" onDismiss={call.clearNotice}>{call.notice}</InlineAlert>}
          {pane()}
        </Stack>
      </ViewportFillRegion>
      {/* Always anchored to the control that opened them: centred, the
          library's PopoverForm has no Escape (docs/ui-components-queue.md). */}
      <CreateChannelDialog open={creatingChannel} teamName="Social" anchor={channelAnchor}
        onCreate={createChannel} onClose={() => setCreatingChannel(false)} data-testid="social-create-channel-dialog" />
      <RoomCreateDialog open={creatingRoom} onClose={() => setCreatingRoom(false)} mayCreate={mayCreateChannel}
        createRoom={roomsModel.createRoom} onCreated={(slug) => navigate(`/social/rooms?room=${encodeURIComponent(slug)}`)} />
      <CreateTeamDialog open={creatingTeam} anchor={teamAnchor} onCreate={createTeam} onClose={() => setCreatingTeam(false)} data-testid="social-create-team-dialog" />
      <Modal open={adding} onClose={() => setAdding(false)} title="Add people to the team" maxWidth={560}
        footer={<Button variant="secondary" size="sm" onClick={() => setAdding(false)}>Done</Button>}>
        <DataTable
          data={candidates}
          columns={candidateColumns}
          keyField={(c) => c.userId}
          searchable
          searchPlaceholder="Find a person"
          emptyMessage="Everyone in this workspace is already on the team."
          rowActions={(c) => <Button variant="ghost" size="sm" disabled={busy} onClick={() => void teamMembership('POST', c.userId)} data-testid="social-team-add-person">Add</Button>}
          data-testid="social-team-candidates"
        />
      </Modal>
    </Stack>
  );
}
