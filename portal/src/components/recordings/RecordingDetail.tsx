import { useEffect, useMemo, useState } from 'react';
import { Button, Chip, Inline, InlineAlert, LoadingState, MarkdownView, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { PlaybackReactionsLayer, RecordingPlayer, TranscriptPanel } from '@connorhoehnslalom/ui-components/video';
import { usePeopleNames } from '../../hooks/usePageCalls';
import { absoluteTime, durationLabel } from '../../lib/relativeTime';
import { recordingPlaybackUrl, timedRecordingReactions, type InitiativeRecordingsClient } from '../../pages/projects/initiativeRecordingApi';
import { progressDelay, recordingIsProcessing, recordingProcessingLabel } from './recordingState';
import { useRecordingRead } from './useRecordingRead';
import { notifyRecordingRead } from './recordingEvents';

export function RecordingDetail({ id, lobby, client, subjectName }: { id: string; lobby: string; client: InitiativeRecordingsClient; subjectName: string }) {
  const nameOf = usePeopleNames();
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [mediaError, setMediaError] = useState(false);
  const metadata = useRecordingRead(id, signal => client.detail(id, lobby, signal), row => recordingIsProcessing(row) ? 5000 : null);
  const row = metadata.error ? null : metadata.value;
  const statusKey = row && !metadata.error ? JSON.stringify([row.recordingId, row.composeStatus, row.transcriptStatus, row.summaryStatus, row.processingAttemptId, row.summaryRunId]) : null;
  useEffect(() => { if (statusKey) notifyRecordingRead(lobby, 'detail'); }, [statusKey, lobby]);
  // Verify the exact native subject before requesting any asset. Every route
  // then independently rechecks participant authority; one failed artifact
  // does not hide another artifact that the participant may still read.
  const playback = useRecordingRead(row ? id : null, signal => client.playback(id, signal), value => value.mediaState === 'processing' ? 5000 : null);
  const transcript = useRecordingRead(row?.transcriptStatus ? `${id}:${row.processingAttemptId ?? row.summaryRunId ?? 'initial'}:${row.transcriptStatus}` : null, signal => client.transcript(id, signal), value => value.status === 'ready' ? null : progressDelay(value));
  const summary = useRecordingRead(row?.transcriptStatus ? `${id}:${row.processingAttemptId ?? row.summaryRunId ?? 'initial'}:${row.summaryStatus ?? 'unknown'}` : null, signal => client.summary(id, signal, row?.summaryStatus), value => value.status === 'ready' ? null : progressDelay(value));
  const reactions = useRecordingRead(row ? id : null, signal => client.reactions(row!, signal), () => null);
  const replay = useMemo(() => row && reactions.value ? timedRecordingReactions(row, reactions.value) : [], [row, reactions.value]);
  const url = recordingPlaybackUrl(playback.value);
  const showMediaFrame = !mediaError && !playback.error && !playback.timedOut && (!playback.value || playback.value.mediaState === 'processing' || (playback.value.mediaState === 'playable' && !!url));
  const retry = () => { setMediaError(false); metadata.refresh(); playback.refresh(); transcript.refresh(); summary.refresh(); reactions.refresh(); };
  const transcriptStatus = transcript.value?.status ?? row?.transcriptStatus;
  const summaryStatus = summary.value?.status ?? row?.summaryStatus;
  return <Stack gap="md" className="min-w-0 @container" data-testid="initiative-recording-detail">
    <Inline gap="sm" justify="between" align="center" wrap>
      <Inline gap="sm" wrap><Chip size="xs">{subjectName}</Chip><T size="xs" tone="secondary">{row ? `${absoluteTime(row.startedAt)} · ${durationLabel(row.durationMs)}` : 'Opening recording'}</T></Inline>
      <Button variant="link" size="sm" className="text-xs" onClick={retry}>Refresh recording</Button>
    </Inline>
    {metadata.error ? <InlineAlert tone="warning">{metadata.error}</InlineAlert> : metadata.timedOut && !row ? <InlineAlert tone="info">The recording could not be checked yet. Refresh to try again.</InlineAlert> : !row ? <LoadingState label="Opening the recording…" /> : <>
      <T size="xs" tone="secondary" role="status">{summary.value?.status === 'unavailable' || summary.value?.status === 'stalled' ? 'Summary status unavailable · Refresh to check again' : recordingProcessingLabel(row)}</T>
      {(metadata.timedOut || transcript.timedOut || summary.timedOut) && <InlineAlert tone="info">Processing is taking longer than expected. Refresh to check again; saved artifacts remain available.</InlineAlert>}
      <div className={showMediaFrame ? "grid min-w-0 items-start gap-4 @min-[680px]:grid-cols-[minmax(0,1fr)_216px]" : "grid min-w-0 gap-2"}>
        <Stack gap="sm" className="min-w-0">
          {mediaError || playback.error || playback.timedOut ? <InlineAlert tone="warning">{playback.error ?? (playback.timedOut ? 'The saved video could not be checked yet. Refresh to try again.' : 'The saved video could not be played. Refresh to try again.')}</InlineAlert> : !playback.value ? <div className="aspect-video flex items-center justify-center rounded-lg border border-border bg-surface-muted"><LoadingState label="Opening saved video…" /></div>
            : playback.value.mediaState === 'playable' && url ? <div key={url} role="region" aria-label="Recorded huddle" className="relative w-full max-w-[720px]" data-testid="initiative-recording-video">
              <RecordingPlayer playlistUrl={url} hideDownload className="aspect-video w-full [&>div:last-child]:opacity-100" onTimeUpdate={seconds => setCurrentTimeMs(seconds * 1000)} onError={() => setMediaError(true)} />
              <PlaybackReactionsLayer reactions={replay} currentTimeMs={currentTimeMs} />
            </div> : <T size="sm" tone="secondary" wrap>{playback.value.mediaState === 'processing' ? 'Saving the video…' : 'There is no playable video for this recording.'}</T>}
        </Stack>
        <div className={showMediaFrame ? "min-w-0 rounded-lg border border-border bg-surface-muted p-3 space-y-3" : "grid min-w-0 gap-3 rounded-lg border border-border bg-surface-muted p-3 @min-[680px]:grid-cols-2"} data-testid="initiative-recording-activity"><Stack gap="xs">
          <T size="xs" weight="semibold" tone="secondary">PARTICIPANTS</T><T size="xs" wrap>{(row.participants ?? []).map(person => person.displayName ?? nameOf(person.userId)).join(', ') || 'Participants unavailable'}</T></Stack>
          <Stack gap="xs" className={showMediaFrame ? "border-t border-border pt-3" : "@min-[680px]:border-l @min-[680px]:border-border @min-[680px]:pl-3"}><T size="xs" weight="semibold" tone="secondary">CALL ACTIVITY</T>
            <T size="xs" tone="secondary">Started · {absoluteTime(row.startedAt)}</T>
            {reactions.error ? <T size="xs" tone="secondary" role="status" wrap>{reactions.error}</T> : !reactions.value ? <T size="xs" tone="secondary">Loading reactions…</T>
              : reactions.value.length === 0 ? <T size="xs" tone="secondary">No reactions recorded.</T> : reactions.value.map(event => <Inline key={event.reactionId} gap="sm" data-testid="initiative-recording-reaction"><span aria-hidden="true">{event.emoji}</span><T size="xs" wrap>{event.displayName ?? (event.userId ? nameOf(event.userId) : 'Participant')} reacted {event.emoji}</T></Inline>)}
            {row.endedAt && <T size="xs" tone="secondary">Ended · {absoluteTime(row.endedAt)}</T>}
          </Stack>
        </div>
      </div>
      <Stack gap="sm" data-testid="recording-transcript-attachment">
        <TranscriptPanel status={transcript.timedOut || transcript.error || transcriptStatus === 'failed' || transcriptStatus === 'stalled' || transcriptStatus === 'unavailable' ? 'failed' : transcript.loading ? 'processing' : transcriptStatus === 'ready' ? 'ready' : transcriptStatus === 'pending' ? 'pending' : transcriptStatus === 'processing' ? 'processing' : 'idle'}
          segments={transcript.value?.status === 'ready' ? transcript.value.segments : undefined} currentTimeMs={currentTimeMs}
          pendingMessage="Creating the saved transcript…" errorMessage="The saved transcript is unavailable. You can check the recording again." errorDetail={transcript.error ?? (transcript.value && transcript.value.status !== 'ready' ? transcript.value.error : null) ?? row.transcriptError} />
      </Stack>
      <Stack gap="sm" className="rounded-lg border border-border bg-surface p-3" data-testid="recording-summary-attachment">
        <T size="sm" weight="semibold">Meeting summary</T>
        {summary.timedOut || summary.error || summaryStatus === 'failed' || summaryStatus === 'stalled' || summaryStatus === 'unavailable' ? <InlineAlert tone="warning">{summary.timedOut ? 'The saved summary could not be checked yet. Refresh to try again.' : summary.error ? 'The saved summary could not be read. Refresh to try again.' : summaryStatus === 'failed' ? 'The summary could not be created.' : 'Summary processing could not be verified. Refresh to check again.'}{transcript.value?.status === 'ready' ? ' The saved transcript remains available.' : ''}</InlineAlert>
          : summary.value?.status === 'ready' ? <MarkdownView markdown={summary.value.markdown} scale="sm" />
          : summary.loading ? <LoadingState label="Opening the saved summary…" />
          : summaryStatus === 'pending' || summaryStatus === 'processing' || (row.transcriptStatus && row.transcriptStatus !== 'ready' && !summary.value) ? <LoadingState label="Creating the meeting summary…" />
          : <T size="sm" tone="secondary">No saved summary is available for this recording.</T>}
      </Stack>
    </>}
  </Stack>;
}
