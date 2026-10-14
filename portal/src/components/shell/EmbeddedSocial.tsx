import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useGatewayOptional, usePresence } from '@connorhoehnslalom/realtime-modules/client';
import { useSharedNotifications } from './SharedNotifications';
import { WrappedNotificationBell } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { Button, ChatIcon, EmptyState, ExternalLinkIcon, IconButton, Inline, PresenceAvatars, PresenceDot, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import type { ConversationFeature } from '@connorhoehnslalom/ui-components/social';
import { ChannelBinding, useChannelBinding, type ChannelBindingState } from '../social/ChannelBindingStrip';
import { useSession } from '../../lib/auth';
import type { CallPageDescriptor } from '../../lib/callPages';
import { tenantEnabled } from '../../lib/features';
import { EmbeddedSocialSession, createEmbeddedSocialClient, embeddedSocialScopeKey, embeddedTokenMatchesSource,
  emptyEmbeddedSocialState, type EmbeddedSocialDraft, type EmbeddedSocialState, type EmbeddedSocialTransport } from '../../lib/embeddedSocial';
import { realtimeTokenSource } from '../../lib/realtimeToken';
import { communicationUnread, communicationUnreadCount } from '../../lib/communicationPlane';
import { presenceAvatarUsers } from '../../pages/assessment/knowledge/knowledgeFormat';
import SocialConversation from '../../pages/social/SocialConversation';
import { TenantDirectEntry } from './TenantDirectMessages';
import { MessagesOverviewDialog, type ConversationPreview } from './MessagesOverviewDialog';
import { showSocialTenantDoor, socialActivityPath, socialEntryTarget } from './socialEntryModel';
import { SOCIAL_PRESENCE_CHANNEL, namesFrom } from '../../pages/social/socialPlatform';
import { dmTitle, socialInbox, type SocialPerson, type SocialDm } from '../../pages/social/socialChat';

export interface EmbeddedSocialContextValue {
  /** This embedding is available without selecting the Social workspace. */
  available: boolean; actorId: string | null; people: readonly SocialPerson[]; conversations: readonly SocialDm[];
  selected: string | null; canSend: boolean; unavailableReason: string | null; onlineCount: number;
  presencePeople: ReturnType<typeof presenceAvatarUsers>;
  /** Signed source, fresh directory authority and matching connected transport. */
  presenceReady: boolean;
  me: { userId: string; displayName: string } | null; authorityVerified: boolean; canMessagePeople: boolean;
  openMessage(): void; openDm(userId: string): Promise<boolean>;
  /** Immutable peer capture; resolves true only after a persisted gateway receipt. */
  sendToPerson(userId: string, text: string, page?: CallPageDescriptor | null): Promise<boolean>;
  state: EmbeddedSocialState; controller: EmbeddedSocialSession;
  /** The Social channel bound to the page on screen (an initiative), offered as a tab in the bottom bar. */
  pageChannel: ChannelBindingState; pageOpen: boolean; openPageChannel(): void; selectPage(on: boolean): void;
  /** Pages name their binding context here; the bar shows it while they are mounted. */
  setPageContext(context: string | null): void;
}
const EmbeddedSocialContext = createContext<EmbeddedSocialContextValue | null>(null);
const IDLE = emptyEmbeddedSocialState();
const EMPTY_DRAFT: EmbeddedSocialDraft = { html: '', files: [] };
export const useEmbeddedSocial = (): EmbeddedSocialContextValue | null => useContext(EmbeddedSocialContext);

/**
 * A page's Social channel, in the bottom bar (docs/social-tenant-design.md §4.6).
 * The user, 2026-10-06: "the social bar is supposed to be on bottom with section
 * tabs" — so an initiative names `initiative:<id>` here instead of drawing a
 * binding strip at its top. Cleared when the page unmounts.
 */
export function usePageSocialChannel(context: string | null): void {
  const set = useContext(EmbeddedSocialContext)?.setPageContext;
  useEffect(() => {
    if (!set) return undefined;
    set(context);
    return () => set(null);
  }, [set, context]);
}

const PAGE_VIEWS: readonly ConversationFeature[] = ['chat', 'pins'];

/** Exactly one workspace announcement. Route surfaces may only read it. */
function ShellSocialPresence({ onPeople }: { onPeople: (people: ReturnType<typeof presenceAvatarUsers>) => void }) {
  const { roster } = usePresence(SOCIAL_PRESENCE_CHANNEL, { join: true });
  const people = useMemo(() => presenceAvatarUsers(roster.filter(entry => typeof entry.metadata?.userId === 'string')), [roster]);
  // Every presence frame hands usePresence a new roster array. Mirroring it into
  // the provider from a passive effect made each frame two commits, and a burst
  // of frames (reconnect, call joins) chained more than 50 passive updates in a
  // row: React's "Maximum update depth exceeded". Publish only a changed list,
  // and from the layout phase, so the mirror is never a nested passive update.
  const published = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = JSON.stringify(people);
    if (key === published.current) return;
    published.current = key; onPeople(people);
  }, [onPeople, people]);
  useLayoutEffect(() => () => { published.current = null; onPeople([]); }, [onPeople]);
  return null;
}

export function EmbeddedSocialProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const gateway = useGatewayOptional();
  const [controller] = useState(() => new EmbeddedSocialSession(createEmbeddedSocialClient()));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [present, setPresent] = useState<ReturnType<typeof presenceAvatarUsers>>([]);
  const [tokenProblem, setTokenProblem] = useState<string | null>(null);
  const [tokenRetry, setTokenRetry] = useState(0);
  const [pageContext, setPageContext] = useState<string | null>(null);
  const [pageView, setPageView] = useState(false);
  const [pageThreadView, setPageThreadView] = useState<ConversationFeature>('chat');
  const [pageLatest, setPageLatest] = useState<string | null>(null);
  const eligible = !!session && session.sub !== 'unknown' && tenantEnabled('social') && (session.grants.social?.length ?? 0) > 0;
  const scope = useMemo(() => eligible && session ? {
    userId: session.sub, tenant: session.tenant, role: session.role,
    actorId: session.masquerading?.actor ?? null, asUserId: session.masquerading?.asUser ?? null,
  } : null, [eligible, session?.sub, session?.tenant, session?.role, session?.masquerading?.actor, session?.masquerading?.asUser]);
  const scopeKey = embeddedSocialScopeKey(scope);
  useEffect(() => { controller.setScope(scope); if (scope) void controller.refresh(); return () => controller.setScope(null); }, [controller, scope]);
  const current = !!scope && state.scopeKey === scopeKey;
  const snapshot = current ? state.snapshot : null;
  const authority = snapshot?.authorityKey ?? null;
  const tokenMatches = !!snapshot && embeddedTokenMatchesSource(gateway?.authToken, snapshot.source);
  const connected = gateway?.connectionState === 'connected';
  const transportReady = current && state.authorityVerified && connected && tokenMatches;
  const attempted = useRef<string | null>(null);
  const reconnect = gateway?.reconnect;
  useEffect(() => {
    if (!snapshot || !reconnect || tokenMatches) { if (tokenMatches) setTokenProblem(null); return; }
    const attempt = `${scopeKey}:${authority}:${tokenRetry}`;
    if (attempted.current === attempt) return;
    attempted.current = attempt;
    let live = true; setTokenProblem('Refreshing Social connection authority…');
    realtimeTokenSource.clear();
    void realtimeTokenSource.get({ force: true }).then(token => {
      if (!live || controller.getSnapshot().snapshot?.authorityKey !== authority) return;
      if (!embeddedTokenMatchesSource(token.token, snapshot.source)) {
        setTokenProblem('Social connection authority changed. Refresh before sending.'); return;
      }
      reconnect();
    }, () => { if (live) setTokenProblem('Social connection could not be authenticated. Your local draft has been kept.'); });
    return () => { live = false; };
  }, [snapshot?.authorityKey, scopeKey, authority, tokenMatches, tokenRetry, reconnect, controller]);
  // Current directory checks are bounded. Route changes do not recreate this
  // provider, and idle identities without a Social grant make no requests.
  useEffect(() => {
    if (!scope) return;
    let live = true, pending = false;
    const check = () => {
      if (!live || pending) return; pending = true;
      void controller.refresh().finally(() => { pending = false; });
    };
    const restore = () => { if (document.visibilityState === 'visible') check(); };
    const timer = window.setInterval(check, 30_000);
    window.addEventListener('focus', restore); document.addEventListener('visibilitychange', restore);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener('focus', restore); document.removeEventListener('visibilitychange', restore); };
  }, [controller, scope]);
  useEffect(() => { if (scope && connected) void controller.refresh(); }, [controller, scope, connected, gateway?.sessionEpoch]);
  // The rail's Communication door counts Social DMs with new messages, from this same snapshot.
  useEffect(() => { communicationUnread.set(snapshot ? communicationUnreadCount(snapshot.conversations) : 0); }, [snapshot]);
  useEffect(() => () => communicationUnread.set(0), []);
  const validIds = useMemo(() => new Set([snapshot?.me.userId, ...(snapshot?.people.map(person => person.userId) ?? [])]), [snapshot]);
  // A face from the presence entry (the signed token's avatar), else from the
  // directory snapshot; neither → initials.
  const directoryAvatars = useMemo(() => new Map([snapshot?.me, ...(snapshot?.people ?? [])]
    .flatMap(person => person?.avatarUrl ? [[person.userId, person.avatarUrl] as const] : [])), [snapshot]);
  const presencePeople = useMemo(() => transportReady ? present.filter(person => validIds.has(person.id)).map(person => {
    const avatarUrl = person.avatarUrl ?? directoryAvatars.get(person.id);
    return avatarUrl ? { ...person, avatarUrl } : person;
  }) : [], [transportReady, present, validIds, directoryAvatars]);
  const online = useMemo(() => new Set(presencePeople.filter(person => !person.idle).map(person => person.id)), [presencePeople]);
  const pageChannel = useChannelBinding(eligible ? pageContext : null);
  const pageBound = pageChannel.data?.binding ?? null;
  useEffect(() => { if (!pageChannel.visible) setPageView(false); }, [pageChannel.visible]);
  useEffect(() => { setPageLatest(null); setPageThreadView('chat'); }, [pageBound?.channel]);
  const unavailableReason = !current ? 'Social is unavailable for this session.' : !snapshot ? state.error ?? 'Loading Social…'
    : !state.authorityVerified ? state.error ?? 'Refresh Social authority before sending.' : !connected ? 'Reconnect to send direct messages.'
    : !tokenMatches ? tokenProblem ?? 'Social connection authority is being refreshed.' : !snapshot.canSend ? 'You cannot send direct messages.' : null;
  const value = useMemo<EmbeddedSocialContextValue>(() => ({
    available: eligible, actorId: current ? scope?.userId ?? null : null, people: snapshot?.people ?? [], conversations: snapshot?.conversations ?? [],
    selected: current ? state.selected : null, canSend: !unavailableReason && !state.pending && !state.opening,
    me: snapshot?.me ?? null, authorityVerified: current && state.authorityVerified,
    canMessagePeople: !unavailableReason && !state.pending && !state.opening,
    unavailableReason, onlineCount: online.size, presencePeople, presenceReady: transportReady, state: current ? state : IDLE, controller,
    openMessage: () => controller.openMessage(), openDm: userId => controller.openDm(userId).then(Boolean),
    sendToPerson: (userId, text, page) => transportReady ? controller.sendToPerson(userId, text, page) : Promise.resolve(false),
    pageChannel, pageOpen: pageView && state.open,
    openPageChannel: () => { setPageView(true); controller.openMessage(); }, selectPage: setPageView,
    setPageContext,
  }), [eligible, current, scope?.userId, snapshot, state, unavailableReason, online.size, presencePeople, controller, transportReady, pageChannel, pageView]);
  const bind = useCallback((runtime: EmbeddedSocialTransport) => authority && transportReady
    ? controller.bindTransport(authority, runtime) : undefined, [authority, transportReady, controller]);
  const refresh = useCallback(() => { void controller.refresh(); setTokenRetry(value => value + 1); }, [controller]);
  const frameListen = gateway?.onMessage;
  useEffect(() => frameListen?.(frame => {
    if (frame.type === 'chat' && frame.action === 'message' && typeof frame.channel === 'string' && frame.channel.startsWith('social:dm:')) {
      void controller.refresh();
    }
  }), [controller, frameListen]);
  const selectedDm = snapshot?.conversations.find(dm => dm.channel === state.selected);
  const panel = (conversation?: ReactNode) => <EmbeddedSocialPanel conversation={conversation} online={online} refresh={refresh}
    pageView={pageView} onPageView={setPageView} latest={pageLatest} />;
  // One panel at a time: the DM thread's hooks stay mounted while the page's
  // channel is shown (its surface renders nothing), and the reverse.
  const renderDm = (conversation?: ReactNode) => pageView ? null : panel(conversation);
  const pageStrip = <ChannelBinding state={pageChannel} latest={pageLatest} className="border-b border-border px-3 py-2" data-testid="embedded-social-page-binding" />;
  const pageLive = current && tokenMatches && !!snapshot && !!pageBound && !!pageChannel.data?.joined;
  const pagePane = (thread?: ReactNode) => <Stack gap="none" className="min-h-0 min-w-0 flex-1" data-testid="shell-social-page">
    {pageStrip}
    {thread ?? <EmptyState title={pageBound ? 'Not a member of this channel' : 'No channel bound'}
      description={pageBound ? 'Join the channel in Social to read and post here.' : 'Bind a Social channel to give this page a discussion.'} />}
  </Stack>;
  return <EmbeddedSocialContext.Provider value={value}>
    {children}
    {transportReady && <ShellSocialPresence key={authority} onPeople={setPresent} />}
    {current && tokenMatches && snapshot && selectedDm && state.selected
      ? <SocialConversation compactCallDock key={`${authority}:${state.selected}`} channel={state.selected} name={dmTitle(selectedDm.peers)}
        {...(selectedDm.peers.length === 1 && selectedDm.peers[0]?.avatarUrl ? { avatarUrl: selectedDm.peers[0].avatarUrl } : {})}
        online={selectedDm.peers.some(person => online.has(person.userId))} view="chat" onViewChange={() => {}} declaredViews={['chat']}
        userId={snapshot.me.userId} displayName={snapshot.me.displayName} nameOf={namesFrom(snapshot.people)} placeholder={`Message ${dmTitle(selectedDm.peers)}`}
        maySend={snapshot.canSend && state.authorityVerified && connected} onRuntimeChange={bind} onSendText={text => controller.sendSelected(text)}
        draft={state.drafts[state.selected] ?? EMPTY_DRAFT}
        onDraftChange={(draft, previous) => {
          if (controller.getSnapshot().snapshot?.authorityKey !== authority) return;
          controller.setDraft(selectedDm.channel, { ...draft, files: [] }, previous as EmbeddedSocialDraft | undefined);
        }} renderSurface={renderDm} />
      : renderDm()}
    {pageLive && pageBound && snapshot
      ? <SocialConversation compactCallDock key={`${authority}:${pageBound.channel}`} channel={pageBound.channel} name={pageChannel.label ?? pageBound.name}
        view={pageThreadView} onViewChange={setPageThreadView} declaredViews={PAGE_VIEWS}
        userId={snapshot.me.userId} displayName={snapshot.me.displayName} nameOf={namesFrom(snapshot.people)}
        placeholder={`Message ${pageChannel.label ?? pageBound.name}`} maySend={snapshot.canSend && state.authorityVerified && connected}
        onLatestMessage={setPageLatest} renderSurface={thread => pageView ? panel(pagePane(thread)) : null} />
      : pageView ? panel(pagePane()) : null}
  </EmbeddedSocialContext.Provider>;
}

/**
 * The Social half of the footer row (docs/design/initiative-huddle-shell-plan.md,
 * "Global footer"; SocialFooter.tsx owns the row): Social opens the embedded
 * panel upward, ↗ is the explicit workspace switch (it reloads the app), the
 * workspace's online people counted once each, and the Social-scoped activity
 * bell — the same shared inbox and read marks as the header bell, opening
 * upward. A page's bound channel is the panel's first shelf entry, not a footer tab.
 */
export function EmbeddedSocialEntry() {
  const social = useEmbeddedSocial();
  if (!social) return null;
  // No Social grant: the tenant-neutral presence and DM entry (people who share
  // the active tenant, `<tenant>:lobby`, `<tenant>:dm:<ids>`).
  if (!social.available) return <TenantDirectEntry />;
  return <SocialEntryRow social={social} />;
}

function SocialEntryRow({ social }: { social: EmbeddedSocialContextValue }) {
  const inbox = useSharedNotifications();
  const { session, enterContext } = useSession(); const navigate = useNavigate(); const { pathname } = useLocation();
  const items = useMemo(() => socialInbox(inbox.notifications), [inbox.notifications]);
  const activity = useMemo(() => ({ ...inbox, notifications: [...items].reverse(), unreadCount: items.filter(item => !item.read).length,
    markAllRead: () => items.filter(item => !item.read).forEach(item => inbox.markAsRead(item.id)) }), [inbox, items]);
  const { state, controller } = social;
  const socialRole = session?.grants.social?.[0] ?? null;
  const target = socialEntryTarget({ tenant: session?.tenant, hasSocialGrant: !!socialRole,
    pageChannelSlug: social.pageChannel.data?.binding?.slug ?? null, pathname });
  // Alt-click keeps the quick-DM panel reachable for a granted user, whose plain click now goes to the Communication plane.
  const openSocial = (event?: { altKey?: boolean }) => {
    if (event?.altKey) { social.selectPage(false); social.openMessage(); return; }
    if (target.kind === 'navigate') { controller.closeMessage(); navigate(target.path); return; }
    if (target.kind === 'here') { controller.closeMessage(); return; }
    social.selectPage(false); social.openMessage();
  };
  const activityPath = socialActivityPath(session?.tenant, !!socialRole);
  const messagesOn = state.open && !social.pageOpen && !state.activity;
  return <Inline gap="sm" align="center" wrap={false} className="min-w-0" data-testid="shell-social-bar">
    <Inline gap="none" align="center" wrap={false}>
      <Button variant="ghost" size="sm" onClick={openSocial} title="Social — Alt-click for the quick message panel"
        aria-pressed={messagesOn} data-testid="shell-social-open">
        <Inline gap="xs" align="center" wrap={false}><ChatIcon size={16} />Social</Inline>
      </Button>
      {socialRole && showSocialTenantDoor(session?.tenant, true) && <IconButton variant="ghost" size="sm" aria-label="Open the Social tenant" title="Open the Social tenant (reloads the app)"
        icon={<ExternalLinkIcon size={14} />} onClick={() => void enterContext('social', socialRole, '/social/channels')}
        data-testid="shell-social-workspace" />}
    </Inline>
    <Inline gap="xs" align="center" wrap={false} className="border-l border-border pl-3">
      {social.presencePeople.length > 0 && <Inline gap="none" align="center" className="hidden xl:flex">
        <PresenceAvatars size={20} maxVisible={4} users={social.presencePeople} />
      </Inline>}
      <PresenceDot state={social.onlineCount > 0 ? 'online' : 'offline'} pulse={false} size="sm" />
      {/* Tabular digits: a live count changing (7 → 8 online) must not shift the footer controls after it. */}
      <T size="xs" tone="secondary" tabular className="whitespace-nowrap" data-testid="shell-social-online">{social.onlineCount} online</T>
    </Inline>
    <Inline gap="none" align="center" className="border-l border-border pl-2">
      <WrappedNotificationBell notifications={activity} placement="bottom-start" size="sm" label="Social activity"
        // The capped panel's footer link to the full Activity view (ui-components 2.443.1).
        {...(activityPath ? { seeAll: { onSelect: () => { controller.closeMessage(); navigate(activityPath); } } } : {})}
        onItemClick={(item, entry) => {
          inbox.markAsRead(item.id); const href = entry?.action?.href;
          if (href?.startsWith('/social/dms/')) {
            try { controller.selectDm(decodeURIComponent(href.slice('/social/dms/'.length))); social.selectPage(false); } catch { /* malformed historical link */ }
          } else if (href?.startsWith('/') && !href.startsWith('//')) navigate(href);
        }} data-testid="shell-social-activity" />
    </Inline>
  </Inline>;
}

function EmbeddedSocialPanel({ refresh, latest, pageView }: {
  conversation?: ReactNode; online: Set<string>; refresh(): void; pageView: boolean; onPageView(on: boolean): void; latest: string | null;
}) {
  const social = useEmbeddedSocial();
  const { session, enterContext } = useSession();
  if (!social?.available) return null;
  const { state, controller } = social, snapshot = state.snapshot;
  const binding = social.pageChannel.data?.binding;
  const conversations: ConversationPreview[] = (snapshot?.conversations ?? []).map(dm => ({
    id: dm.channel, title: dmTitle(dm.peers), ...(dm.peers[0]?.avatarUrl ? { avatarUrl: dm.peers[0].avatarUrl } : {}),
    preview: dm.lastMessagePreview, at: dm.lastMessageAt, unread: dm.unreadCount ?? 0,
  }));
  if (binding && social.pageChannel.data?.joined) conversations.unshift({ id: binding.channel,
    title: social.pageChannel.label ?? binding.name, preview: latest, at: null, unread: 0 });
  return <MessagesOverviewDialog key={state.scopeKey} open={state.open} onClose={() => controller.closeMessage()}
    title="Social" {...(social.pageChannel.label ? { context: social.pageChannel.label } : {})}
    preferredId={pageView ? binding?.channel ?? null : state.selected}
    conversations={conversations} loading={state.loading} error={state.error ?? social.unavailableReason}
    onRefresh={refresh} onOpenSocial={async id => {
      const role = session?.grants.social?.[0];
      if (!role) throw new Error('Social access is no longer available. Choose a workspace again.');
      const path = id?.startsWith('social:dm:') ? `/social/dms/${encodeURIComponent(id)}`
        : id?.startsWith('social:ch:') ? `/social/channels/${encodeURIComponent(id.slice('social:ch:'.length))}` : '/social/channels';
      await enterContext('social', role, path);
      controller.closeMessage();
    }} testId="embedded-social-panel" />;
}
