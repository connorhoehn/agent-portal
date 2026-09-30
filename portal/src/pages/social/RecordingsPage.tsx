// /social/recordings — call recordings you were in (docs/social-tenant-design.md
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
import { useSearchParams } from 'react-router';
import { RecordingList, RecordingPlayer } from '@connorhoehnslalom/ui-components/video';
import {
  Button, Card, Chip, ConfirmDialog, EmptyState, ErrorState, Inline, InlineAlert, KeyValue, LoadingState, PageHeader, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { writeJson } from '../../lib/writeJson';
import type { SocialPerson } from './socialChat';
import { formatDuration, lobbyLabel, mayDeleteRecording, namesFrom, recordingItems, type SocialRecording, type SocialRoom, type SocialSource } from './socialPlatform';

interface RecordingsResponse { source: SocialSource; recordings: SocialRecording[]; counts: { total: number; ready: number } }
interface Playback { recordingId: string; playlistUrl: string | null; mediaState: string }

const MEDIA_STATE: Record<string, string> = {
  processing: 'The recording is still being put together. Try again in a minute.',
  unavailable: 'There is no playable file for this recording.',
};

export default function RecordingsPage() {
  const { session } = useSession();
  const me = session?.sub ?? '';
  const { can, ready } = useCapabilities();
  const mayManage = ready && can('ManageRecordings');
  const { data, isLoading, error, refresh } = useFetch<RecordingsResponse>('/api/social/recordings', 30_000);
  const people = useFetch<{ people: SocialPerson[] }>('/api/social/people');
  const rooms = useFetch<{ rooms: SocialRoom[] }>('/api/social/rooms');
  const nameOf = useMemo(() => namesFrom(people.data?.people ?? []), [people.data]);
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('recording');
  const recs = data?.recordings ?? [];
  const selected = recs.find((r) => r.recordingId === selectedId) ?? null;
  const items = useMemo(() => recordingItems(recs, me, nameOf, rooms.data?.rooms ?? []), [recs, me, nameOf, rooms.data]);
  const playback = useFetch<Playback>(selected ? `/api/social/recordings/${encodeURIComponent(selected.recordingId)}/playback` : null);
  const [shared, setShared] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SocialRecording | null>(null);

  const select = (id: string | null) => setParams(id ? { recording: id } : {}, { replace: true });

  async function share(r: SocialRecording) {
    setProblem(null);
    const res = await writeJson<{ shareUrl: string; expiresAt: string }>(`/api/social/recordings/${encodeURIComponent(r.recordingId)}/share`, 'POST');
    if (!res.ok || !res.data) { setProblem(res.error ?? 'The share link could not be made.'); return; }
    setShared(`Share link ready (valid until ${new Date(res.data.expiresAt).toLocaleDateString()}): ${res.data.shareUrl}`);
  }

  async function remove(r: SocialRecording) {
    setConfirmDelete(null);
    const res = await writeJson(`/api/social/recordings/${encodeURIComponent(r.recordingId)}`, 'DELETE');
    if (!res.ok) { setProblem(res.error ?? 'The recording could not be deleted.'); return; }
    if (selectedId === r.recordingId) select(null);
    refresh();
  }

  return (
    <Stack gap="lg" data-testid="social-recordings-page">
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
          <Card padding="sm" className="w-96 shrink-0" data-testid="social-recording-list">
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
          </Card>
          {!selected ? (
            <EmptyState align="start" className="min-w-0 flex-1" testId={selectedId ? 'social-recording-missing' : 'social-recording-pick'}
              title={selectedId ? 'This recording is not available' : 'Pick a recording'}
              description={selectedId ? 'It does not exist, or you were not on the call.' : 'Choose a recording on the left to play it.'} />
          ) : (
            <Card padding="md" className="min-w-0 flex-1" data-testid="social-recording-detail">
              <Stack gap="md">
                <PageHeader title={lobbyLabel(selected.lobbyName, me, nameOf, rooms.data?.rooms ?? [])}
                  description={new Date(selected.startedAt).toLocaleString()} />
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
            </Card>
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
