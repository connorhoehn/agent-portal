// Work context adapter over the existing platform-api recording index,
// playback-token and captured-reaction routes used by realtime-examples.
// useLVSRecordings is a raw channel-ARN listing, not the participant index;
// it cannot replace this authorization path. The installed SDK has no
// participant-index client. Storage, capture, compose and permissions remain
// in platform-api/LVS; this adapter only adds initiative filtering and paging.
import type { LVSRecording } from '@connorhoehnslalom/realtime-modules/client/video';
import type { RecordingListItem, TimedReaction, TranscriptSegment } from '@connorhoehnslalom/ui-components/video';
import { realtimeEndpoints, realtimeTokenSource, type RealtimeTokenSource } from '../../lib/realtimeToken.ts';

export interface InitiativeRecording extends Pick<LVSRecording, 'recordingId' | 'startedAt'>,
  Partial<Pick<LVSRecording, 'endedAt' | 'durationMs' | 'participants'>> {
  lobbyName: string;
  callId?: string;
  participantCount?: number;
  composeStatus?: string;
  stage?: string;
  transcriptionRequested?: boolean;
  transcriptStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  summaryStatus?: 'pending' | 'processing' | 'ready' | 'failed' | 'skipped';
  transcriptError?: string | null;
  summaryError?: string | null;
  transcriptGeneratedAt?: string;
  summaryRunId?: string;
  processingAttemptId?: string;
  /** Server-verified host association, never decoded from a lobby hash. */
  artifactContext?: { tenant: string; initiativeId?: string; teamId?: string; documentSourceId?: string };
}
export interface RecordingPage { items: InitiativeRecording[]; cursor: string | null }
export interface RecordingPlayback { mediaState: string; composedUrl?: string | null; playlistUrl?: string | null; token?: string | null }
/** Native playback may return an already-authorized URL or a separate token.
 * Preserve signed queries and never substitute a live URL for missing media. */
export function recordingPlaybackUrl(value: RecordingPlayback | null): string | null {
  const raw = value?.composedUrl ?? value?.playlistUrl;
  if (!raw || !/^https?:\/\//.test(raw)) return null;
  try { const url = new URL(raw); if (value?.token && !url.searchParams.has('token')) url.searchParams.set('token', value.token); return url.href; }
  catch { return null; }
}
export interface RecordedReaction { reactionId: string; lobbyName: string; userId?: string | null; displayName?: string; emoji: string; at: string }
export interface RecordingProgress { status: 'pending' | 'processing' | 'failed' | 'stalled' | 'unavailable'; terminal: boolean; retryAfterMs: number | null; error?: string | null }
export type RecordingTranscript = { status: 'ready'; segments: TranscriptSegment[] } | RecordingProgress;
export type RecordingSummary = { status: 'ready'; markdown: string } | RecordingProgress | { status: 'skipped'; terminal: true; retryAfterMs: null };

function progress(body: Record<string, unknown>, response: Response): RecordingProgress {
  const status = ['pending', 'processing', 'failed', 'stalled'].includes(String(body.status)) ? body.status as RecordingProgress['status'] : 'unavailable';
  const terminal = body.terminal === true || ['failed', 'stalled', 'unavailable'].includes(status);
  const requested = typeof body.retryAfterMs === 'number' ? body.retryAfterMs : Number(response.headers.get('Retry-After')) * 1000;
  return { status, terminal, retryAfterMs: terminal ? null : Math.max(5000, Math.min(60000, requested || 5000)), ...(typeof body.error === 'string' ? { error: body.error } : {}) };
}

export function createInitiativeRecordingsClient(options: {
  source?: Pick<RealtimeTokenSource, 'get'>;
  fetchImpl?: typeof fetch;
  platformApiUrl?: string;
  scopeLabel?: string;
  documentSourceId?: string;
} = {}) {
  const source = options.source ?? realtimeTokenSource;
  const doFetch = options.fetchImpl ?? fetch;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  async function response(path: string, signal: AbortSignal, method = 'GET'): Promise<Response> {
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
      return res;
    }
    throw new Error('Your session could not authorize this recording.');
  }
  async function request<T>(path: string, signal: AbortSignal, method = 'GET'): Promise<T> {
    const body = await (await response(path, signal, method)).json() as T;
    signal.throwIfAborted();
    return body;
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
      if (row.recordingId !== id || row.lobbyName !== lobby) throw new Error(`This recording is not part of this ${options.scopeLabel ?? 'initiative'}.`);
      if (options.documentSourceId && (row.artifactContext?.tenant !== 'assessment' || row.artifactContext.documentSourceId !== options.documentSourceId)) throw new Error('This recording could not be associated with this exact source document.');
      return row;
    },
    playback: (id: string, signal: AbortSignal) => request<RecordingPlayback>(`/api/recordings/${encodeURIComponent(id)}/playback-token`, signal, 'POST'),
    async transcript(id: string, signal: AbortSignal): Promise<RecordingTranscript> {
      const res = await response(`/api/recordings/${encodeURIComponent(id)}/transcript`, signal);
      const body = await res.json() as Record<string, unknown>; signal.throwIfAborted();
      if (res.status === 202) return progress(body, res);
      if (!Array.isArray(body.segments) || body.segments.some(segment => !segment || typeof segment.text !== 'string' || !Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs))) throw new Error('The saved transcript response is invalid.');
      return { status: 'ready', segments: body.segments as TranscriptSegment[] };
    },
    async summary(id: string, signal: AbortSignal, knownStatus?: InitiativeRecording['summaryStatus']): Promise<RecordingSummary> {
      const res = await response(`/api/recordings/${encodeURIComponent(id)}/summary`, signal);
      if (res.status === 202) { const body = await res.json() as Record<string, unknown>; signal.throwIfAborted(); return progress(body, res); }
      const status = res.headers.get('X-Summary-Status') ?? knownStatus;
      const markdown = await res.text(); signal.throwIfAborted();
      if (status === 'pending' || status === 'processing' || status === 'failed') return progress({ status, terminal: status === 'failed' }, res);
      if (status === 'skipped' || status === 'none') return { status: 'skipped', terminal: true, retryAfterMs: null };
      if (status !== 'ready') return { status: 'unavailable', terminal: true, retryAfterMs: null };
      return { status: 'ready', markdown };
    },
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

/** Exact ended-call association. A neighbouring/latest lobby recording is never a substitute. */
export async function recordingForCall(client: Pick<InitiativeRecordingsClient, 'page'>, callId: string, lobby: string, signal: AbortSignal): Promise<InitiativeRecording | null> {
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 5; page++) {
    signal.throwIfAborted();
    const result = await client.page(cursor, signal);
    signal.throwIfAborted();
    const row = result.items.find(item => item.callId === callId && item.lobbyName === lobby);
    if (row) return row;
    if (!result.cursor) return null;
    if (seen.has(result.cursor)) throw new Error('The recording list could not advance. Try refreshing.');
    seen.add(result.cursor); cursor = result.cursor;
  }
  return null;
}

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
