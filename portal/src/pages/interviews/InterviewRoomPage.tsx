// The interview room, the panel's side (docs/interviews-tenant-plan.md row I2.4, decision 21; contracts C5, U1, U5,
// U6), at /interviews/rounds/:id/room. The room is a call that fills the window, built from the layouts that exist:
//
//   - the call: the shell's one call host (lib/conversationCall.tsx). The page binds the interview's lobby
//     (`interviews:interview:<id>`, C1) the way an initiative page binds its huddle (`useCallBlock(…, { bind })`),
//     so the footer's start, the pre-join device check, the tiles and the HuddleBar run it unchanged.
//   - the tiles: the library's `CallBlock`, claimed as the call's grid (`placement="pane"` draws the dock's
//     `grid` layout: tiles only, the footer's bar owns mic, camera and Leave), taking all the page's space. It wins
//     the call's one media sink because nothing else on the page claims it: the room registers as the huddle
//     pane's owner (as pages/social/RoomPane.tsx does), so the shell's fallback chat pane, its media grid and its
//     composer dock never open here, the chat tab draws `HuddleChatBody showCall={false}`, and the footer's video
//     panel is kept shut while the call is this room's.
//   - the one right pane (U1): the shell's right column (`SidePane`) with the library's tabs. Technical: Pad,
//     Questions, Milo, Chat. Behavioural: Plan, Milo, Chat. Milo is Milo's notes, the lead's private question and
//     the live transcript (rows I3.6, I3.7). The footer's Message opens the Chat tab; it never opens a second pane.
//   - the chrome (U5): while the call is drawn the page folds the shell's trail, the primary rail and the content
//     gutter (components/shell/pageChrome.ts); the header and the footer stay. Before and after, an ordinary page.
//   - the footer: the work-call footer (SocialFooter) with the interview's own elements registered here
//     (components/shell/InterviewRoomFooter.tsx): time from the join, the consent chip, End interview, the
//     waiting candidate, Milo's suggestion.
//
// The lead's join starts the interview (POST start); End interview ends it (POST end), leaves the call and goes
// to the scorecard that is now due. Anyone without a seat reads the not-found page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SidePane, useSidePaneHost } from '@connorhoehn/ui-components';
import { Button, ChatComposer, Disclosure, EmptyState, Inline, KeyValue, LoadingState, PageHeader, PageSection, Stack, T } from '@connorhoehn/ui-components/shared';
import { TranscriptPanel } from '@connorhoehn/ui-components/video';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel, useCrumbTrail } from '../../lib/crumbLabels';
import { interviewsRoundHome } from '../../components/shell/breadcrumbResolve';
import { useSession } from '../../lib/auth';
import { CallBlock, callDrawn, useCallBlock, useCallHost, useCallMediaPanel } from '../../lib/conversationCall';
import { hasJoinedCall } from '../../components/shell/callShellModel';
import { HuddleChatBody, useHuddleChat } from '../../components/shell/HuddleChat';
import { usePageChromeFold } from '../../components/shell/pageChrome';
import { scorecardPath } from '../../lib/interviewsScorecard';
import { InterviewHintListener, type InterviewHint } from '../../lib/InterviewHintListener';
import { useRegisterInterviewRoomFooter, type InterviewRoomFooterState } from '../../components/shell/InterviewRoomFooter';
import { whenWithZone } from '../../lib/interviews';
import { PadTab } from './room/PadTab';
import { BoardTab } from './room/BoardTab';
import { flushBoardWithin, surfaceOf, type BoardCheckpoints } from '../../lib/interviewsBoard';
import { useInterviewCallLoss } from '../../lib/useInterviewCallLoss';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import {
  MY_INTERVIEWS_HREF, WAITING_POLL_MS, WAITING_FALLBACK_MS, answerKnock, answerSuggestion, pausedLine, pollsSuggestion, readSuggestion, readsConsents, pollsConsents,
  suggestionReadBudgetMs, startSuggestionPoll, type SuggestionAnswerId, type SuggestionPause, type SuggestionView, consentChip, consentsPath, endInterview, pollsWaiting, readAdmission,
  roomCallTitle, roomPath, startInterview, startsOnJoin, type Admission, type ConsentPart, type RoomQuestion, type RoomView,
  MILO_NOTES_POLL_MS, MILO_QUESTION_MAX, TRANSCRIPT_POLL_MS, askMilo, askedByLabel, asksMilo, keepExchange, liveTranscriptSegments, mergeTranscript,
  pollsMilo, readLiveTranscript, readMiloNotes, type LiveTranscriptLine, type MiloExchange, type MiloNotes,
  ROOM_MESSAGE_TAB, candidateLine, defaultRoomTab, panelLine, roomPaneWidth, roomTabOf, roomTabs, roundCrumbLabel, offForFact, type RoomTabId,
  queuePadQuestion, sayQuestion, type MiloAsked, type MiloAskWhy, type MiloSaid, miloInviteBlock,
  NO_SEAT_NOT_FOUND, callLossWords, miloLostLine,
} from '../../lib/interviewsRoom';

const OPEN_STATES = new Set(['accepted', 'ready', 'live']);
/** The lead's room stops asking after an hour and a half of nobody knocking (bounded, like every poll here). */
const WAITING_MAX_READS = Math.ceil((90 * 60_000) / WAITING_POLL_MS);
const WAITING_FALLBACK_MAX_READS = Math.ceil((90 * 60_000) / WAITING_FALLBACK_MS);

export default function InterviewRoomPage() {
  const { id = '' } = useParams();
  return <InterviewRoom key={id} id={id} />;
}

function InterviewRoom({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data, error, isLoading, refresh } = useFetch<{ room: RoomView }>(id ? roomPath(id) : null);
  const room = data?.room ?? null;
  // The trail's round crumb (U6): "Mateo Álvarez, System design".
  useCrumbLabel(id, room ? roundCrumbLabel(room) : undefined);
  // A round the viewer cannot read still hangs under their home (recruiter and admin: Hire › Candidates), not under "Upcoming › Round".
  const { session } = useSession();
  const unreadable = !room && !!error && (isNotFoundError(error) || /404|not found/i.test(error));
  useCrumbTrail(id, unreadable ? [...interviewsRoundHome(session?.role, true), { label: NO_SEAT_NOT_FOUND.title }] : null);

  const open = !!room && OPEN_STATES.has(room.state);
  const lobbyName = open ? room.lobbyName : null;
  const title = room ? roomCallTitle(room) : '';
  // The interview's lobby, bound for the footer's start (the initiative pattern: no block drawn by the hook).
  const call = useCallBlock(lobbyName, { enabled: false, bind: lobbyName ? { title, lobbyName, channel: lobbyName } : null });
  const host = useCallHost();
  const phase = host?.call.phase ?? 'idle';
  const joined = call.here && hasJoinedCall(host?.call.call, phase);
  // A call lost under the live interview (every socket dropped at once, say): the room leaves it and says so, and the lead restarts it.
  const lost = useInterviewCallLoss(room?.state === 'live' ? lobbyName : null);
  const drawn = !!room && call.here && callDrawn(phase, true) && !lost.loss;
  // Milo's record for the lost call: it left with the call, and the room says so (the bar is gone with the call).
  const lostMilo = useMeetingAssistant(lost.loss?.callId ?? null);
  // U5: while the call is drawn, the shell folds its trail, primary rail and gutter.
  usePageChromeFold(drawn);
  // The page's tiles are the call's one media sink: the footer's own video panel stays shut while the call is this room's.
  const media = useCallMediaPanel();
  useEffect(() => { if (call.here && media?.open) media.setOpen(false); }, [call.here, media?.open, media?.setOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // The lead's join starts it, once.
  const started = useRef(false);
  useEffect(() => {
    if (!room || !joined || started.current || !startsOnJoin(room)) return;
    started.current = true;
    void startInterview(room.id, room.revision).then(() => refresh());
  }, [room, joined, refresh]);

  // C3: the lead's room asks whether the candidate is waiting, every few seconds, until they are in.
  const [admission, setAdmission] = useState<Admission | null>(null);
  const polling = pollsWaiting(room?.seat ?? null, admission, room?.state ?? null);
  // A knock reaches the room as a live hint (InterviewHintListener below); this poll is only the slow fallback under it.
  const readNow = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!polling) { readNow.current = () => undefined; return; }
    let live = true;
    let reads = 0;
    const read = () => {
      if (!live || reads++ >= WAITING_FALLBACK_MAX_READS) { window.clearInterval(timer); return; }
      void readAdmission(id).then((a) => { if (live) setAdmission(a); });
    };
    const timer = window.setInterval(read, WAITING_FALLBACK_MS);
    readNow.current = () => { if (live) void readAdmission(id).then((a) => { if (live) setAdmission(a); }); };
    read();
    return () => { live = false; readNow.current = () => undefined; window.clearInterval(timer); };
  }, [polling, id]);
  const onHint = useCallback((hint: InterviewHint) => { if (hint.knock) readNow.current(); }, []);

  // C4: what the candidate answered, as one footer chip: "Not answered yet" until they have, then what is off.
  // Any seat reads it: the interviewer is told what is off (decision 5). A knock means the answers exist: read again.
  const consents = useFetch<{ answered: boolean; off: ConsentPart[] }>(readsConsents(room?.seat ?? null, open) ? consentsPath(id) : null);
  const refreshConsents = consents.refresh;
  useEffect(() => { if (admission && admission.state !== 'not-knocked') refreshConsents(); }, [admission?.state, refreshConsents]); // eslint-disable-line react-hooks/exhaustive-deps
  // Until the candidate has answered, read again every few seconds (bounded like the waiting poll), so Invite unblocks by itself.
  const consentsPolling = pollsConsents(room?.seat ?? null, open, consents.data);
  useEffect(() => {
    if (!consentsPolling) return;
    let reads = 0;
    const timer = window.setInterval(() => { if (reads++ >= WAITING_MAX_READS) { window.clearInterval(timer); return; } refreshConsents(); }, WAITING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [consentsPolling, refreshConsents]);
  const consent = consents.error ? null : consentChip(consents.data);
  const miloBlock = consents.error ? null : miloInviteBlock(consents.data);

  // D7: Milo's suggestion, for the lead only, read on the server's wait while the interview is live and the lead is in the call.
  const [suggestion, setSuggestion] = useState<SuggestionView | null>(null);
  const [paused, setPaused] = useState<SuggestionPause | null>(null);
  const asking = pollsSuggestion(room?.seat ?? null, room?.state ?? null, joined, suggestion);
  const roundMinutes = room?.round.minutes ?? 0;
  const suggestionDeadline = useRef<number | null>(null);
  useEffect(() => {
    if (!asking) return;
    suggestionDeadline.current ??= Date.now() + suggestionReadBudgetMs(roundMinutes);
    return startSuggestionPoll({
      read: () => readSuggestion(id),
      onRead: (out) => { setPaused(out.paused); if (out.suggestion) setSuggestion(out.suggestion); },
      now: Date.now, deadline: suggestionDeadline.current ?? 0,
      setTimer: (fn, ms) => window.setTimeout(fn, ms), clearTimer: (t) => window.clearTimeout(t as number | undefined),
    });
  }, [asking, id, roundMinutes]);
  const answerAsk = useCallback(async (suggestionId: string, answer: SuggestionAnswerId): Promise<{ error?: string; said?: MiloAsked; why?: MiloAskWhy }> => {
    const out = await answerSuggestion(id, suggestionId, answer);
    if (!out.ok && !out.gone) return { error: out.error };
    setSuggestion((s) => (s?.id === suggestionId ? null : s));
    return out.ok && out.said ? { said: out.said, ...(out.why ? { why: out.why } : {}) } : {};
  }, [id]);

  const leave = host?.call.leave;
  // The host value is a new object each render: read through a ref so the footer's registration does not change with it.
  const hostRef = useRef(host);
  hostRef.current = host;
  // The open board's checkpoints (the room pane's Board tab), flushed before the round ends.
  const boardCheckpoints = useRef<BoardCheckpoints | null>(null);
  const setBoardCheckpoints = useCallback((c: BoardCheckpoints | null) => { boardCheckpoints.current = c; }, []);
  const end = useCallback(async (): Promise<{ error?: string }> => {
    if (!room) return { error: 'The room is still loading.' };
    // The board's closing checkpoint first, while the round is still live (bounded; the server's grace covers a late one).
    await flushBoardWithin(boardCheckpoints.current);
    const out = await endInterview(room.id, room.revision);
    if (!out.ok) { if (out.stale) refresh(); return { error: out.error }; }
    // The page's own unbind is ignored while the call runs, so the lobby is dropped here once the call is left: the footer stops offering "Join the call" for a round that has ended.
    if (call.here) await leave?.();
    hostRef.current?.unbind(room.lobbyName);
    // The scorecard is what is due next: the lead lands on it, not on the desk.
    navigate(scorecardPath(room.id));
    return {};
  }, [room, refresh, call.here, leave, navigate]);
  const knock = useCallback(async (admit: boolean): Promise<{ error?: string }> => {
    const out = await answerKnock(id, admit);
    if (!out.ok) return { error: out.error };
    setAdmission((a) => (a ? { ...a, state: admit ? 'admitted' : 'turned-away' } : a));
    return {};
  }, [id]);
  const footer = useMemo<InterviewRoomFooterState | null>(() => (room && lobbyName ? {
    interviewId: room.id, lobbyName, lead: room.seat === 'lead', candidateName: room.candidate.name, minutes: room.round.minutes,
    consent, miloBlock, admission, end, answerKnock: knock,
    suggestion: room.seat === 'lead' && room.state === 'live' ? suggestion : null,
    pausedLine: room.state === 'live' ? pausedLine(room.seat, paused) : null,
    answerSuggestion: answerAsk,
  } : null), [room, lobbyName, consent?.label, consent?.tooltip, miloBlock?.label, admission, end, knock, suggestion, paused, answerAsk]); // eslint-disable-line react-hooks/exhaustive-deps
  useRegisterInterviewRoomFooter(footer);

  if (error && !room) {
    return isNotFoundError(error) || /404|not found/i.test(error) ? (
      <RecordNotFound heading="Interview" title={NO_SEAT_NOT_FOUND.title} body={NO_SEAT_NOT_FOUND.body}
        backLabel={NO_SEAT_NOT_FOUND.backLabel} onBack={() => navigate('/interviews')} />
    ) : (
      <UnavailableNotice error={error} what="this interview room" source="The room is read from the interviews tenant's rounds" onRetry={refresh} />
    );
  }
  if (!room) return <LoadingState label={isLoading ? 'Loading the interview room…' : 'Loading…'} />;

  return <Stack gap="none" className="h-full min-h-0 min-w-0 flex-1" data-testid="interview-room" data-room-live={drawn ? 'true' : 'false'}>
    {polling && <InterviewHintListener interviewId={id} onHint={onHint} />}
    {drawn
      // The recording note is drawn here, not by the library's pane (ShellCallMedia turns that one off): its banner ran edge to
      // edge with no gutter and the tile's centring left a gap under it. The note takes the tiles' gutter and the page's stack gap.
      ? <Stack gap="sm" className="h-full min-h-0 min-w-0 flex-1 bg-surface" data-testid="interview-room-stage">
        {host?.recordingNote && <Inline gap="none" className="px-3 pt-2" data-testid="interview-room-recording-note">{host.recordingNote}</Inline>}
        <CallBlock placement="pane" fit="contain" className={host?.recordingNote ? 'min-h-0 min-w-0 flex-1 [&_[data-testid=shell-call-media]]:flex-none' : 'min-h-0 min-w-0 flex-1 justify-center'} />
      </Stack>
      : <RoomIdle room={room} live={call.live} admission={admission} off={offForFact(consents.error ? null : consents.data?.off)} onBack={() => navigate(MY_INTERVIEWS_HREF)}
        lost={lost.loss ? callLossWords(room.seat === 'lead' ? 'lead' : 'panel') : null} onRestart={lost.restart}
        miloLine={lost.loss ? miloLostLine(lostMilo.view, room.seat) : null} />}
    <RoomPane room={room} here={call.here} onBoardCheckpoints={setBoardCheckpoints} />
  </Stack>;
}

/**
 * Before the call (or after it): who, when, how long, the panel and the candidate; the one action is the bar's Join. After a lost
 * call it says the call dropped instead, and the lead's one action is Restart the call (the bar's start, the same interview).
 */
function RoomIdle({ room, live, admission, off, onBack, lost = null, onRestart = null, miloLine = null }: {
  room: RoomView; live: boolean; admission: Admission | null; off: string | null; onBack(): void;
  lost?: ReturnType<typeof callLossWords> | null; onRestart?: (() => void) | null; miloLine?: string | null;
}) {
  if (!OPEN_STATES.has(room.state)) {
    const over = room.state === 'ended' || room.state === 'scored' || room.state === 'reviewed';
    return <EmptyState title={over ? 'This interview has ended' : 'This interview is not ready for a call'}
      body={over ? 'Its call is closed. Your scorecard is on My interviews.' : 'The call opens once the lead has accepted the round.'}
      actionLabel="Open My interviews" onAction={onBack} testId="interview-room-closed" />;
  }
  const lead = room.seat === 'lead';
  // Any seat reads whether the candidate is here (the panel waits with them for the lead).
  const waiting = candidateLine(admission, room.seat);
  const facts = [
    { label: 'Candidate', value: room.candidate.name },
    { label: 'Round', value: `${room.round.name} · ${room.round.type === 'technical' ? 'Technical' : 'Behavioural'}` },
    { label: 'When', value: whenWithZone(room.scheduledAt) },
    { label: 'Length', value: `${room.round.minutes} min` },
    { label: 'Panel', value: panelLine(room.seats) },
    ...(waiting ? [{ label: 'The candidate', value: waiting }] : []),
    ...(off ? [{ label: 'Off for this interview', value: off }] : []),
  ];
  // The page's one h1 (the shell's trail is only a breadcrumb), then who, when and how long.
  return (
    <Stack gap="md" className="min-h-0 flex-1 overflow-auto" data-testid="interview-room-idle">
      <PageHeader density="compact" title={lost ? lost.title : live ? 'The call is on' : room.state === 'live' ? 'The interview is live' : lead ? 'The call has not started' : 'Waiting for the lead'} />
      <Stack gap="md" className="px-[var(--ui-page-gutter)]">
        {lost ? <Stack gap="sm" align="start" data-testid="interview-room-call-lost">
          <T size="sm" tone="secondary" wrap>{lost.body}</T>
          {miloLine && <T size="sm" tone="secondary" wrap data-testid="interview-room-milo-left">{miloLine}</T>}
          {lost.action && onRestart && <Button variant="primary" size="sm" onClick={onRestart} data-testid="interview-room-restart-call">{lost.action}</Button>}
        </Stack>
        : <T size="sm" tone="secondary" wrap>{live ? 'Join it from the bar at the bottom of the window.'
          : room.state === 'live' ? 'The interview is live. Join the call from the bar at the bottom of the window.'
            : lead ? 'Join the call from the bar at the bottom of the window. Joining starts the interview.'
            : 'You can join the call from the bar at the bottom of the window.'}</T>}
        <KeyValue items={facts} labelWidth="w-28" aria-label="This round" />
      </Stack>
    </Stack>
  );
}

/**
 * The room's one right pane (U1), with the library's tabs. While the call is this room's, the room is the huddle
 * pane's owner (pages/social/RoomPane.tsx's pattern): the shell's own chat pane never opens beside it, and a focus
 * request for the call's chat (the footer's Message) selects the Chat tab and shows the pane.
 */
function RoomPane({ room, here, onBoardCheckpoints }: { room: RoomView; here: boolean; onBoardCheckpoints: (c: BoardCheckpoints | null) => void }) {
  const pane = useSidePaneHost();
  const { reveal } = pane;
  // Open by default in the room; the reader's × still closes it for this visit.
  useEffect(() => { reveal(); }, [reveal]);
  const type = room.round.type;
  const [tab, setTab] = useState<RoomTabId>(() => defaultRoomTab(type));
  const chat = useHuddleChat();
  const registerPane = chat?.registerPaneOwner;
  const chatVisible = pane.shown && !pane.folded && tab === ROOM_MESSAGE_TAB;
  const hideChat = useCallback(() => setTab(defaultRoomTab(type)), [type]);
  useEffect(() => (here ? registerPane?.({ visible: chatVisible, hide: hideChat }) : undefined), [here, registerPane, chatVisible, hideChat]);
  const lastFocus = useRef(chat?.focusRequest ?? 0);
  useEffect(() => {
    if (here && chat && chat.focusRequest !== lastFocus.current) { setTab(ROOM_MESSAGE_TAB); reveal(); }
    lastFocus.current = chat?.focusRequest ?? 0;
  }, [here, chat?.focusRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const milo = useMiloPane(room);
  const surface = surfaceOf(room.round);
  const tabs = useMemo(() => roomTabs(type, surface), [type, surface]);
  return <SidePane title={roomCallTitle(room)} subtitle={`${room.round.minutes} min · ${type === 'technical' ? 'Technical' : 'Behavioural'} round`}
    paneId="interview-room" widthPx={roomPaneWidth(type)} tabs={tabs} value={tab} onValueChange={(id) => setTab((t) => roomTabOf(type, id, t))}
    data-testid="interview-room-pane">
    {tab === 'chat'
      ? <Stack gap="none" className="min-h-0 flex-1" data-testid="interview-room-chat">
        {chat?.callId && here ? <HuddleChatBody showCall={false} />
          : <EmptyState title="The call’s chat" body="Messages to the panel and the candidate show here once you join the call." testId="interview-room-chat-idle" />}
      </Stack>
      : <Stack gap="lg" className="min-h-0 flex-1 overflow-y-auto p-4" data-testid={`interview-room-tab-${tab}`}>
        {tab === 'pad' && (surface === 'board' ? <BoardTab room={room} onCheckpoints={onBoardCheckpoints} /> : <PadTab room={room} />)}
        {tab === 'questions' && <Questions questions={room.questions} interviewId={room.id} asks={room.seat === 'lead' && room.state === 'live'}
          onAsked={type === 'technical' ? (q, said) => { queuePadQuestion(room.id, q); if (said === 'spoken') setTab('pad'); } : undefined} />}
        {tab === 'plan' && <><Questions questions={room.questions} title="The plan" interviewId={room.id} asks={room.seat === 'lead' && room.state === 'live'} /><Competencies room={room} /></>}
        {tab === 'milo' && <MiloForYou room={room} {...milo} />}
      </Stack>}
  </SidePane>;
}

/**
 * The chosen questions with their follow-ups: a technical round's Questions tab, a behavioural round's plan. For the lead while the
 * interview is live (`asks`), each has "Have Milo ask" (row I3.5, decision 11): the server reads the question from the kit, posts it
 * in the call chat and Milo says it aloud; in a technical round `onAsked` also puts it in the pad (the Pad tab opens on it when Milo
 * said it aloud; otherwise the lead stays here to read why, and the pad takes it when it is next open). The result is one plain line.
 */
function Questions({ questions, title = 'Questions', interviewId, asks = false, onAsked }: {
  questions: RoomQuestion[]; title?: string; interviewId?: string; asks?: boolean; onAsked?: (q: RoomQuestion, said: MiloSaid) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; line: string; said: MiloSaid | null } | null>(null);
  const ask = async (q: RoomQuestion) => {
    if (!interviewId || busy) return;
    setBusy(q.id);
    const out = await sayQuestion(interviewId, q.id);
    setBusy(null);
    if (!out.ok) { setResult({ id: q.id, line: out.error, said: null }); return; }
    setResult({ id: q.id, line: out.line, said: out.said });
    onAsked?.(q, out.said);
  };
  if (!questions.length) return <PageSection size="sm" title={title} empty="No questions were chosen for this round." />;
  return <PageSection size="sm" title={title} count={questions.length}>
    <Stack as="ol" gap="md" data-testid="interview-room-plan">
      {questions.map((q, n) => <Stack as="li" key={q.id} gap="xs">
        <Inline gap="sm" align="center" justify="between" wrap={false}>
          <T size="xs" weight="medium" tone="secondary" truncate>{`${n + 1}. ${q.competency ?? 'Competency'}`}</T>
          {asks && <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => void ask(q)} data-testid="interview-room-milo-ask">Have Milo ask</Button>}
        </Inline>
        <T size="sm" wrap>{q.prompt}</T>
        {result?.id === q.id && <T size="xs" tone={result.said === 'spoken' ? 'secondary' : 'warning'} wrap role="status" data-testid="interview-room-milo-said" data-said={result.said ?? 'error'}>{result.line}</T>}
        {q.followUps.length > 0 && <Disclosure summary={<T size="xs" tone="secondary">{`Follow-ups (${q.followUps.length})`}</T>} density="compact">
          <Stack as="ul" gap="xs">{q.followUps.map((f) => <T as="li" key={f} size="sm" wrap>{f}</T>)}</Stack>
        </Disclosure>}
      </Stack>)}
    </Stack>
  </PageSection>;
}

function Competencies({ room }: { room: RoomView }) {
  if (!room.competencies.length) return <PageSection size="sm" title="Competencies" empty="This opening's kit has no competencies." />;
  return <PageSection size="sm" title="Competencies" count={room.competencies.length}>
    <Stack gap="sm" data-testid="interview-room-competencies">
      {room.competencies.map((k) => <Disclosure key={k.id} density="compact" summary={<T size="sm" weight="medium">{k.name}</T>}>
        <Stack gap="xs">
          <T size="sm" tone="secondary" wrap>{k.lookFor}</T>
          <KeyValue layout="stack" items={([4, 3, 2, 1] as const).map((r) => ({ label: `Rated ${r}`, value: k.anchors[r] }))} />
        </Stack>
      </Disclosure>)}
    </Stack>
  </PageSection>;
}

// ── Milo for you and the live transcript (rows I3.6, I3.7; contract E5) ─────────────────────────────────────────

/** Consecutive empty reads (not found, or failing) after which a poll stops: the interview has ended or the route is gone. */
const MILO_MISSES = 3;
/** Each poll stops after the round's length plus half an hour (bounded, like the footer's suggestion). */
const miloReads = (minutes: number, everyMs: number): number => Math.ceil(((Math.max(0, minutes) + 30) * 60_000) / everyMs);

/** The transcript and the notes, read while the interview is live; stopped when it ends, when reads keep failing, or on unmount. */
function useMiloPane(room: RoomView) {
  const live = pollsMilo(room.seat, room.state);
  const [lines, setLines] = useState<LiveTranscriptLine[]>([]);
  const [off, setOff] = useState<string | null>(null);
  const [notes, setNotes] = useState<MiloNotes | null>(null);
  const minutes = room.round.minutes;
  useEffect(() => {
    if (!live) return;
    let on = true;
    let after = 0;
    let reads = 0;
    let misses = 0;
    let timer: number | undefined;
    const max = miloReads(minutes, TRANSCRIPT_POLL_MS);
    const read = async () => {
      if (!on || reads++ >= max || misses >= MILO_MISSES) return;
      const t = await readLiveTranscript(room.id, after);
      if (!on) return;
      if (t) {
        misses = 0;
        setOff(t.state === 'off' ? t.off : null);
        if (t.lines.length) setLines((held) => mergeTranscript(held, t.lines));
        after = Math.max(after, t.lastSeq);
      } else misses++;
      timer = window.setTimeout(() => { void read(); }, TRANSCRIPT_POLL_MS);
    };
    void read();
    return () => { on = false; window.clearTimeout(timer); };
  }, [live, room.id, minutes]);
  useEffect(() => {
    if (!live) return;
    let on = true;
    let reads = 0;
    let misses = 0;
    let timer: number | undefined;
    const max = miloReads(minutes, MILO_NOTES_POLL_MS);
    const read = async () => {
      if (!on || reads++ >= max || misses >= MILO_MISSES) return;
      const n = await readMiloNotes(room.id);
      if (!on) return;
      if (n) { misses = 0; setNotes(n); } else misses++;
      timer = window.setTimeout(() => { void read(); }, MILO_NOTES_POLL_MS);
    };
    void read();
    return () => { on = false; window.clearTimeout(timer); };
  }, [live, room.id, minutes]);
  return { live, lines, off, notes };
}

/** The Milo tab: the notes, the lead's private question, the live transcript (open: it has the tab to itself). */
function MiloForYou({ room, live, lines, off, notes }: { room: RoomView } & ReturnType<typeof useMiloPane>) {
  return <>
    <MiloNotesSection notes={live ? notes : null} />
    {asksMilo(room.seat, room.state) && <AskMilo interviewId={room.id} />}
    <TranscriptSection live={live} lines={lines} off={off} openByDefault />
  </>;
}

/** What has been asked about per competency, what is still to ask, and the time check: never how the candidate did. */
function MiloNotesSection({ notes }: { notes: MiloNotes | null }) {
  if (!notes) return <PageSection size="sm" title="Milo’s notes" empty="Milo’s notes for the panel show here during the call." />;
  return <PageSection size="sm" title="Milo’s notes" description={notes.time.line}>
    <Stack gap="md" data-testid="interview-room-milo-notes">
      {notes.competencies.map((c) => <Stack key={c.id} gap="xs" data-testid="interview-room-milo-competency">
        <T size="xs" weight="medium" tone="secondary">{c.name}</T>
        {c.asked.length === 0 && c.toAsk.length === 0 && <T size="sm" tone="tertiary">Nothing chosen or asked yet.</T>}
        {c.asked.length > 0 && <Stack as="ul" gap="xs">
          {c.asked.map((a) => <T as="li" key={a.text} size="sm" wrap>{askedByLabel(a.by) ? `${a.text} (${askedByLabel(a.by)})` : a.text}</T>)}
        </Stack>}
        {c.toAsk.length > 0 && <Stack gap="xs">
          <T size="xs" tone="tertiary">Still to ask</T>
          <Stack as="ul" gap="xs">{c.toAsk.map((q) => <T as="li" key={q.questionId} size="sm" tone="secondary" wrap>{q.text}</T>)}</Stack>
        </Stack>}
      </Stack>)}
    </Stack>
  </PageSection>;
}

/** The lead's private question: only the lead sees it; Milo answers from the transcript with quoted lines. */
function AskMilo({ interviewId }: { interviewId: string }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState<MiloExchange[]>([]);
  const asked = useRef(0);
  const send = useCallback(async () => {
    const question = value.replace(/\s+/g, ' ').trim();
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    const out = await askMilo(interviewId, question.slice(0, MILO_QUESTION_MAX));
    setBusy(false);
    if (!out.ok) { setError(out.error); return; }
    setValue('');
    setKept((k) => keepExchange(k, question, out.body, `ask-${++asked.current}`));
  }, [value, busy, interviewId]);
  const [latest, ...earlier] = kept;
  return <PageSection size="sm" title="Ask Milo" description="Only you see this. Milo finds what was said, and where; it does not judge the candidate.">
    <Stack gap="sm" data-testid="interview-room-milo-ask">
      <ChatComposer value={value} onChange={(v) => setValue(v.slice(0, MILO_QUESTION_MAX))} onSubmit={() => { void send(); }} disabled={busy}
        placeholder="Where did they talk about testing?" submitLabel="Ask" aria-label="Your question for Milo" />
      {busy && <T size="xs" tone="tertiary">Milo is looking…</T>}
      {error && <T size="xs" tone="danger" role="alert" wrap>{error}</T>}
      {latest && <MiloExchangeView exchange={latest} />}
      {earlier.length > 0 && <Disclosure density="compact" summary={<T size="xs" tone="secondary">{`Earlier questions (${earlier.length})`}</T>}>
        <Stack gap="md">{earlier.map((x) => <MiloExchangeView key={x.key} exchange={x} />)}</Stack>
      </Disclosure>}
    </Stack>
  </PageSection>;
}

function MiloExchangeView({ exchange }: { exchange: MiloExchange }) {
  return <Stack gap="xs" data-testid="interview-room-milo-answer">
    <T size="xs" tone="tertiary" wrap>{exchange.question}</T>
    {exchange.answer ? <>
      <T size="sm" wrap>{exchange.answer.text}</T>
      {exchange.answer.sources.length > 0 && <Stack as="ul" gap="xs">
        {exchange.answer.sources.map((s) => <T as="li" key={s.seq} size="xs" tone="secondary" wrap>{`Line ${s.seq}${s.speaker ? `, ${s.speaker}` : ''}: “${s.quote}”`}</T>)}
      </Stack>}
    </> : <T size="sm" tone="secondary" wrap>{exchange.line ?? ''}</T>}
  </Stack>;
}

/** The call's transcript as it is said, for every seat; folded in a technical round. */
function TranscriptSection({ live, lines, off, openByDefault }: { live: boolean; lines: LiveTranscriptLine[]; off: string | null; openByDefault: boolean }) {
  const segments = useMemo(() => liveTranscriptSegments(lines), [lines]);
  if (!live) return <PageSection size="sm" title="Transcript" empty="The transcript shows here during the call." />;
  if (off && !lines.length) return <PageSection size="sm" title="Transcript" empty={off} />;
  return <Disclosure density="compact" defaultOpen={openByDefault} summary={<T size="sm" weight="medium">Transcript</T>}>
    <TranscriptPanel status="ready" follow title="Live transcript" segments={segments} emptyMessage="Nothing has been said yet."
      data-testid="interview-room-transcript" />
  </Disclosure>;
}
