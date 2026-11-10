// The chat workspace's Recordings destination (`/social/recordings`, the
// shelf's Recordings): call recordings you were in (docs/social-tenant-design.md
// §4.5, lane S2).
//
// Recordings are platform-api's (`video-call-recordings`, keyed by call),
// read through the BFF (`GET /api/social/recordings`), which keeps the ones in
// `social:` lobbies — upstream lists a person's recordings across every
// tenant. Playing one asks the BFF for what there is to play
// (`/recordings/:id/playback` → platform-api's playback-token route: the
// composed file's URL, or a plain "nothing yet"). Share links and delete are
// ManageRecordings, Cedar-gated at the BFF; platform-api adds its own rule on
// top — only whoever started a recording deletes it.
//
// The list and the player are the library's `RecordingList` + `RecordingPlayer`.

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { RecordingList, RecordingPlayer } from '@connorhoehn/ui-components/video';
import {
  Button, Chip, ConfirmDialog, EmptyState, ErrorState, Inline, InlineAlert, KeyValue, LoadingState, PageHeader, Stack,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { writeJson } from '../../lib/writeJson';
import RoomRecordingSummary from './RoomRecordingSummary';
import { useSocialPlane } from './socialPlane';
import { isRoomLobby, roomSummarizeText, type RoomSummaryTarget } from './socialRoomSummary';
import { socialSummarizeApi } from './socialSummarize';
import { formatDuration, lobbyLabel, mayDeleteRecording, recordingItems, type NameOf, type SocialRecording, type SocialRoom, type SocialSource } from './socialPlatform';

interface RecordingsResponse { source: SocialSource; recordings: SocialRecording[]; counts: { total: number; ready: number } }
interface Playback { recordingId: string; playlistUrl: string | null; mediaState: string }

const MEDIA_STATE: Record<string, string> = {
  processing: 'The recording is still being put together. Try again in a minute.',
  unavailable: 'There is no playable file for this recording.',
};

export default function RecordingsPane({ me, nameOf, rooms, mayManage, postTargets = [], displayName }: { me: string; nameOf: NameOf; rooms: readonly SocialRoom[]; mayManage: boolean; postTargets?: readonly RoomSummaryTarget[]; displayName?: string }) {
  const { api, route } = useSocialPlane();
  const { data, isLoading, error, refresh } = useFetch<RecordingsResponse>(`${api}/recordings`, 30_000);
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const selectedId = params.get('recording');
  const recs = useMemo(() => data?.recordings ?? [], [data]);
  const selected = recs.find((r) => r.recordingId === selectedId) ?? null;
  const items = useMemo(() => recordingItems(recs, me, nameOf, rooms), [recs, me, nameOf, rooms]);
  const playback = useFetch<Playback>(selected ? `${api}/recordings/${encodeURIComponent(selected.recordingId)}/playback` : null);
  const [shared, setShared] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SocialRecording | null>(null);

  const select = (id: string | null) => setParams(id ? { recording: id } : {}, { replace: true });

  async function share(r: SocialRecording) {
    setProblem(null);
    const res = await writeJson<{ shareUrl: string; expiresAt: string }>(`${api}/recordings/${encodeURIComponent(r.recordingId)}/share`, 'POST');
    if (!res.ok || !res.data) { setProblem(res.error ?? 'The share link could not be made.'); return; }
    setShared(`Share link ready (valid until ${new Date(res.data.expiresAt).toLocaleDateString()}): ${res.data.shareUrl}`);
  }

  /** A DM call's conversation is its lobby; a room call's private card is drawn here, below. */
  const summaryChannel = (r: SocialRecording): string | null => (r.lobbyName.startsWith('social:dm:') || isRoomLobby(r.lobbyName) ? r.lobbyName : null);
  const [roomRun, setRoomRun] = useState<{ recordingId: string; runId: string } | null>(null);
  const summarize = async (r: SocialRecording) => {
    if (isRoomLobby(r.lobbyName)) {
      setProblem(null);
      try {
        const started = await socialSummarizeApi.start(r.lobbyName, roomSummarizeText(r.recordingId));
        setRoomRun({ recordingId: r.recordingId, runId: started.runId });
      } catch (cause) { setProblem(cause instanceof Error ? cause.message : 'The summary could not be started.'); }
      return;
    }
    navigate(`${route}/dms/${encodeURIComponent(r.lobbyName)}?summarizeRecording=${encodeURIComponent(r.recordingId)}`);
  };

  async function remove(r: SocialRecording) {
    setConfirmDelete(null);
    const res = await writeJson(`${api}/recordings/${encodeURIComponent(r.recordingId)}`, 'DELETE');
    if (!res.ok) { setProblem(res.error ?? 'The recording could not be deleted.'); return; }
    if (selectedId === r.recordingId) select(null);
    refresh();
  }

  return (
    <Stack gap="md" className="min-h-0 min-w-0 overflow-y-auto" data-testid="social-recordings-pane">
      <PageHeader
        title="Recordings"
        description="Recorded calls you were on, and who they are shared with."
        {...(data ? { badge: <Chip tone="neutral" size="xs">{data.counts.total} {data.counts.total === 1 ? 'recording' : 'recordings'}</Chip> } : {})}
      />
      {shared && <InlineAlert tone="success" onDismiss={() => setShared(null)}>{shared}</InlineAlert>}
      {problem && <InlineAlert tone="error" onDismiss={() => setProblem(null)}>{problem}</InlineAlert>}
      {isLoading && !data ? <LoadingState label="Loading recordings…" /> : error && !data ? (
        <ErrorState title="Recordings could not be loaded" description={error} actionLabel="Try again" onAction={refresh} />
      ) : recs.length === 0 ? (
        <EmptyState testId="social-empty-recordings" align="start" title="No recordings yet"
          description="A recorded call lands here for everyone who was on it. Nothing you were on has been recorded in this workspace." />
      ) : (
        <Inline gap="lg" align="start" wrap={false}>
          <Stack gap="none" className="w-96 shrink-0" data-testid="social-recording-list">
            <RecordingList
              recordings={items}
              {...(selectedId ? { selectedId } : {})}
              onSelect={(id) => select(id)}
              {...(mayManage ? {
                renderActions: (item) => {
                  const r = recs.find((x) => x.recordingId === item.id);
                  if (!r) return null;
                  return (
                    <Inline gap="xs">
                      <Button variant="ghost" size="sm" onClick={() => void share(r)} data-testid="social-recording-share">Share</Button>
                      {mayDeleteRecording(r, me) && (
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(r)} data-testid="social-recording-delete">Delete</Button>
                      )}
                    </Inline>
                  );
                },
              } : {})}
            />
          </Stack>
          {!selected ? (
            <EmptyState align="start" className="min-w-0 flex-1" testId={selectedId ? 'social-recording-missing' : 'social-recording-pick'}
              title={selectedId ? 'This recording is not available' : 'Pick a recording'}
              description={selectedId ? 'It does not exist, or you were not on the call.' : 'Choose a recording on the left to play it.'} />
          ) : (
            <Stack gap="md" className="min-w-0 flex-1" data-testid="social-recording-detail">
              {/* One h1 per page (UX walk D): the open recording sits under the Recordings title. */}
              <PageHeader as="h2" title={lobbyLabel(selected.lobbyName, me, nameOf, rooms)} description={new Date(selected.startedAt).toLocaleString()}
                actions={(
                  <Button variant="secondary" size="sm" disabled={!summaryChannel(selected) || selected.stage !== 'ready'} onClick={() => void summarize(selected)}
                    data-testid="social-recording-summarize"
                    {...(!summaryChannel(selected) ? { title: 'This call has no conversation to summarize into.' } : selected.stage !== 'ready' ? { title: 'The transcript is not ready yet.' } : {})}>
                    Summarize
                  </Button>
                )} />
              {roomRun && roomRun.recordingId === selected.recordingId && (
                <RoomRecordingSummary key={roomRun.runId} runId={roomRun.runId} instruction="/summarize" userId={me} displayName={displayName ?? nameOf(me)}
                  targets={postTargets} onDismiss={() => setRoomRun(null)} />
              )}
              {playback.isLoading && !playback.data ? <LoadingState label="Finding the recording…" /> : playback.data?.playlistUrl ? (
                <RecordingPlayer playlistUrl={playback.data.playlistUrl} hideDownload={selected.lobbyName.includes(':dm:')} />
              ) : (
                <EmptyState align="start" testId="social-recording-unplayable" title="Nothing to play"
                  description={playback.error ?? MEDIA_STATE[playback.data?.mediaState ?? 'unavailable'] ?? MEDIA_STATE['unavailable']!} />
              )}
              <KeyValue items={[
                { label: 'Length', value: formatDuration(selected.durationMs) },
                { label: 'People', value: selected.participants.map((p) => p.displayName ?? nameOf(p.userId)).join(', ') || '—' },
                { label: 'Started by', value: selected.startedBy ? nameOf(selected.startedBy) : '—' },
                { label: 'Expires', value: selected.expiresAt ? new Date(selected.expiresAt).toLocaleDateString() : 'Never' },
              ]} data-testid="social-recording-facts" />
            </Stack>
          )}
        </Inline>
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete this recording?"
        body="It is removed for everyone who was on the call. This cannot be undone."
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={() => { if (confirmDelete) void remove(confirmDelete); }}
        onCancel={() => setConfirmDelete(null)}
      />
    </Stack>
  );
}
