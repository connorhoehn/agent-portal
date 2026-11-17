// The interview room, the panel's side (docs/interviews-tenant-plan.md row I2.4, decision 21; contract C5), at
// /interviews/rounds/:id/room. The room is a call that fills the window, built from the layouts that exist:
//
//   - the call: the shell's one call host (lib/conversationCall.tsx). The page binds the interview's lobby
//     (`interviews:interview:<id>`, C1) the way an initiative page binds its huddle (`useCallBlock(…, { bind })`),
//     so the footer's start, the pre-join device check, the tiles and the HuddleBar run it unchanged.
//   - the tiles: the library's `CallBlock`, claimed as the call's grid (`placement="pane"` draws the dock's
//     `grid` layout: tiles only, the host's bar owns mic, camera and Leave), taking the page's content area.
//   - the one right pane: the shell's right column (`SidePane` through `SidePaneProvider`), open by default.
//     Behavioural: Milo's context (the plan, the kit's competencies and anchors, Milo's notes). Technical: the
//     coding questions with their starter code, read-only, until the pad (row I4.2) replaces them. Under either, while
//     the interview is live (rows I3.6, I3.7; contract E5): Milo's notes for every seat (what was asked about per
//     competency, what is still to ask, the time check), the lead's private question to Milo with its quoted answer,
//     and the live transcript (folded in a technical round, where the coding questions lead). Nothing of it is in the
//     footer, and the candidate's room imports none of it.
//   - the footer: the work-call footer (SocialFooter) with the interview's own elements registered here
//     (components/shell/InterviewRoomFooter.tsx): time left, End interview, the waiting candidate.
//   - the rails: the shell's dialogue fold folds them while the pane is shown (useDialogueRailFold).
//
// The lead's join starts the interview (POST start); End interview ends it (POST end), leaves the call and goes
// to My interviews. Anyone without a seat reads the not-found page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { SidePane, useSidePaneHost } from '@connorhoehn/ui-components';
import { ChatComposer, CodeBlock, Disclosure, EmptyState, KeyValue, LoadingState, PageSection, Stack, T } from '@connorhoehn/ui-components/shared';
import { TranscriptPanel } from '@connorhoehn/ui-components/video';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { CallBlock, callDrawn, useCallBlock, useCallHost } from '../../lib/conversationCall';
import { hasJoinedCall } from '../../components/shell/callShellModel';
import { useRegisterInterviewRoomFooter, type InterviewRoomFooterState } from '../../components/shell/InterviewRoomFooter';
import { PAD_LANGUAGE_LABELS } from '../../lib/interviewsKit';
import {
  MY_INTERVIEWS_HREF, WAITING_POLL_MS, answerKnock, answerSuggestion, pausedLine, pollsSuggestion, readSuggestion, readsConsents,
  suggestionReadBudgetMs, type SuggestionAnswerId, type SuggestionView, codeBlockLanguage, consentOffLine, consentsPath, endInterview, pollsWaiting, readAdmission,
  roomCallTitle, roomPath, startInterview, startsOnJoin, type Admission, type ConsentPart, type RoomQuestion, type RoomView,
  MILO_NOTES_POLL_MS, MILO_QUESTION_MAX, TRANSCRIPT_POLL_MS, askMilo, askedByLabel, asksMilo, keepExchange, liveTranscriptSegments, mergeTranscript,
  pollsMilo, readLiveTranscript, readMiloNotes, transcriptOpenByDefault, type LiveTranscriptLine, type MiloExchange, type MiloNotes,
} from '../../lib/interviewsRoom';

const OPEN_STATES = new Set(['accepted', 'ready', 'live']);
/** The lead's room stops asking after an hour and a half of nobody knocking (bounded, like every poll here). */
const WAITING_MAX_READS = Math.ceil((90 * 60_000) / WAITING_POLL_MS);

export default function InterviewRoomPage() {
  const { id = '' } = useParams();
  return <InterviewRoom key={id} id={id} />;
}

function InterviewRoom({ id }: { id: string }) {
  const navigate = useNavigate();
  const { data, error, isLoading, refresh } = useFetch<{ room: RoomView }>(id ? roomPath(id) : null);
  const room = data?.room ?? null;
  useCrumbLabel(id, room ? roomCallTitle(room) : undefined);

  const open = !!room && OPEN_STATES.has(room.state);
  const lobbyName = open ? room.lobbyName : null;
  const title = room ? roomCallTitle(room) : '';
  // The interview's lobby, bound for the footer's start (the initiative pattern: no block drawn by the hook).
  const call = useCallBlock(lobbyName, { enabled: false, bind: lobbyName ? { title, lobbyName, channel: lobbyName } : null });
  const host = useCallHost();
  const phase = host?.call.phase ?? 'idle';
  const joined = call.here && hasJoinedCall(host?.call.call, phase);

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
  useEffect(() => {
    if (!polling) return;
    let live = true;
    let reads = 0;
    const read = () => {
      if (!live || reads++ >= WAITING_MAX_READS) { window.clearInterval(timer); return; }
      void readAdmission(id).then((a) => { if (live) setAdmission(a); });
    };
    const timer = window.setInterval(read, WAITING_POLL_MS);
    read();
    return () => { live = false; window.clearInterval(timer); };
  }, [polling, id]);

  // C4: one quiet line of what the candidate turned off; not found shows nothing.
  // Any seat reads it: the interviewer is told what is off (decision 5).
  const consents = useFetch<{ answered: boolean; off: ConsentPart[] }>(readsConsents(room?.seat ?? null, open) ? consentsPath(id) : null);
  const offLine = consents.error ? null : consentOffLine(consents.data?.off);

  // D7: Milo's suggestion, for the lead only, read on the server's wait while the interview is live and the lead is in the call.
  const [suggestion, setSuggestion] = useState<SuggestionView | null>(null);
  const [paused, setPaused] = useState<'budget' | null>(null);
  const asking = pollsSuggestion(room?.seat ?? null, room?.state ?? null, joined, suggestion);
  const roundMinutes = room?.round.minutes ?? 0;
  const suggestionDeadline = useRef<number | null>(null);
  useEffect(() => {
    if (!asking) return;
    suggestionDeadline.current ??= Date.now() + suggestionReadBudgetMs(roundMinutes);
    let live = true;
    let timer: number | undefined;
    const read = async () => {
      if (!live || Date.now() > (suggestionDeadline.current ?? 0)) return;
      const out = await readSuggestion(id);
      if (!live) return;
      setPaused(out.paused);
      if (out.suggestion) { setSuggestion(out.suggestion); return; }
      timer = window.setTimeout(() => { void read(); }, out.retryAfterMs);
    };
    void read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [asking, id, roundMinutes]);
  const answerAsk = useCallback(async (suggestionId: string, answer: SuggestionAnswerId): Promise<{ error?: string }> => {
    const out = await answerSuggestion(id, suggestionId, answer);
    if (!out.ok && !out.gone) return { error: out.error };
    setSuggestion((s) => (s?.id === suggestionId ? null : s));
    return {};
  }, [id]);

  const leave = host?.call.leave;
  const end = useCallback(async (): Promise<{ error?: string }> => {
    if (!room) return { error: 'The room is still loading.' };
    const out = await endInterview(room.id, room.revision);
    if (!out.ok) { if (out.stale) refresh(); return { error: out.error }; }
    if (call.here) void leave?.();
    navigate(MY_INTERVIEWS_HREF);
    return {};
  }, [room, refresh, call.here, leave, navigate]);
  const knock = useCallback(async (admit: boolean): Promise<{ error?: string }> => {
    const out = await answerKnock(id, admit);
    if (!out.ok) return { error: out.error };
    setAdmission((a) => (a ? { ...a, state: admit ? 'admitted' : 'turned-away' } : a));
    return {};
  }, [id]);
  const footer = useMemo<InterviewRoomFooterState | null>(() => (room && lobbyName ? {
    interviewId: room.id, lobbyName, lead: room.seat === 'lead', scheduledAt: room.scheduledAt, minutes: room.round.minutes,
    offLine, admission, end, answerKnock: knock,
    suggestion: room.seat === 'lead' && room.state === 'live' ? suggestion : null,
    pausedLine: room.state === 'live' ? pausedLine(room.seat, paused) : null,
    answerSuggestion: answerAsk,
  } : null), [room, lobbyName, offLine, admission, end, knock, suggestion, paused, answerAsk]);
  useRegisterInterviewRoomFooter(footer);

  if (error && !room) {
    return isNotFoundError(error) || /404|not found/i.test(error) ? (
      <RecordNotFound heading="Interview" title="Interview not found"
        body="There is no interview room here that you can open. You can open the rooms of the interviews you sit on."
        backLabel="My interviews" onBack={() => navigate(MY_INTERVIEWS_HREF)} />
    ) : (
      <UnavailableNotice error={error} what="this interview room" source="The room is read from the interviews tenant's rounds" onRetry={refresh} />
    );
  }
  if (!room) return <LoadingState label={isLoading ? 'Loading the interview room…' : 'Loading…'} />;

  const drawn = call.here && callDrawn(phase, true);
  return <Stack gap="none" className="h-full min-h-0 min-w-0 flex-1" data-testid="interview-room">
    {drawn
      ? <CallBlock placement="pane" className="h-full min-h-0 min-w-0 flex-1" />
      : <RoomIdle room={room} live={call.live} onBack={() => navigate(MY_INTERVIEWS_HREF)} />}
    <RoomPane room={room} />
  </Stack>;
}

/** Before the call (or after it): where the tiles will be, and what to do. */
function RoomIdle({ room, live, onBack }: { room: RoomView; live: boolean; onBack(): void }) {
  if (!OPEN_STATES.has(room.state)) {
    const over = room.state === 'ended' || room.state === 'scored' || room.state === 'reviewed';
    return <EmptyState title={over ? 'This interview has ended' : 'This interview is not ready for a call'}
      body={over ? 'Its call is closed. Your scorecard is on My interviews.' : 'The call opens once the lead has accepted the round.'}
      actionLabel="Open My interviews" onAction={onBack} testId="interview-room-closed" />;
  }
  const lead = room.seat === 'lead';
  return <EmptyState title={live ? 'The call is on' : lead ? 'The call has not started' : 'Waiting for the lead'}
    body={live ? 'Join it from the bar at the bottom of the window.'
      : lead ? 'Join the call from the bar at the bottom of the window. Joining starts the interview.'
        : 'You can join the call from the bar at the bottom of the window.'}
    testId="interview-room-idle" />;
}

/** The room's one right pane: Milo's context in a behavioural round, the coding questions in a technical one. */
function RoomPane({ room }: { room: RoomView }) {
  const pane = useSidePaneHost();
  const { reveal } = pane;
  // Open by default in the room; the reader's × still closes it for this visit.
  useEffect(() => { reveal(); }, [reveal]);
  const technical = room.round.type === 'technical';
  return <SidePane title={technical ? 'Coding questions' : 'Milo’s context'} subtitle={roomCallTitle(room)} paneId="interview-room"
    widthPx={{ min: 360, max: 460 }} data-testid="interview-room-pane">
    <Stack gap="lg" className="min-h-0 flex-1 overflow-y-auto p-4">
      {technical ? <CodingQuestions questions={room.questions} /> : <>
        <Plan questions={room.questions} />
        <Competencies room={room} />
      </>}
      <MiloForYou room={room} />
    </Stack>
  </SidePane>;
}

function Plan({ questions }: { questions: RoomQuestion[] }) {
  if (!questions.length) return <PageSection size="sm" title="The plan" empty="No questions were chosen for this round." />;
  return <PageSection size="sm" title="The plan" count={questions.length}>
    <Stack as="ol" gap="md" data-testid="interview-room-plan">
      {questions.map((q, n) => <Stack as="li" key={q.id} gap="xs">
        <T size="xs" weight="medium" tone="secondary">{`${n + 1}. ${q.competency ?? 'Competency'}`}</T>
        <T size="sm" wrap>{q.prompt}</T>
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

/** Technical round: each chosen question's prompt and starter code, read-only, to read aloud. Row I4.2's pad replaces this. */
function CodingQuestions({ questions }: { questions: RoomQuestion[] }) {
  if (!questions.length) return <PageSection size="sm" title="The plan" empty="No questions were chosen for this round." />;
  return <Stack gap="lg" data-testid="interview-room-coding">
    {questions.map((q, n) => <PageSection key={q.id} size="sm" title={`Question ${n + 1}`} description={q.competency ?? undefined}>
      <Stack gap="sm">
        <T size="sm" wrap>{q.prompt}</T>
        {q.starter.map((s) => <Stack key={s.language} gap="xs">
          <T size="xs" weight="medium" tone="secondary">{`Starter code · ${PAD_LANGUAGE_LABELS[s.language]}`}</T>
          <CodeBlock code={s.code} language={codeBlockLanguage(s.language)} copyButton ariaLabel={`Starter code in ${PAD_LANGUAGE_LABELS[s.language]}`} />
        </Stack>)}
        {q.followUps.length > 0 && <Disclosure summary={<T size="xs" tone="secondary">{`Follow-ups (${q.followUps.length})`}</T>} density="compact">
          <Stack as="ul" gap="xs">{q.followUps.map((f) => <T as="li" key={f} size="sm" wrap>{f}</T>)}</Stack>
        </Disclosure>}
      </Stack>
    </PageSection>)}
  </Stack>;
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

function MiloForYou({ room }: { room: RoomView }) {
  const { live, lines, off, notes } = useMiloPane(room);
  return <>
    <MiloNotesSection notes={live ? notes : null} />
    {asksMilo(room.seat, room.state) && <AskMilo interviewId={room.id} />}
    <TranscriptSection live={live} lines={lines} off={off} openByDefault={transcriptOpenByDefault(room.round.type)} />
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
