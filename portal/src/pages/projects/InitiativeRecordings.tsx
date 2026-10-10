import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Button, DocumentIcon, Inline, LoadingState, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { PlaybackReactionsLayer, RecordingList, RecordingPlayer } from '@connorhoehnslalom/ui-components/video';
import { useSession } from '../../lib/auth';
import { usePeopleNames } from '../../hooks/usePageCalls';
import { absoluteTime, durationLabel } from '../../lib/relativeTime';
import { createInitiativeRecordingsClient, initiativeRecordingItems, readInitiativeRecordings, timedRecordingReactions, type InitiativeRecording, type InitiativeRecordingsClient, type RecordedReaction, type RecordingPage, type RecordingPlayback } from './initiativeRecordingApi';

export function InitiativeRecordings({ projectId, projectName, preview = false, onOpen }: {
  projectId: string; projectName: string; preview?: boolean; onOpen(id: string | null): void;
}) {
  const { session } = useSession();
  if (!session || session.sub === 'unknown') return null;
  const identity = JSON.stringify([session.sub, session.tenant, session.role, session.masquerading]);
  return <RecordingShelf key={`${identity}:${projectId}`} lobby={`orgiq:initiative:${projectId}`} projectName={projectName} preview={preview} onOpen={onOpen} />;
}

function RecordingShelf({ lobby, projectName, preview, onOpen }: { lobby: string; projectName: string; preview: boolean; onOpen(id: string | null): void }) {
  const client = useMemo(() => createInitiativeRecordingsClient(), []);
  const [params] = useSearchParams();
  const selectedId = params.get('recording');
  const [read, setRead] = useState<RecordingPage | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const load = useCallback((cursor: string | null = null) => {
    request.current?.abort();
    const abort = new AbortController(); request.current = abort;
    setBusy(true); setError(null);
    void readInitiativeRecordings(client, lobby, abort.signal, cursor).then(result => {
      if (abort.signal.aborted) return;
      setRead(previous => cursor && previous ? { cursor: result.cursor, items: [...new Map([...previous.items, ...result.items].map(row => [row.recordingId, row])).values()] } : result);
    }).catch(cause => {
      if (!abort.signal.aborted) { setRead(null); setError(cause instanceof Error ? cause.message : 'Recordings could not be loaded.'); }
    }).finally(() => { if (!abort.signal.aborted) setBusy(false); });
  }, [client, lobby]);
  useEffect(() => {
    if (selectedId && !preview) { request.current?.abort(); setBusy(false); return; }
    load(); return () => request.current?.abort();
  }, [load, selectedId, preview]);
  const rows = preview ? read?.items.slice(0, 2) ?? [] : read?.items ?? [];
  return <Stack gap="sm" className="min-w-0" data-testid={preview ? 'initiative-recordings-activity' : 'initiative-recordings'}>
    <Inline gap="sm" align="center" justify="between">
      <Inline gap="sm" align="center"><DocumentIcon size={15} /><T size="sm" weight="semibold">Recorded huddles</T></Inline>
      <Inline gap="sm">
        {preview && <Button variant="link" size="sm" className="text-xs" onClick={() => onOpen(null)}>All recordings</Button>}
        {!preview && selectedId ? <Button variant="link" size="sm" className="text-xs" onClick={() => onOpen(null)}>Back to docs & recordings</Button>
          : <Button variant="link" size="sm" className="text-xs" disabled={busy} onClick={() => load()}>Refresh</Button>}
      </Inline>
    </Inline>
    {(preview || !selectedId) && (busy && !read ? <LoadingState label="Loading recorded huddles…" /> : error ? <T size="xs" tone="secondary" role="status" wrap>{error}</T>
      : rows.length === 0 ? <T size="xs" tone="secondary" wrap>{read?.cursor ? 'No initiative recordings in these pages. Continue to older calls.' : 'Recorded huddles you participated in will appear here.'}</T>
      : <RecordingList recordings={initiativeRecordingItems(rows, projectName)}
        {...(selectedId ? { selectedId } : {})} onSelect={onOpen}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 [&_[data-testid=recording-row]]:p-2 [&_[data-testid=recording-row]>div:first-child]:h-16 [&_[data-testid=recording-row]>div:first-child]:aspect-auto [&_[data-testid=recording-row]>div:first-child]:mb-1" />)}
    {!error && read?.cursor && !preview && !selectedId && <Button variant="link" size="sm" disabled={busy} onClick={() => load(read.cursor)}>Load older calls</Button>}
    {!preview && selectedId && <RecordingDetail key={selectedId} id={selectedId} lobby={lobby} client={client} />}
  </Stack>;
}

function RecordingDetail({ id, lobby, client }: { id: string; lobby: string; client: InitiativeRecordingsClient }) {
  const nameOf = usePeopleNames();
  const [recording, setRecording] = useState<InitiativeRecording | null>(null);
  const [playback, setPlayback] = useState<RecordingPlayback | null>(null);
  const [reactions, setReactions] = useState<RecordedReaction[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setError(null); setActivityError(null); setRecording(null); setPlayback(null); setReactions(null); setCurrentTimeMs(0);
    void client.detail(id, lobby, abort.signal).then(async row => {
      if (abort.signal.aborted) return;
      setRecording(row);
      // Lobby equality is verified before either asset request. Both routes
      // retain their own participant/lobby authorization on the server.
      await Promise.allSettled([
        client.playback(id, abort.signal).then(value => { if (!abort.signal.aborted) setPlayback(value); }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Playback could not be loaded.'); }),
        client.reactions(row, abort.signal).then(value => { if (!abort.signal.aborted) setReactions(value); }).catch(cause => { if (!abort.signal.aborted) setActivityError(cause instanceof Error ? cause.message : 'Recorded reactions could not be loaded.'); }),
      ]);
    }).catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'This recording is unavailable.'); });
    return () => abort.abort();
  }, [client, id, lobby, retry]);
  const rawUrl = playback?.composedUrl ?? playback?.playlistUrl;
  const url = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : null;
  const playbackReactions = useMemo(() => recording && reactions ? timedRecordingReactions(recording, reactions) : [], [recording, reactions]);
  return <Stack gap="sm" className="min-w-0 @container" data-testid="initiative-recording-detail">
    <Inline gap="sm" justify="between" align="center">
      <T size="xs" tone="secondary">{recording ? `${absoluteTime(recording.startedAt)} · ${durationLabel(recording.durationMs)}` : 'Huddle playback'}</T>
      <Button variant="link" size="sm" onClick={() => setRetry(n => n + 1)}><T as="span" size="xs">Reload</T></Button>
    </Inline>
    <div className="grid min-w-0 items-start gap-4 @min-[680px]:grid-cols-[minmax(0,1fr)_216px]">
      <div className="min-w-0">
        {error ? <T size="sm" tone="secondary" role="status" wrap>{error}</T> : !recording || !playback ? <LoadingState label="Opening the recording…" />
          : playback.mediaState === 'playable' && url ? <div key={url} role="region" aria-label="Recorded initiative huddle" className="relative w-full max-w-[720px]" data-testid="initiative-recording-video">
            <RecordingPlayer playlistUrl={url} hideDownload className="aspect-video w-full [&>div:last-child]:opacity-100"
              onTimeUpdate={seconds => setCurrentTimeMs(seconds * 1000)}
              onError={() => setError('The saved video could not be played. Try reloading it.')} />
            <PlaybackReactionsLayer reactions={playbackReactions} currentTimeMs={currentTimeMs} />
          </div>
          : <T size="sm" tone="secondary" wrap>{playback.mediaState === 'processing' ? 'The video is still being prepared. Reload in a moment.' : 'There is no playable video for this recording.'}</T>}
      </div>
      {recording && <Stack gap="sm" className="min-w-0 rounded-lg border border-border bg-surface-muted p-3" data-testid="initiative-recording-activity">
          <Stack gap="xs">
            <T size="xs" weight="semibold" tone="secondary">PARTICIPANTS</T>
            <T size="xs" wrap>{(recording.participants ?? []).map(person => person.displayName ?? nameOf(person.userId)).join(', ') || 'Participants unavailable'}</T>
          </Stack>
          <Stack gap="xs" className="border-t border-border pt-3">
            <T size="xs" weight="semibold" tone="secondary">CALL ACTIVITY</T>
            <T size="xs" tone="secondary">Started · {absoluteTime(recording.startedAt)}</T>
            {activityError ? <T size="xs" tone="secondary" role="status" wrap>{activityError}</T> : reactions === null ? <T size="xs" tone="secondary">Loading reactions…</T>
              : reactions.length === 0 ? <T size="xs" tone="secondary">No reactions recorded.</T>
              : reactions.map(event => <Inline key={event.reactionId} gap="sm" align="center" data-testid="initiative-recording-reaction">
                <span aria-hidden="true">{event.emoji}</span><T size="xs" wrap>{event.displayName ?? (event.userId ? nameOf(event.userId) : 'Participant')} reacted {event.emoji}</T>
                <T size="xs" tone="tertiary">{new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</T>
              </Inline>)}
            {recording.endedAt && <T size="xs" tone="secondary">Ended · {absoluteTime(recording.endedAt)}</T>}
          </Stack>
        </Stack>}
    </div>
  </Stack>;
}
