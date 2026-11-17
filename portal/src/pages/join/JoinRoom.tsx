// The candidate's room (docs/interviews-tenant-plan.md row I2.4, the candidate's side; decision 21; contract D1).
//
// Once the lead has let the candidate in, the page reads its room (D1 `GET /api/interview-invite/room`) and the
// guest's realtime token itself, and joins the call of `room.lobbyName` in this window. The layout is the panel's
// without Milo's context: the call's tiles fill the window (the library's `CallBlock`, claimed as the call's grid,
// bound to the lobby as the panel's page binds it), the call chat is the one right pane, and the call's controls sit
// at the bottom in the library's `HuddleBar` (microphone, camera, Leave) with the time left beside them. No shell,
// no rails, no bell, no tenant chrome, no sharing, rooms, reactions, Milo, transcript, plan or questions. In a
// technical round the pane is the code pad with its runs, and the chat is the pane's second tab (GuestPadPane).
//
// The room is read every few seconds (bounded, stopped on unmount). `ended`, or a not-found (turned away mid-call,
// the link taken back), leaves the call and opens the ended page. Leave returns to a line offering to rejoin.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { conversationCallDockProps } from '@connorhoehn/realtime-modules/client/video';
import { Button, EmptyState, Inline, LoadingState, PageFrame, Stack, T } from '@connorhoehn/ui-components/shared';
import { HuddleBar, type HuddleBarMedia, type HuddleBarPhase } from '@connorhoehn/ui-components/video';
import { CallBlock, CallMediaOutlet, callCounts, callDrawn, useCallBlock, useCallHost } from '../../lib/conversationCall';
import { hasJoinedCall } from '../../components/shell/callShellModel';
import { roomStartMs, timeLeftLabel, timeLeftTone } from '../../lib/interviewsRoom';
import type { RealtimeToken } from '../../lib/realtimeToken';
import { GuestCallHost } from './GuestCallHost';
import { GuestPadPane } from './GuestPadPane';
import { GuestRoomChat } from './GuestRoomChat';
import { readRoom } from './guestApi.ts';
import { GuestRealtimeOff, guestTokenSource } from './guestRealtime.ts';
import { ROOM_POLL_MS, roomMaxPolls, roomStepAfterRead, roomView, type GuestRoom } from './steps.ts';

export interface GuestInterview {
  opening: { title: string };
  round: { name: string; minutes: number };
  scheduledAt: string | null;
}

type TokenState = { kind: 'loading' } | { kind: 'ready'; token: RealtimeToken } | { kind: 'off' } | { kind: 'failed' };

export default function JoinRoom({ interview, onEnded }: { interview: GuestInterview; onEnded(): void }) {
  const [room, setRoom] = useState<GuestRoom | null>(null);
  const [over, setOver] = useState(false);
  const [token, setToken] = useState<TokenState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  // D1, read now and every few seconds until it says the room is over (bounded by the round's length).
  useEffect(() => {
    let live = true;
    let reads = 0;
    const max = roomMaxPolls(interview.round.minutes);
    const read = () => {
      if (!live || reads++ >= max) { window.clearInterval(timer); return; }
      void readRoom().then((r) => {
        if (!live) return;
        const next = roomStepAfterRead(r);
        if (r.kind === 'room') setRoom(r.room);
        if (next === 'ended') { live = false; window.clearInterval(timer); setOver(true); }
      });
    };
    const timer = window.setInterval(read, ROOM_POLL_MS);
    read();
    return () => { live = false; window.clearInterval(timer); };
  }, [interview.round.minutes]);

  // The guest's realtime token: its own route only. Not-found means no call from this page.
  useEffect(() => {
    let live = true;
    guestTokenSource.get().then(
      (t) => { if (live) setToken({ kind: 'ready', token: t }); },
      (e) => { if (live) setToken({ kind: e instanceof GuestRealtimeOff ? 'off' : 'failed' }); },
    );
    return () => { live = false; };
  }, [attempt]);

  const finish = useCallback(() => { guestTokenSource.clear(); onEnded(); }, [onEnded]);
  // Over before any call was mounted: straight to the ended page.
  const hostMounted = !!room && token.kind === 'ready';
  useEffect(() => { if (over && !hostMounted) finish(); }, [over, hostMounted, finish]);

  if (token.kind === 'off') {
    return <RoomFrame interview={interview}>
      <EmptyState title="Your interviewer has let you in"
        body="The call cannot open from this page yet. Your interviewer has been told you are here." testId="join-room-unavailable" />
    </RoomFrame>;
  }
  if (token.kind === 'failed') {
    return <RoomFrame interview={interview}>
      <EmptyState title="The call could not open just now" body="Check your connection, then try again."
        actionLabel="Try again" onAction={() => { setToken({ kind: 'loading' }); setAttempt((a) => a + 1); }} testId="join-room-retry" />
    </RoomFrame>;
  }
  if (!room || token.kind === 'loading') return <RoomFrame interview={interview}><LoadingState label="Opening the call" /></RoomFrame>;

  return <GuestCallHost token={token.token} tokens={guestTokenSource} self={room.self}>
    <GuestRoomCall room={room} over={over} onEnded={finish} />
  </GuestCallHost>;
}

/** The steps' quiet frame, while the call cannot draw yet. */
function RoomFrame({ interview, children }: { interview: GuestInterview; children: ReactNode }) {
  return <PageFrame title="Your interview" description={interview.opening.title} data-testid="join-page">
    <Stack gap="md" className="max-w-xl" data-testid="join-room">{children}</Stack>
  </PageFrame>;
}

const BAR_PHASE: Record<string, HuddleBarPhase> = {
  live: 'live', calling: 'connecting', connecting: 'connecting', reconnecting: 'reconnecting', failed: 'ended', ended: 'ended',
};
const bareToggle = (control: { on: boolean; onToggle: () => void; permission?: HuddleBarMedia['permission']; level?: number; disabledReason?: string }): HuddleBarMedia => ({
  on: control.on, onToggle: control.onToggle,
  ...(control.permission ? { permission: control.permission } : {}),
  ...(control.level !== undefined ? { level: control.level } : {}),
  ...(control.disabledReason ? { disabledReason: control.disabledReason } : {}),
});
const noop = () => {};

function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(t);
  }, [stepMs]);
  return now;
}

/** The call, inside the guest's call host: tiles, the chat pane, and the bar. */
function GuestRoomCall({ room, over, onEnded }: { room: GuestRoom; over: boolean; onEnded(): void }) {
  const lobbyName = room.lobbyName;
  const title = room.round.name;
  // The interview's lobby, bound as the panel's page binds it: the bar's Join walks into the call that is on.
  const call = useCallBlock(lobbyName, { enabled: false, bind: { title, lobbyName, channel: lobbyName } });
  const host = useCallHost();
  const phase = host?.call.phase ?? 'idle';
  const joined = call.here && hasJoinedCall(host?.call.call, phase);
  const drawn = call.here && callDrawn(phase, true);

  // Leave returns to a line that offers to rejoin.
  const [left, setLeft] = useState(false);
  const wasJoined = useRef(false);
  useEffect(() => {
    if (joined) { wasJoined.current = true; setLeft(false); }
    else if (wasJoined.current) setLeft(true);
  }, [joined]);

  // The room is over (ended, or turned away mid-call): leave the call, then the ended page.
  const leave = host?.call.leave;
  useEffect(() => {
    if (!over) return;
    if (call.here) void leave?.();
    onEnded();
  }, [over, call.here, leave, onEnded]);

  // A technical round's pane is the pad, with the chat its second tab: Message switches to that tab and back.
  const technical = room.round.type === 'technical';
  const [chatOpen, setChatOpen] = useState(!technical);
  const callId = host?.call.call?.callId ?? null;
  const view = roomView({ token: 'ready', joined, left });

  return <Stack gap="none" className="h-screen min-h-0 w-full bg-surface" data-testid="join-room">
    <Inline gap="none" align="stretch" className="min-h-0 min-w-0 flex-1">
      {drawn
        ? <CallBlock placement="pane" className="h-full min-h-0 min-w-0 flex-1" />
        : <Stack gap="none" align="center" justify="center" className="min-h-0 min-w-0 flex-1">
          <EmptyState
            title={view === 'rejoin' ? 'You left the call' : 'Your interviewer has let you in'}
            body={view === 'rejoin' ? 'You can join again from the bar at the bottom of the window while the interview is on.'
              : 'Join the call from the bar at the bottom of the window. You will check your camera and microphone first.'}
            testId={view === 'rejoin' ? 'join-room-left' : 'join-room-idle'} />
        </Stack>}
      {joined && callId && technical && <GuestPadPane room={room} callId={callId} tab={chatOpen ? 'chat' : 'pad'} onTab={(t) => setChatOpen(t === 'chat')} />}
      {joined && chatOpen && callId && !technical && <GuestRoomChat callId={callId} self={room.self} onClose={() => setChatOpen(false)} />}
    </Inline>
    <Stack as="footer" gap="none" aria-label="Call" className="shrink-0 border-t border-border bg-surface" data-testid="join-room-footer">
      <CallMediaOutlet />
      <Inline gap="sm" align="center" justify="end" className="min-h-11 min-w-0 px-4 py-1">
        <GuestCallBar room={room} chatOpen={chatOpen} onToggleChat={() => setChatOpen((o) => !o)} />
      </Inline>
    </Stack>
  </Stack>;
}

/** The library's HuddleBar on the work-call model: Join before the call; microphone, camera, Message, Leave and the time left in it. */
function GuestCallBar({ room, chatOpen, onToggleChat }: { room: GuestRoom; chatOpen: boolean; onToggleChat(): void }) {
  const host = useCallHost();
  const now = useNow(15_000);
  const observedJoin = useRef<{ callId: string; at: number } | null>(null);
  const title = room.round.name;
  const className = 'shrink-0 grow basis-[14rem]';
  if (!host) return null;
  const call = host.call;
  const drawn = host.lobby?.lobbyName === room.lobbyName && callDrawn(call.phase, true);

  if (!drawn) {
    // The call is on with people in it: Join walks in. Otherwise Join opens it (the lead's join starts the interview).
    const inLive = call.phase === 'idle' ? (call.call?.participants ?? []).filter((p) => !p.isLocal && (p.state === 'in-call' || p.state === 'reconnecting')) : [];
    if (inLive.length > 0) return <HuddleBar name={title} showContext={false} phase="joinable"
      liveParticipants={inLive.map((p) => ({ id: p.userId, displayName: p.displayName, ...(p.avatarUrl ? { avatarUrl: p.avatarUrl } : {}) }))}
      participantCount={inLive.length} onJoin={() => { void call.rejoin(); }} joinLabel="Join the call"
      className={className} data-testid="join-room-bar" />;
    return <HuddleBar name={title} showContext={false} phase="idle" onStart={host.startBound ?? noop} startLabel="Join the call"
      {...(host.unavailableReason ? { startDisabledReason: host.unavailableReason } : !host.startBound ? { startDisabledReason: 'The call is still opening.' } : {})}
      className={className} data-testid="join-room-bar" />;
  }

  const joined = hasJoinedCall(call.call, call.phase);
  if (joined && call.call && observedJoin.current?.callId !== call.call.callId) observedJoin.current = { callId: call.call.callId, at: Date.now() };
  const startedAt = joined ? call.call?.startedAt ?? observedJoin.current?.at ?? null : null;
  const over = call.phase === 'ended' || call.phase === 'failed';
  const controls = conversationCallDockProps(call, { title, onOpenPeople: noop, onOpenSettings: noop, tile: () => undefined });
  const left = timeLeftLabel(roomStartMs(room.scheduledAt, room.startedAt ?? startedAt), room.round.minutes, now);
  const counts = callCounts(call.call);
  return <HuddleBar
    name={title}
    phase={BAR_PHASE[call.phase] ?? 'connecting'}
    startedAt={startedAt}
    participantCount={counts.joined}
    {...(controls && !over ? { mic: bareToggle(controls.mic), camera: bareToggle(controls.camera) } : {})}
    {...(joined ? { onToggleChat, chatOpen, chatLabel: 'Message' } : {})}
    {...(call.phase === 'failed' ? { statusLabel: 'Connection failed' } : {})}
    extras={<>
      {left && <T size="xs" weight="medium" tone={timeLeftTone(left)} className="whitespace-nowrap" data-testid="join-room-time-left">{left}</T>}
      {call.phase === 'failed' && <Button variant="secondary" size="sm" onClick={() => void call.rejoin()} data-testid="join-room-rejoin">Rejoin</Button>}
    </>}
    onLeave={() => { void call.leave(); }}
    leaveLabel={over ? 'Dismiss' : 'Leave'}
    className={className}
    data-testid="join-room-bar"
  />;
}
