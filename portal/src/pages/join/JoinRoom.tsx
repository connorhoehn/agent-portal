// The candidate's room (docs/interviews-tenant-plan.md row I2.4, the candidate's side; decision 21; contract D1).
//
// Once the lead has let the candidate in, the page reads its room (D1 `GET /api/interview-invite/room`) and the
// guest's realtime token itself, and joins the call of `room.lobbyName` in this window. The layout is the panel's
// without Milo's context: the call's tiles fill the window (the library's `CallBlock`, claimed as the call's grid,
// bound to the lobby as the panel's page binds it), the call chat is the one right pane, and the call's controls sit
// at the bottom in the library's `HuddleBar` (microphone, camera, Leave) with the time left beside them. No shell,
// no rails, no bell, no tenant chrome, no sharing, rooms, reactions, Milo, transcript, plan or questions. In a
// technical round the pane is the code pad with its runs, and the chat is the pane's second tab (GuestRoomPane).
//
// UI round 2 (lane GUEST): the panel's stage. The library's shell with the tenant's name (GuestFrame), the tiles
// (`CallBlock placement="pane"`) taking the window in a `SidePaneSplit`, and ONE far-right `SidePane` (GuestRoomPane:
// Pad then Chat in a technical round, Chat alone in a behavioural one, at U1's widths). The bar follows the panel's
// footer model on one line: the round's name, time left (counted from the start, never the set time), microphone,
// camera, the chat toggle (it opens the Chat tab), Leave. Two marked places are left for lane SPEAK (contract U9).
//
// The room is read every few seconds (bounded, stopped on unmount). `ended`, or a not-found (turned away mid-call,
// the link taken back), leaves the call and opens the ended page. Leave returns to a line offering to rejoin.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { conversationCallDockProps } from '@connorhoehn/realtime-modules/client/video';
import { SidePaneProvider, SidePaneSplit } from '@connorhoehn/ui-components';
import { Button, EmptyState, Inline, LoadingState, Stack, T } from '@connorhoehn/ui-components/shared';
import { HuddleBar, type HuddleBarMedia, type HuddleBarPhase } from '@connorhoehn/ui-components/video';
import { CallBlock, CallMediaOutlet, callCounts, callDrawn, useCallBlock, useCallHost } from '../../lib/conversationCall';
import { hasJoinedCall } from '../../components/shell/callShellModel';
import { callTimeLabel, guestRoomNameFor, timeLeftTone } from '../../lib/interviewsRoom';
import type { RealtimeToken } from '../../lib/realtimeToken';
import { GuestCallHost } from './GuestCallHost';
import { GuestShell, GuestStepFrame } from './GuestFrame';
import { GuestMiloRequests, GuestMiloVoice } from './GuestMiloVoice';
import { GuestRoomPane, type GuestPaneTab } from './GuestRoomPane';
import { useGuestMediaBinding } from './guestMedia.ts';
import { readRoom } from './guestApi.ts';
import { GuestRealtimeOff, guestTokenSource } from './guestRealtime.ts';
import { ROOM_POLL_MS, guestCallStartMs, roomMaxPolls, roomStepAfterRead, roomView, type GuestPanel, type GuestRoom } from './steps.ts';

export interface GuestInterview {
  opening: { title: string };
  round: { name: string; minutes: number };
  scheduledAt: string | null;
  /** Who the candidate meets: the lead's name and how many others (the read only; the exchange leaves it out). */
  panel?: GuestPanel;
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

  return <GuestCallHost token={token.token} tokens={guestTokenSource} self={room.self} panel={interview.panel ?? null} leadCallId={room.leadCallId ?? null}>
    <GuestRoomCall room={room} role={interview.opening.title} panel={interview.panel ?? null} over={over} onEnded={finish} />
  </GuestCallHost>;
}

/** The steps' frame, while the call cannot draw yet. */
function RoomFrame({ interview, children }: { interview: GuestInterview; children: ReactNode }) {
  return <GuestStepFrame title="Your interview" description={`${interview.opening.title} · ${interview.round.name}`} step="admitted" role={interview.opening.title}>
    <Stack gap="md" data-testid="join-room">{children}</Stack>
  </GuestStepFrame>;
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
function GuestRoomCall({ room, role, panel, over, onEnded }: { room: GuestRoom; role: string; panel: GuestPanel | null; over: boolean; onEnded(): void }) {
  const lobbyName = room.lobbyName;
  const title = room.round.name;
  // The interview's lobby, bound as the panel's page binds it: the bar's Join walks into the call that is on.
  const call = useCallBlock(lobbyName, { enabled: false, bind: { title, lobbyName, channel: lobbyName } });
  const host = useCallHost();
  const phase = host?.call.phase ?? 'idle';
  const joined = call.here && hasJoinedCall(host?.call.call, phase);
  // A call the candidate left reads as left ("You left the call", Join again), never as an ended call with Dismiss: the interview is still on.
  const drawn = call.here && callDrawn(phase, true) && phase !== 'ended';

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

  // The one pane: open by default; a technical round opens on the pad, a behavioural one is the chat alone. The
  // bar's chat toggle opens the pane on Chat, or (already there) closes it in a behavioural round and returns to
  // the pad in a technical one. × closes it.
  const technical = room.round.type === 'technical';
  const [paneOpen, setPaneOpen] = useState(true);
  const [tab, setTab] = useState<GuestPaneTab>(technical ? 'pad' : 'chat');
  const chatOpen = paneOpen && (!technical || tab === 'chat');
  const toggleChat = useCallback(() => {
    if (!chatOpen) { setPaneOpen(true); setTab('chat'); return; }
    if (technical) setTab('pad'); else setPaneOpen(false);
  }, [chatOpen, technical]);
  const callId = host?.call.call?.callId ?? null;
  // The candidate's own media id, so Milo and the transcript hear the candidate (bound server-side to this guest's session).
  useGuestMediaBinding(joined ? callId : null, room.self.userId, host?.call.call?.participants as Parameters<typeof useGuestMediaBinding>[2]);
  // The pad never depends on the call: a call that fails, or one not joined yet, keeps the pad (the chat waits for the call).
  const paneShown = paneOpen && (technical || (joined && callId !== null));
  const view = roomView({ token: 'ready', joined, left });
  // Milo's sentence to the candidate's last request: asked from the bar, shown on the line above it.
  const [miloLine, setMiloLine] = useState<string | null>(null);
  useEffect(() => { if (!joined) setMiloLine(null); }, [joined]);

  return <GuestShell bleed role={role}>
    <SidePaneProvider storageKey="join.room-pane" bounds={{ minSecondaryPx: 360, fitPrimaryPx: 480 }}>
      <Stack gap="none" className="h-full min-h-0 w-full bg-surface" data-testid="join-room">
        <SidePaneSplit paneTestId="join-room-pane-frame" dividerLabel="Resize the call and the pane" className="min-h-0 flex-1" data-testid="join-room-stage">
          {drawn
            ? <CallBlock placement="pane" fit="contain" className="h-full min-h-0 min-w-0 flex-1 justify-center bg-surface" />
            : <EmptyState
              title={view === 'rejoin' ? 'You left the call' : 'Your interviewer has let you in'}
              body={view === 'rejoin' ? 'You can join again from the bar at the bottom of the window while the interview is on.'
                : 'Join the call from the bar at the bottom of the window. You will check your camera and microphone first.'}
              testId={view === 'rejoin' ? 'join-room-left' : 'join-room-idle'} />}
        </SidePaneSplit>
        {paneShown && <GuestRoomPane room={room} callId={joined ? callId : null} tab={tab} onTab={setTab} onClose={() => setPaneOpen(false)} />}
        <GuestMiloVoice room={room} line={miloLine} />
        <Stack as="footer" gap="none" aria-label="Call" className="shrink-0 border-t border-border bg-surface" data-testid="join-room-footer">
          <CallMediaOutlet />
          <Inline gap="sm" align="center" justify="end" wrap={false} className="min-h-11 min-w-0 px-4 py-1">
            <GuestCallBar room={room} panel={panel} chatOpen={chatOpen} onToggleChat={toggleChat} onMiloLine={setMiloLine} />
          </Inline>
        </Stack>
      </Stack>
    </SidePaneProvider>
  </GuestShell>;
}

/** The library's HuddleBar on the work-call model: Join before the call; microphone, camera, Message, Leave and the time left in it. */
function GuestCallBar({ room, panel, chatOpen, onToggleChat, onMiloLine }: { room: GuestRoom; panel: GuestPanel | null; chatOpen: boolean; onToggleChat(): void; onMiloLine(line: string | null): void }) {
  const host = useCallHost();
  const now = useNow(15_000);
  const observedJoin = useRef<{ callId: string; at: number } | null>(null);
  const title = room.round.name;
  const className = 'shrink-0 grow basis-[14rem]';
  if (!host) return null;
  const call = host.call;
  const drawn = host.lobby?.lobbyName === room.lobbyName && callDrawn(call.phase, true) && call.phase !== 'ended';

  if (!drawn) {
    // The call is on with people in it: Join walks in. Otherwise Join opens it (the lead's join starts the interview).
    const inLive = call.phase === 'idle' || call.phase === 'ended' ? (call.call?.participants ?? []).filter((p) => !p.isLocal && (p.state === 'in-call' || p.state === 'reconnecting')) : [];
    if (inLive.length > 0) return <HuddleBar name={title} showContext={false} phase="joinable"
      // The roster names people as the tiles do (E4 #32): the lead by name, everyone else on the panel "Interviewer", no pictures.
      liveParticipants={inLive.map((p) => ({ id: p.userId, displayName: guestRoomNameFor(room.self.userId, panel, room.leadCallId)(p.userId)?.displayName ?? p.displayName }))}
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
  // Counted from the interview's start (the lead's join), else this page's join; never the set time.
  const left = joined ? callTimeLabel(guestCallStartMs(room.startedAt, typeof startedAt === 'number' ? startedAt : startedAt ? Date.parse(startedAt) : null), room.round.minutes, now) : null;
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
      <GuestMiloRequests room={room} onLine={onMiloLine} />
    </>}
    onLeave={() => { void call.leave(); }}
    leaveLabel={over ? 'Dismiss' : 'Leave'}
    className={className}
    data-testid="join-room-bar"
  />;
}
