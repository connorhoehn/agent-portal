// Work context adapter over the existing platform-api recording index,
// playback-token and captured-reaction routes used by realtime-examples.
// useLVSRecordings is a raw channel-ARN listing, not the participant index;
// it cannot replace this authorization path. The installed SDK has no
// participant-index client. Storage, capture, compose and permissions remain
// in platform-api/LVS; this adapter only adds initiative filtering and paging.
import type { LVSRecording } from '@connorhoehnslalom/realtime-modules/client/video';
import type { RecordingListItem, TimedReaction } from '@connorhoehnslalom/ui-components/video';
import { realtimeEndpoints, realtimeTokenSource, type RealtimeTokenSource } from '../../lib/realtimeToken.ts';

export interface InitiativeRecording extends Pick<LVSRecording, 'recordingId' | 'startedAt'>,
  Partial<Pick<LVSRecording, 'endedAt' | 'durationMs' | 'participants'>> {
  lobbyName: string;
  participantCount?: number;
  composeStatus?: string;
  stage?: string;
}
export interface RecordingPage { items: InitiativeRecording[]; cursor: string | null }
export interface RecordingPlayback { mediaState: string; composedUrl?: string | null; playlistUrl?: string | null }
export interface RecordedReaction { reactionId: string; lobbyName: string; userId?: string | null; displayName?: string; emoji: string; at: string }

export function createInitiativeRecordingsClient(options: {
  source?: Pick<RealtimeTokenSource, 'get'>;
  fetchImpl?: typeof fetch;
  platformApiUrl?: string;
} = {}) {
  const source = options.source ?? realtimeTokenSource;
  const doFetch = options.fetchImpl ?? fetch;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  async function request<T>(path: string, signal: AbortSignal, method = 'GET'): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await source.get({ force: attempt > 0 });
      signal.throwIfAborted(); // An identity change while minting must not send the old bearer.
      const base = realtimeEndpoints(token, { platformApiUrl: options.platformApiUrl ?? env.VITE_PLATFORM_API_URL }).platformApiUrl;
      if (!base) throw new Error('The call recording service is not configured.');
      const res = await doFetch(`${base.replace(/\/$/, '')}${path}`, {
        method, signal, cache: 'no-store', headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
      });
      if (res.status === 401 && attempt === 0) continue;
      if (!res.ok) {
        if (res.status === 403 || res.status === 404) throw new Error('This recording is not available to your account.');
        if (res.status === 401) throw new Error('Your session expired. Sign in again to open call recordings.');
        throw new Error('Call recordings could not be loaded. Try again.');
      }
      const body = await res.json() as T;
      signal.throwIfAborted();
      return body;
    }
    throw new Error('Your session could not authorize this recording.');
  }
  return {
    async page(cursor: string | null, signal: AbortSignal): Promise<RecordingPage> {
      const query = new URLSearchParams({ limit: '40' });
      if (cursor) query.set('cursor', cursor);
      const body = await request<RecordingPage>(`/api/recordings?${query}`, signal);
      if (!Array.isArray(body.items) || (body.cursor != null && typeof body.cursor !== 'string')) throw new Error('The recording list response is invalid.');
      return { items: body.items, cursor: body.cursor || null };
    },
    async detail(id: string, lobby: string, signal: AbortSignal): Promise<InitiativeRecording> {
      const row = await request<InitiativeRecording>(`/api/recordings/${encodeURIComponent(id)}`, signal);
      if (row.recordingId !== id || row.lobbyName !== lobby) throw new Error('This recording is not part of this initiative.');
      return row;
    },
    playback: (id: string, signal: AbortSignal) => request<RecordingPlayback>(`/api/recordings/${encodeURIComponent(id)}/playback-token`, signal, 'POST'),
    async reactions(row: InitiativeRecording, signal: AbortSignal): Promise<RecordedReaction[]> {
      if (!row.endedAt) return [];
      const query = new URLSearchParams({ lobbyName: row.lobbyName, from: row.startedAt, to: row.endedAt });
      const body = await request<{ reactions: RecordedReaction[] }>(`/api/video/reactions?${query}`, signal);
      if (!Array.isArray(body.reactions)) throw new Error('Recorded reactions could not be read.');
      return recordingReactions(row, body.reactions);
    },
  };
}
export type InitiativeRecordingsClient = ReturnType<typeof createInitiativeRecordingsClient>;

/** Bounded work per click, with a cursor to continue. An empty partial page is not an empty history. */
export async function readInitiativeRecordings(client: Pick<InitiativeRecordingsClient, 'page'>, lobby: string, signal: AbortSignal, cursor: string | null = null): Promise<RecordingPage> {
  const items = new Map<string, InitiativeRecording>();
  const seen = new Set<string>();
  let next = cursor;
  for (let page = 0; page < 5; page++) {
    signal.throwIfAborted();
    if (next) {
      if (seen.has(next)) throw new Error('The recording list could not advance. Try refreshing.');
      seen.add(next);
    }
    const result = await client.page(next, signal);
    signal.throwIfAborted();
    for (const row of result.items) {
      if (row.lobbyName === lobby && typeof row.recordingId === 'string' && Number.isFinite(Date.parse(row.startedAt))) items.set(row.recordingId, row);
    }
    next = result.cursor;
    if (!next || items.size >= 8) break;
  }
  return { items: [...items.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)), cursor: next };
}

/** Never mix a neighbouring call's reactions into this recording's activity. */
export function recordingReactions(row: InitiativeRecording, reactions: readonly RecordedReaction[]): RecordedReaction[] {
  const start = Date.parse(row.startedAt), end = Date.parse(row.endedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return [...new Map(reactions.filter(event => {
    const at = Date.parse(event.at);
    return event.lobbyName === row.lobbyName && typeof event.emoji === 'string' && at >= start && at <= end;
  }).map(event => [event.reactionId, event])).values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** The shared recording list owns dates, media duration, participants and status. */
export function initiativeRecordingItems(rows: readonly InitiativeRecording[], projectName: string): RecordingListItem[] {
  return rows.map(row => ({
    id: row.recordingId, startIso: row.startedAt, endIso: row.endedAt ?? '',
    durationSec: Math.max(0, (row.durationMs ?? 0) / 1000),
    participantCount: row.participantCount ?? row.participants?.length ?? 0,
    label: `${projectName} huddle`,
    status: row.composeStatus === 'failed' || row.composeStatus === 'skipped' ? 'failed'
      : row.composeStatus === 'ok' || row.composeStatus === 'degraded' ? 'ready' : 'processing',
  }));
}

/** Same recorded-time mapping as realtime-examples/usePlaybackReactions. */
export function timedRecordingReactions(row: InitiativeRecording, reactions: readonly RecordedReaction[]): TimedReaction[] {
  const startedAt = Date.parse(row.startedAt);
  return recordingReactions(row, reactions).map(event => ({
    id: event.reactionId, emoji: event.emoji, offsetMs: Math.max(0, Date.parse(event.at) - startedAt),
    ...(event.displayName ? { displayName: event.displayName } : {}),
  }));
}
