// /interviews/rounds/:id/record — the interview record (docs/interviews-tenant-plan.md row I5.1, decision 4; contract
// E2): the recording, the transcript and the moments a question was asked, for the panel side of a finished interview.
//
// The server decides who reads it (its lead, its panel, a recruiter, the opening's hiring manager; nobody else, and only
// once the interview has ended); anyone else gets the tenant's not-found. The recording plays in the library's
// RecordingPlayer when platform-api has media for the viewer (it asks the middleware every time); otherwise one plain
// line says why there is nothing to play. The transcript is the library's TranscriptPanel, time-aligned to the player
// when it plays; the markers move the transcript (and the player) to that moment. No download, no share, no copy-all.
//
// One clock (row I5.1): in a technical round the code the pad held plays back beside the recording (the library's
// CodePlayback, frames from the pad log's snapshots, markers for questions, runs and pastes) and a chosen run shows
// its output under the code. The page's time is the interview's own (ms from its start); a real recording is on the
// player's clock, `shift` apart, and the player's ref handle does the seeking. With no recording (declined, or none in
// the mock world) the page keeps the time itself, so the code, the words and the markers still move together.
import { Button, Chip, DetailPage, DetailSection, Inline, LoadingState, MetaLine, Stack, T } from '@connorhoehn/ui-components/shared';
import { CodePlayback, CodeRunOutput } from '@connorhoehn/ui-components/code-pad';
import { SplitPane } from '@connorhoehn/ui-components/shared';
import { RecordingPlayer, TranscriptPanel, type RecordingPlayerHandle } from '@connorhoehn/ui-components/video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { BoardSnapshots } from './board/BoardSnapshots';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { ROUND_TYPE_LABELS, roundStatus, whenLabel } from '../../lib/interviews';
import {
  MARKER_LABELS, atFromSearch, nextMediaAsk, clockOf, codeEmptyLine, lengthOf, loadInterviewMedia, markerTime, offsetMs, recordApi, recordingLine, segmentsOf,
  transcriptLine,
  type InterviewMedia, type InterviewRecordView,
} from '../../lib/interviewsRecord';
import { runOutputModel, type RunView } from '../../lib/interviewsPad';
import { NO_SEAT_NOT_FOUND, roomHref, roomPath } from '../../lib/interviewsRoom';
import { framesOf, markersOf, mergeCloseMarkers, revealMoments, padLogUrl, playbackDurationMs, readWholePadLog, runAtTime, type PadLogEvent, type PlaybackMarker } from '../../lib/interviewsPlayback';

type Trail = ReturnType<typeof useFlushTrailItems>;

export default function InterviewRecordPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const trail = useFlushTrailItems();
  const { data, error, failure, refresh } = useFetch<{ record: InterviewRecordView }>(id ? recordApi(id) : null);
  const record = data?.record ?? null;
  useCrumbLabel(id, record ? `${record.interview.candidate.name}, ${record.interview.round.name}` : null);
  if (failure?.status === 404) {
    return <RecordMissing id={id} onHome={() => navigate('/interviews')} onRoom={() => navigate(roomHref(id))} />;
  }
  if (error && !record) return <UnavailableNotice error={error} what="this interview" source="Interviews are read from the interviews tenant" onRetry={refresh} />;
  if (!record) return <DetailPage title="Interview" breadcrumbs={trail}><LoadingState label="Opening the interview…" /></DetailPage>;
  return <RecordWorkspace key={record.interview.id} record={record} trail={trail} />;
}

/** No record at this address: the viewer's own round that has not ended yet (it opens when it does), or nothing they may open. */
function RecordMissing({ id, onHome, onRoom }: { id: string; onHome(): void; onRoom(): void }) {
  const { data } = useFetch<{ room: { state: string } }>(roomPath(id));
  const state = data?.room?.state;
  if (state === 'accepted' || state === 'ready' || state === 'live') {
    return <RecordNotFound heading="Interview" title="The record opens when the interview ends" body="Nothing has been recorded to show yet."
      backLabel="Open the room" onBack={onRoom} />;
  }
  return <RecordNotFound heading="Interview" title={NO_SEAT_NOT_FOUND.title} body={NO_SEAT_NOT_FOUND.body} backLabel={NO_SEAT_NOT_FOUND.backLabel} onBack={onHome} />;
}

/** Media from platform-api, asked only when the server says a real recording may be there; asked again every few seconds
 *  while its video is still being saved (as a huddle's recording page does) up to a cap, and while a `none` may only mean
 *  the interview ended a moment ago (nextMediaAsk). Past the cap it is `stalled`, and `retry` asks afresh. */
function useInterviewMedia(record: InterviewRecordView): { media: InterviewMedia | null; stalled: boolean; retry: () => void } {
  const ask = record.recording.state === 'available' && !record.recording.standIn;
  const endedAt = record.interview.endedAt;
  const [media, setMedia] = useState<InterviewMedia | null>(null);
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!ask) return undefined;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const firstAt = Date.now();
    setStalled(false);
    const load = (): void => {
      void loadInterviewMedia(record.interview.id, ctl.signal).then((m) => {
        if (ctl.signal.aborted) return;
        setMedia(m);
        const now = Date.now();
        const wait = nextMediaAsk(m.state, now - firstAt, endedAt ? now - Date.parse(endedAt) : null);
        if (wait !== null) timer = setTimeout(load, wait);
        else if (m.state === 'saving') setStalled(true);
      });
    };
    load();
    return () => { ctl.abort(); if (timer) clearTimeout(timer); };
  }, [ask, record.interview.id, endedAt, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { media: ask ? media : null, stalled: ask && stalled, retry };
}

/** The pad log, read to its end; null while it loads or when the panel's read does not answer. */
function usePadLog(interviewId: string, technical: boolean): { events: PadLogEvent[] | null; done: boolean } {
  const [state, setState] = useState<{ events: PadLogEvent[] | null; done: boolean }>({ events: null, done: !technical });
  useEffect(() => {
    if (!technical) return undefined;
    const ctl = new AbortController();
    void readWholePadLog(async (after) => {
      try {
        const res = await fetch(padLogUrl(interviewId, after), { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl.signal });
        return res.ok ? await res.json() : null;
      } catch { return null; }
    }).then((events) => { if (!ctl.signal.aborted) setState({ events, done: true }); });
    return () => ctl.abort();
  }, [interviewId, technical]);
  return state;
}

function RecordWorkspace({ record, trail }: { record: InterviewRecordView; trail: Trail }) {
  const { interview, recording, transcript, markers } = record;
  // A system design round worked on the whiteboard: its checkpoints stand where the code would be.
  const board = interview.round.type === 'technical' && interview.round.surface === 'board';
  const technical = interview.round.type === 'technical' && !board;
  const { media, stalled: mediaStalled, retry: retryMedia } = useInterviewMedia(record);
  const playing = media?.state === 'playable' && media.url ? media.url : null;
  // The record counts from the interview's start; a real recording from its own. `shift` is how far the recording's clock is ahead.
  const shift = playing ? offsetMs(interview.startedAt, media!.startedAt) : 0;
  const endMs = recording.durationSeconds ? recording.durationSeconds * 1000 : null;
  const segments = useMemo(() => segmentsOf(transcript.lines, 0, endMs), [transcript.lines, endMs]);
  const player = useRef<RecordingPlayerHandle>(null);
  // The page's one time, ms from the interview's start. The player (when there is one) sets it as it plays.
  // A recap source links here with `?at=<seconds>` (from the interview's start): code, transcript and clock open at that time.
  const [search] = useSearchParams();
  const atMs = atFromSearch(search.get('at'));
  const [timeMs, setTimeMs] = useState(atMs ?? 0);
  const moveTo = useCallback((ms: number) => {
    setTimeMs(ms);
    player.current?.seek(Math.max(0, ms + shift) / 1000);
  }, [shift]);
  useEffect(() => { if (atMs !== null) moveTo(atMs); }, [atMs, moveTo]);

  // A board round reads the log too: the lead's reveal of the provided design is in it.
  const padLog = usePadLog(interview.id, technical || board);
  const reveals = useMemo(() => (board ? revealMoments(padLog.events ?? [], interview.startedAt) : []), [board, padLog.events, interview.startedAt]);
  const runs: RunView[] = record.runs ?? [];
  const frames = useMemo(() => framesOf(padLog.events ?? [], interview.startedAt), [padLog.events, interview.startedAt]);
  // The length comes from the unmerged moments; the markers drawn merge the ones that would sit on each other.
  const momentList = useMemo(() => markersOf({
    events: padLog.events ?? [], startedAt: interview.startedAt, recordMarkers: markers, runs, questions: record.questions ?? [],
  }), [padLog.events, interview.startedAt, markers, runs, record.questions]);
  const durationMs = useMemo(() => playbackDurationMs(record, Math.max(0, ...frames.map((f) => f.atMs), ...momentList.map((m) => m.atMs), ...transcript.lines.map((l) => l.atMs))),
    [record, frames, momentList, transcript.lines]);
  const playbackMarkers: PlaybackMarker[] = useMemo(() => mergeCloseMarkers(momentList, durationMs), [momentList, durationMs]);
  const run = runAtTime(runs, interview.startedAt, timeMs);
  const runModel = useMemo(() => (run ? runOutputModel({ runId: run.runId, view: run, events: {}, seen: 0 }) : null), [run]);

  const status = roundStatus(interview.state);
  const lengthSeconds = recording.durationSeconds
    ?? (interview.startedAt && interview.endedAt ? Math.max(0, (Date.parse(interview.endedAt) - Date.parse(interview.startedAt)) / 1000) : null);
  const recordingNote = recordingLine(recording, mediaStalled ? 'stalled' : media?.state ?? null);
  // A stand-in recording (the demo workspace keeps no video) is one meta line, not a section, so the code and the transcript start higher.
  const standIn = recording.state === 'available' && recording.standIn;
  const transcriptNote = transcriptLine(transcript.state);

  const recordingPart = playing ? (
    <RecordingPlayer key={playing} ref={player} playlistUrl={playing} hideDownload className="aspect-video w-full"
      onTimeUpdate={(seconds) => setTimeMs(Math.max(0, seconds * 1000 - shift))} />
  ) : recording.state === 'available' && !recording.standIn && !media ? (
    <LoadingState label="Looking for the recording…" />
  ) : mediaStalled ? (
    <Inline gap="sm" align="center" wrap>
      <T size="sm" tone="secondary" wrap data-testid="interviews-record-recording-line">{recordingNote}</T>
      <Button size="sm" variant="secondary" onClick={retryMedia} data-testid="interviews-record-recording-retry">Check again</Button>
    </Inline>
  ) : (
    <T size="sm" tone="secondary" wrap data-testid="interviews-record-recording-line">{recordingNote}</T>
  );

  const outputBlock = runs.length > 0 ? (
    <CodeRunOutput variant="flush" className="h-full min-h-0" data-testid="interviews-record-run-output"
      status={runModel?.status ?? null} stdout={runModel?.stdout ?? ''} stderr={runModel?.stderr ?? ''} compileOutput={runModel?.compileOutput ?? ''}
      truncated={runModel?.truncated ?? { stdout: false, stderr: false }} exitCode={runModel?.exitCode ?? null} timeMs={runModel?.timeMs ?? null}
      peakMemoryMb={runModel?.peakMemoryMb ?? null} {...(runModel?.runBy ? { runBy: runModel.runBy } : {})}
      {...(runModel?.languageLabel ? { languageLabel: runModel.languageLabel } : {})} {...(runModel?.runtimeVersion ? { runtimeVersion: runModel.runtimeVersion } : {})}
      emptyMessage="Nothing had been run yet at this moment." />
  ) : null;
  const playback = (
    <CodePlayback frames={frames} markers={playbackMarkers} durationMs={durationMs} timeMs={Math.min(timeMs, durationMs)} onTimeChange={moveTo}
      emptyMessage={codeEmptyLine(record)} className="h-full min-h-0 min-w-0" data-testid="interviews-record-code-playback" />
  );
  const code = !technical ? null : !padLog.done ? <LoadingState label="Opening the code…" /> : (
    <SplitPane orientation="vertical" className="h-full min-h-0" defaultRatio={0.62} minPrimaryPx={200} minSecondaryPx={120} dividerLabel="Resize the code and the run's output"
      primary={playback} secondary={outputBlock} data-testid="interviews-record-code" />
  );

  const words = transcriptNote ? (
    <DetailSection variant="heading" as="h2" first title="Transcript"><T size="sm" tone="secondary" wrap data-testid="interviews-record-transcript-line">{transcriptNote}</T></DetailSection>
  ) : (
    <TranscriptPanel status="ready" segments={segments} headerMeta={<T size="xs" tone="tertiary">{segments.length === 1 ? '1 line' : `${segments.length} lines`}</T>} currentTimeMs={timeMs} onSeek={moveTo}
      emptyMessage="Nothing was transcribed in this interview." data-testid="interviews-record-transcript-panel" />
  );

  const moments = (
    <DetailSection variant="heading" as="h2" title="Moments" hint="When a question was asked. Choosing one moves the transcript there." data-testid="interviews-record-markers">
      {markers.length || reveals.length ? (
        <Stack gap="xs">
          {reveals.map((r) => (
            <Button key={`reveal:${r.questionId}`} size="sm" variant="ghost" fullWidth className="justify-start text-left"
              onClick={() => moveTo(markerTime(r))} data-testid="interviews-record-reveal">
              <Inline gap="sm" align="center" wrap={false} className="min-w-0">
                <T size="xs" tone="tertiary" tabular>{clockOf(markerTime(r))}</T>
                <Chip size="sm" tone="warning">Revealed</Chip>
                <T size="sm" truncate title={`${r.label}, by ${r.by}`}>{r.label}</T>
              </Inline>
            </Button>
          ))}
          {markers.map((m) => (
            <Button key={`${m.kind}:${m.atMs}`} size="sm" variant="ghost" fullWidth className="justify-start text-left"
              onClick={() => moveTo(markerTime(m))} data-testid="interviews-record-marker">
              <Inline gap="sm" align="center" wrap={false} className="min-w-0">
                <T size="xs" tone="tertiary" tabular>{clockOf(markerTime(m))}</T>
                <Chip size="sm" tone={m.kind === 'milo-asked' ? 'info' : 'neutral'}>{MARKER_LABELS[m.kind]}</Chip>
                <T size="sm" truncate title={m.label}>{m.label}</T>
              </Inline>
            </Button>
          ))}
        </Stack>
      ) : <T size="sm" tone="secondary">No question was marked in this interview.</T>}
    </DetailSection>
  );

  const left = (
    <Stack gap="md" className="h-full min-h-0 min-w-0 pr-3" data-testid="interviews-record-body">
      {!standIn && <DetailSection variant="heading" as="h2" first title="Recording" data-testid="interviews-record-recording">{recordingPart}</DetailSection>}
      {board
        ? <Stack gap="xs" className="min-h-0 flex-1" data-testid="interviews-record-board-section">
            <Inline gap="sm" align="baseline" wrap={false}>
              <T size="sm" weight="medium">Whiteboard</T>
              <T size="xs" tone="tertiary">The final board, and the board at a few times in the round</T>
            </Inline>
            <BoardSnapshots interviewId={interview.id} startedAt={interview.startedAt} onMoveTo={moveTo} />
          </Stack>
        : technical
        ? <Stack gap="xs" className="min-h-0 flex-1" data-testid="interviews-record-code-section">
            <Inline gap="sm" align="baseline" wrap={false}>
              <T size="sm" weight="medium">Code</T>
              <T size="xs" tone="tertiary" data-testid="interviews-record-legend">Q question · P paste · R run</T>
            </Inline>
            {code}
          </Stack>
        : <Stack gap="none" className="min-h-0 flex-1 overflow-y-auto">{moments}</Stack>}
    </Stack>
  );

  return (
    <DetailPage data-testid="interviews-record" title={`${interview.candidate.name}, ${interview.round.name}`}
      badge={<Chip tone={status.tone} size="sm" data-testid="interviews-record-state">{status.label}</Chip>}
      meta={<MetaLine size="sm" items={[
        interview.opening.title,
        ROUND_TYPE_LABELS[interview.round.type],
        interview.startedAt ? whenLabel(interview.startedAt) : null,
        standIn ? recordingNote : lengthSeconds ? lengthOf(lengthSeconds) : `${interview.round.minutes} minutes planned`,
      ].filter((x): x is string => Boolean(x))} />}>
      <SplitPane className="h-[calc(100vh-14rem)] min-h-[32rem]" defaultRatio={0.58} minPrimaryPx={420} minSecondaryPx={320} dividerLabel="Resize the recording and the transcript"
        primary={left}
        secondary={<Stack gap="sm" className="h-full min-w-0 pl-3" data-testid="interviews-record-transcript">{words}</Stack>} />
    </DetailPage>
  );
}
