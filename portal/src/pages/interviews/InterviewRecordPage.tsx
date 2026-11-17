// /interviews/rounds/:id/record — the interview record (docs/interviews-tenant-plan.md row I5.1, decision 4; contract
// E2): the recording, the transcript and the moments a question was asked, for the panel side of a finished interview.
//
// The server decides who reads it (its lead, its panel, a recruiter, the opening's hiring manager; nobody else, and only
// once the interview has ended); anyone else gets the tenant's not-found. The recording plays in the library's
// RecordingPlayer when platform-api has media for the viewer (it asks the middleware every time); otherwise one plain
// line says why there is nothing to play. The transcript is the library's TranscriptPanel, time-aligned to the player
// when it plays; the markers move the transcript (and the player) to that moment. No download, no share, no copy-all.
import { Button, Chip, DetailPage, DetailSection, Inline, LoadingState, MetaLine, Stack, T } from '@connorhoehn/ui-components/shared';
import { RecordingPlayer, TranscriptPanel } from '@connorhoehn/ui-components/video';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { ROUND_TYPE_LABELS, roundStatus, whenLabel } from '../../lib/interviews';
import {
  MARKER_LABELS, clockOf, lengthOf, loadInterviewMedia, markerTime, offsetMs, playFrom, recordApi, recordingLine, segmentsOf, transcriptLine,
  type InterviewMedia, type InterviewRecordView,
} from '../../lib/interviewsRecord';

type Trail = ReturnType<typeof useFlushTrailItems>;

export default function InterviewRecordPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const trail = useFlushTrailItems();
  const { data, error, failure, refresh } = useFetch<{ record: InterviewRecordView }>(id ? recordApi(id) : null);
  const record = data?.record ?? null;
  useCrumbLabel(id, record ? `${record.interview.candidate.name}, ${record.interview.round.name}` : null);
  if (failure?.status === 404) {
    return <RecordNotFound heading="Interview" title="Interview not found" body="There is no interview here that you can open." backLabel="Home" onBack={() => navigate('/interviews')} />;
  }
  if (error && !record) return <UnavailableNotice error={error} what="this interview" source="Interviews are read from the interviews tenant" onRetry={refresh} />;
  if (!record) return <DetailPage title="Interview" breadcrumbs={trail}><LoadingState label="Opening the interview…" /></DetailPage>;
  return <RecordWorkspace key={record.interview.id} record={record} trail={trail} />;
}

/** Media from platform-api, asked only when the server says a real recording may be there. */
function useInterviewMedia(record: InterviewRecordView): InterviewMedia | null {
  const ask = record.recording.state === 'available' && !record.recording.standIn;
  const [media, setMedia] = useState<InterviewMedia | null>(null);
  useEffect(() => {
    if (!ask) return undefined;
    const ctl = new AbortController();
    void loadInterviewMedia(record.interview.id, ctl.signal).then((m) => { if (!ctl.signal.aborted) setMedia(m); });
    return () => ctl.abort();
  }, [ask, record.interview.id]);
  return ask ? media : null;
}

function RecordWorkspace({ record, trail }: { record: InterviewRecordView; trail: Trail }) {
  const { interview, recording, transcript, markers } = record;
  const media = useInterviewMedia(record);
  const playing = media?.state === 'playable' && media.url ? media.url : null;
  // The record counts from the interview's start; a real recording from its own. The transcript and markers move onto the player's clock.
  const shift = playing ? offsetMs(interview.startedAt, media!.startedAt) : 0;
  const endMs = recording.durationSeconds ? recording.durationSeconds * 1000 : null;
  const segments = useMemo(() => segmentsOf(transcript.lines, shift, endMs), [transcript.lines, shift, endMs]);
  const [currentMs, setCurrentMs] = useState<number | null>(null);
  // The player restarts at a chosen moment (the library's RecordingPlayer takes no seek; a media fragment starts it there).
  const [startAt, setStartAt] = useState(0);
  const moveTo = (ms: number) => { setCurrentMs(ms); if (playing) setStartAt(ms); };

  const status = roundStatus(interview.state);
  const lengthSeconds = recording.durationSeconds
    ?? (interview.startedAt && interview.endedAt ? Math.max(0, (Date.parse(interview.endedAt) - Date.parse(interview.startedAt)) / 1000) : null);
  const recordingNote = recordingLine(recording, media?.state ?? null);
  const transcriptNote = transcriptLine(transcript.state);

  const player = playing ? (
    <RecordingPlayer key={`${playing}:${startAt}`} playlistUrl={playFrom(playing, startAt)} autoPlay={startAt > 0} hideDownload className="aspect-video w-full"
      onTimeUpdate={(seconds) => setCurrentMs(seconds * 1000)} />
  ) : recording.state === 'available' && !recording.standIn && !media ? (
    <LoadingState label="Looking for the recording…" />
  ) : (
    <T size="sm" tone="secondary" wrap data-testid="interviews-record-recording-line">{recordingNote}</T>
  );

  return (
    <DetailPage data-testid="interviews-record" title={`${interview.candidate.name}, ${interview.round.name}`} breadcrumbs={trail}
      badge={<Chip tone={status.tone} size="xs" data-testid="interviews-record-state">{status.label}</Chip>}
      meta={<MetaLine size="sm" items={[
        interview.opening.title,
        ROUND_TYPE_LABELS[interview.round.type],
        interview.startedAt ? whenLabel(interview.startedAt) : null,
        lengthSeconds ? lengthOf(lengthSeconds) : `${interview.round.minutes} minutes planned`,
      ].filter((x): x is string => Boolean(x))} />}>
      <Stack gap="lg" className="grid min-w-0 items-start lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" data-testid="interviews-record-body">
        <Stack gap="md" className="min-w-0">
          <DetailSection variant="heading" first title="Recording" data-testid="interviews-record-recording">{player}</DetailSection>
          <DetailSection variant="heading" title="Moments" hint="When a question was asked. Choosing one moves the transcript there." data-testid="interviews-record-markers">
            {markers.length ? (
              <Stack gap="xs">
                {markers.map((m) => (
                  <Button key={`${m.kind}:${m.atMs}`} size="sm" variant="ghost" fullWidth className="justify-start text-left"
                    onClick={() => moveTo(markerTime(m, shift))} data-testid="interviews-record-marker">
                    <Inline gap="sm" align="center" wrap={false} className="min-w-0">
                      <T size="xs" tone="tertiary" tabular>{clockOf(markerTime(m, shift))}</T>
                      <Chip size="xs" tone={m.kind === 'milo-asked' ? 'info' : 'neutral'}>{MARKER_LABELS[m.kind]}</Chip>
                      <T size="sm" truncate title={m.label}>{m.label}</T>
                    </Inline>
                  </Button>
                ))}
              </Stack>
            ) : <T size="sm" tone="secondary">No question was marked in this interview.</T>}
          </DetailSection>
        </Stack>
        <Stack gap="sm" className="min-w-0" data-testid="interviews-record-transcript">
          {transcriptNote ? (
            <DetailSection variant="heading" title="Transcript"><T size="sm" tone="secondary" wrap data-testid="interviews-record-transcript-line">{transcriptNote}</T></DetailSection>
          ) : (
            <TranscriptPanel status="ready" segments={segments} currentTimeMs={currentMs} onSeek={moveTo}
              emptyMessage="Nothing was transcribed in this interview." data-testid="interviews-record-transcript-panel" />
          )}
        </Stack>
      </Stack>
    </DetailPage>
  );
}
