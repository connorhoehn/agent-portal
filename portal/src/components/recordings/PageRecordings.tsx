import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { RecordingActivityCard } from '@connorhoehnslalom/ui-components/social';
import { Button, Inline, InlineAlert, LoadingState, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { FileRefreshAction } from '../files/FileToolbar';
import { createInitiativeRecordingsClient, readInitiativeRecordings, type RecordingPage } from '../../pages/projects/initiativeRecordingApi';
import { recordingIsProcessing, recordingProcessingLabel, recordingStage } from './recordingState';
import { RecordingDetail } from './RecordingDetail';
import { RecordingContentSearch } from './RecordingContentSearch';
import { useRecordingRead } from './useRecordingRead';

import { RECORDING_CHANGED_EVENT } from './recordingEvents';
export { RECORDING_CHANGED_EVENT } from './recordingEvents';
export function PageRecordings(props: { lobby: string; subjectName: string; preview?: boolean; onOpen(id: string | null): void }) {
  const { session } = useSession();
  if (!session || session.sub === 'unknown') return null;
  const identity = JSON.stringify([session.sub, session.tenant, session.role, session.masquerading]);
  return <RecordingShelf key={`${identity}:${props.lobby}`} {...props} />;
}
function RecordingShelf({ lobby, subjectName, preview = false, onOpen }: { lobby: string; subjectName: string; preview?: boolean; onOpen(id: string | null): void }) {
  const client = useMemo(() => createInitiativeRecordingsClient({ scopeLabel: 'page' }), []);
  const [params] = useSearchParams();
  const selectedId = preview ? null : params.get('recording');
  const [searchActive, setSearchActive] = useState(false);
  const read = useRecordingRead(selectedId ? null : lobby, signal => readInitiativeRecordings(client, lobby, signal), page => page.items.some(recordingIsProcessing) ? 5000 : null);
  const [older, setOlder] = useState<RecordingPage | null>(null), [olderBusy, setOlderBusy] = useState(false), [olderError, setOlderError] = useState<string | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  useEffect(() => () => olderRequest.current?.abort(), []);
  const refresh = () => { olderRequest.current?.abort(); setOlder(null); setOlderBusy(false); setOlderError(null); read.refresh(); };
  useEffect(() => {
    const update = (event: Event) => { if ((event as CustomEvent<{ lobby?: string }>).detail?.lobby === lobby) read.refresh(); };
    window.addEventListener(RECORDING_CHANGED_EVENT, update);
    return () => window.removeEventListener(RECORDING_CHANGED_EVENT, update);
  }, [lobby, read.refresh]);
  const cursor = older ? older.cursor : read.value?.cursor;
  async function loadOlder() {
    if (!cursor || olderBusy) return;
    const abort = new AbortController(); olderRequest.current = abort; setOlderBusy(true); setOlderError(null);
    try { const page = await readInitiativeRecordings(client, lobby, abort.signal, cursor); if (!abort.signal.aborted) setOlder(previous => ({ cursor: page.cursor, items: [...new Map([...(previous?.items ?? []), ...page.items].map(row => [row.recordingId, row])).values()] })); }
    catch (error) { if (!abort.signal.aborted) setOlderError(error instanceof Error ? error.message : 'Older recordings could not be loaded.'); }
    finally { if (!abort.signal.aborted) setOlderBusy(false); }
  }
  const allRows = [...new Map([...(read.value?.items ?? []), ...(older?.items ?? [])].map(row => [row.recordingId, row])).values()];
  const rows = preview ? allRows.slice(0, 2) : allRows;
  return <Stack gap="sm" className="min-w-0" data-testid={preview ? 'initiative-recordings-activity' : 'initiative-recordings'}>
    <Inline gap="sm" align="center" justify="between" wrap><T size="sm" weight="semibold">Recorded huddles</T>
      <Inline gap="sm">{preview ? <Button variant="link" size="sm" className="text-xs" onClick={() => onOpen(null)}>All recordings</Button>
        : selectedId ? <Button variant="link" size="sm" className="text-xs" onClick={() => onOpen(null)}>Back to docs & recordings</Button>
        : <FileRefreshAction label="Refresh recorded huddles" refreshing={read.loading} onRefresh={refresh} />}</Inline>
    </Inline>
    {!preview && !selectedId && <RecordingContentSearch lobby={lobby} onActive={setSearchActive} />}
    {selectedId ? <RecordingDetail key={selectedId} id={selectedId} lobby={lobby} subjectName={subjectName} client={client} />
      : searchActive ? null
      : read.error ? <InlineAlert tone="warning">{read.error}</InlineAlert>
      : read.timedOut && !read.value ? <InlineAlert tone="info">Recordings could not be checked yet. Refresh to try again.</InlineAlert>
      : read.loading ? <LoadingState label="Loading recorded huddles…" />
      : rows.length === 0 ? <T size="xs" tone="secondary">{cursor ? 'No recordings from this page in the current window. Load older calls to continue.' : 'Recordings you participated in appear here after the call.'}</T>
      : <Stack gap="sm">{rows.map(row => <Stack key={row.recordingId} gap="xs">
        <RecordingActivityCard recordingId={row.recordingId} title={`${subjectName} huddle`} startedAt={row.startedAt} durationMs={row.durationMs}
          participants={(row.participants ?? []).map(person => ({ id: person.userId, name: person.displayName ?? person.userId }))} participantCount={row.participantCount}
          stage={recordingStage(row)} transcriptReady={row.transcriptStatus === 'ready'} summaryReady={row.summaryStatus === 'ready'}
          onOpen={onOpen} onOpenTranscript={onOpen} className="max-w-none [&_button[data-testid$=-thumb]]:w-32" />
        <Inline gap="sm" align="center" justify="between" wrap><T size="xs" tone="secondary" role="status">{recordingProcessingLabel(row)}</T><Button variant="link" size="sm" className="text-xs" onClick={() => onOpen(row.recordingId)}>View recording details</Button></Inline>
      </Stack>)}</Stack>}
    {!searchActive && read.timedOut && <InlineAlert tone="info">Processing is taking longer than expected. Refresh to check again.</InlineAlert>}
    {!searchActive && olderError && <InlineAlert tone="warning">{olderError}</InlineAlert>}
    {!searchActive && !selectedId && !preview && cursor && <Button variant="link" size="sm" className="text-xs" disabled={olderBusy} onClick={() => void loadOlder()}>Load older recordings</Button>}
  </Stack>;
}
