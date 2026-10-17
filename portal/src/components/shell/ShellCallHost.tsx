// Calls belong to the authenticated shell, rather than any route family. The
// call itself — one `useConversationCall`, rings, the pre-join device check,
// the one media sink and the call block a composer carries — is the library's
// call block host (lib/conversationCall.tsx, ui-components 2.439). What stays
// here is this app's: where Accept and People navigate, the call log, the
// session check while media is live, and the huddle conversation.
import { useCallback, useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useSession } from '../../lib/auth';
import { CallHostProvider, CallMediaOutlet, useCallHost, type OnCallHostEvent } from '../../lib/conversationCall';
import { realtimeTokenSource } from '../../lib/realtimeToken';
import { useRealtimeEndpoints } from '../../lib/useRealtimeEndpoints';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { useSelfAvatar } from '../../hooks/usePageCalls';
import { callLogEvents, reportCallLogEvents, type CallLogEventBody } from '../../pages/social/socialCallLog';
import { isPageCallLobby, pageHuddleLogBodies, startPageHuddleTracker, type PageHuddleTracker } from '../../lib/pageCalls';
import { roomSlugFromLobby } from '../../pages/social/socialPlatform';
import { acceptedCallHref, callPeopleHref, callScopeKey, shellCallDockTestId } from './callShellModel';
import { HuddleChatProvider, HuddleChatPanel, HuddleReactionOverlay, useHuddleChat, useHuddleChatToggle, useHuddleReact } from './HuddleChat';
import { PostCallRecordingMonitor } from '../recordings/PostCallRecording';
import { SHELL_MEETING } from '../../lib/meetingRooms';
import { CallMeetingProvider, MeetingStageHeader } from './CallMeeting';

const getToken = async () => (await realtimeTokenSource.get()).token;
/** The pre-join choices were remembered under this key before the call host moved into the library. */
const PRE_JOIN_KEY = 'orgiq.call-prejoin.v1';

export const ACTIVE_CALL_SESSION_REFRESH_MS = 30_000;

/** Check cookie authority while media is active, including away from tenant pages. */
function CallSessionMonitor() {
  const host = useCallHost();
  const { refresh } = useSession();
  const phase = host?.call.phase ?? 'idle';
  const active = !['idle', 'ended', 'failed'].includes(phase);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let pending = false;
    const check = () => {
      if (!live || pending) return;
      pending = true;
      void refresh().finally(() => { pending = false; });
    };
    const visible = () => { if (document.visibilityState === 'visible') check(); };
    const timer = window.setInterval(check, ACTIVE_CALL_SESSION_REFRESH_MS);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [active, refresh]);
  return null;
}

/** A room entered alone has no invite/accept callback; report its live lifecycle. */
function RoomCallLog({ report }: { report: OnCallHostEvent }) {
  const host = useCallHost();
  const phase = host?.call.phase ?? 'idle';
  const callId = host?.call.call?.callId ?? null;
  const lobbyName = host?.lobby?.lobbyName ?? null;
  const selfId = host?.self?.userId ?? '';
  const joined = useRef<{ callId: string; lobbyName: string } | null>(null);
  useEffect(() => {
    if (!lobbyName || !roomSlugFromLobby(lobbyName)) return;
    if (phase === 'live' && callId && joined.current?.callId !== callId) {
      joined.current = { callId, lobbyName };
      report('started', { callId, lobbyName, channel: lobbyName, peerUserIds: [] }, { host: selfId, selfId });
    } else if ((phase === 'idle' || phase === 'ended' || phase === 'failed') && joined.current) {
      const was = joined.current;
      joined.current = null;
      report('ended', { callId: was.callId, lobbyName: was.lobbyName, channel: was.lobbyName, peerUserIds: [] }, { host: selfId, selfId });
    }
  }, [phase, callId, lobbyName, selfId, report]);
  return null;
}

/**
 * A tenant page's huddle (`orgiq:initiative:<id>`, `assessment:team:<id>`,
 * `assessment:doc:<id>`, `pipelines:run:<id>`) is entered like a room — nobody
 * is rung, so no invite/accept callback fires. Report your own attendance to
 * the same call log Social reads (lib/pageCalls.ts says when and why late).
 */
function PageHuddleCallLog({ report }: { report: (bodies: CallLogEventBody[], selfId: string) => void }) {
  const host = useCallHost();
  const phase = host?.call.phase ?? 'idle';
  const live = host?.call.call ?? null;
  const callId = live?.callId ?? null;
  const lobbyName = host?.lobby?.lobbyName ?? null;
  const selfId = host?.self?.userId ?? '';
  const tracker = useRef<PageHuddleTracker | null>(null);
  const peerIds = (live?.participants ?? []).filter(p => !p.isLocal && p.userId && p.userId !== selfId && (p.state === 'in-call' || p.state === 'reconnecting')).map(p => p.userId).sort().join(',');
  useEffect(() => {
    if (!selfId) return;
    const inCall = phase === 'live' || phase === 'reconnecting';
    if (inCall && callId && lobbyName && isPageCallLobby(lobbyName) && tracker.current?.callId !== callId) {
      tracker.current = startPageHuddleTracker(callId, lobbyName);
    }
    const t = tracker.current;
    if (!t) return;
    if (inCall) {
      for (const id of peerIds ? peerIds.split(',') : []) t.peers.add(id);
      report(pageHuddleLogBodies(t, { selfId, ...(host?.self?.displayName ? { selfName: host.self.displayName } : {}) }, false), selfId);
    } else if (phase === 'idle' || phase === 'ended' || phase === 'failed') {
      tracker.current = null;
      report(pageHuddleLogBodies(t, { selfId, ...(host?.self?.displayName ? { selfName: host.self.displayName } : {}) }, true), selfId);
    }
  }, [phase, callId, lobbyName, selfId, peerIds, report]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function HuddleDialogueMonitor({ onChange }: { onChange?: (open: boolean) => void }) {
  const chat = useHuddleChat();
  const open = !!chat?.open && chat.view === 'pane';
  useEffect(() => { onChange?.(open); }, [open, onChange]);
  return null;
}

/** The meeting panes' provider, named from the huddle's seat roster (the BFF resolves those names). */
function MeetingSeats({ children }: { children: ReactNode }) {
  const chat = useHuddleChat();
  return <CallMeetingProvider seats={chat?.participants ?? NO_SEATS}>{children}</CallMeetingProvider>;
}
const NO_SEATS: readonly { userId: string; displayName: string }[] = [];

function BoundCallWorkspace({ channel }: { channel: MutableRefObject<string | null> }) {
  const host = useCallHost();
  const current = host?.lobby?.channel ?? null;
  useEffect(() => { channel.current = current; }, [channel, current]);
  return null;
}

export function ShellCallHost({ children, onDialogueChange }: { children: ReactNode; onDialogueChange?: (open: boolean) => void }) {
  const { session } = useSession();
  const navigate = useNavigate();
  const { platformApiUrl, videoUrl } = useRealtimeEndpoints(!!session);
  const frames = useGatewayFrames();
  // Your tile's fallback face (the library draws it when video is off); none → initials.
  const selfAvatar = useSelfAvatar(!!session);
  const reporter = useRef({ baseUrl: platformApiUrl, selfId: session?.sub, selfName: session?.name ?? '' });
  reporter.current = { baseUrl: platformApiUrl, selfId: session?.sub, selfName: session?.name ?? '' };
  const onCallEvent = useCallback<OnCallHostEvent>((kind, event, ctx) => {
    const current = reporter.current;
    // A retired actor's cleanup must not post with the next actor's token.
    if (ctx.selfId !== current.selfId) return;
    const events = callLogEvents(kind, event, { ...ctx, ...(current.selfName ? { selfName: current.selfName } : {}) });
    void reportCallLogEvents(events, { baseUrl: current.baseUrl, getToken });
  }, []);
  const reportBodies = useCallback((bodies: CallLogEventBody[], selfId: string) => {
    const current = reporter.current;
    if (!bodies.length || selfId !== current.selfId) return;
    void reportCallLogEvents(bodies, { baseUrl: current.baseUrl, getToken });
  }, []);
  // Accept opens what the call is about (the initiative, Search on the same people, the document).
  const location = useLocation();
  const here = useRef('');
  const boundChannel = useRef<string | null>(null);
  here.current = `${location.pathname}${location.search}`;
  const onAccept = useCallback((ring: { channel: string | null }) => {
    const href = acceptedCallHref(ring.channel, here.current, boundChannel.current);
    if (href && href !== here.current) navigate(href);
  }, [navigate]);
  const self = session ? { userId: session.sub, displayName: session.name || session.sub, ...(selfAvatar ? { avatarUrl: selfAvatar } : {}) } : null;
  return <CallHostProvider scopeKey={callScopeKey(session)} self={self} tenant={session?.tenant ?? null}
    platformApiUrl={platformApiUrl} getIdToken={getToken} videoUrl={videoUrl}
    gateway={frames.gateway} gatewayConfigured={frames.configured} connectionState={frames.connectionState}
    onAccept={onAccept} onCallEvent={onCallEvent} preJoinStorageKey={PRE_JOIN_KEY}
    // The meeting rides only the lobbies lib/meetingRooms.ts names (initiative huddles, behind VITE_MEETING_ROOMS).
    meeting={SHELL_MEETING}>
    <BoundCallWorkspace channel={boundChannel} />
    <CallSessionMonitor />
    <RoomCallLog report={onCallEvent} />
    <PageHuddleCallLog report={reportBodies} />
    <HuddleChatProvider><MeetingSeats><HuddleDialogueMonitor onChange={onDialogueChange} />{children}</MeetingSeats></HuddleChatProvider>
  </CallHostProvider>;
}

/**
 * The only playback sink (the library `CallMediaOutlet`): the call dock draws
 * into whichever surface claims it — a composer's call block, a page's block,
 * the right pane's media panel — else stays collapsed in the footer. This app
 * says where People and a document chip go, and draws the in-call reactions.
 */
/** The stage header's meeting toolbar, with this shell's chat toggle and huddle reactions. */
function ShellMeetingStage() {
  return <MeetingStageHeader chat={useHuddleChatToggle()} react={useHuddleReact()} />;
}

export function ShellCallMedia({ id }: { id?: string }) {
  const navigate = useNavigate();
  return <>
    <CallMediaOutlet {...(id ? { id } : {})} overlay={<HuddleReactionOverlay />} header={<ShellMeetingStage />}
      onOpenPeople={(lobby, tenant) => { const href = callPeopleHref(lobby.channel, tenant); if (href) navigate(href); }}
      onOpenDocument={doc => { if (doc.href) navigate(doc.href); }}
      dockTestId={(lobby, tenant) => shellCallDockTestId(lobby.channel, tenant)} />
    <HuddleChatPanel />
    <PostCallRecordingMonitor />
  </>;
}
