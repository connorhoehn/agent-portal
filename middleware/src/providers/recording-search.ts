// Recording search is a bounded, current-user projection of native artifacts.
// Nothing is copied into the shared knowledge corpus or retained between reads.
import { AppError } from '../lib/async-handler.js';
import type { PrincipalRef } from '../lib/authz.js';
import { admitLobbyRead } from '../lib/gateway/authority.js';
import { currentLiveSession, sessionGatewayContext } from '../lib/live-principal.js';
import { realtimeClaims, realtimeSigningSecret, signRealtimeToken } from '../lib/realtime-token.js';
import type { Session } from '../lib/session.js';
import { speechSegments } from '../lib/recording-transcript.js';
import { getProject } from './projects.js';
import type { SearchRecord } from './search.js';

const PAGE_SIZE = 40;
const MAX_PAGES = 3;
const MAX_ARTIFACTS = 20;
const MAX_BODY_BYTES = 512 * 1024;
export const RECORDING_READ_BUDGET_MS = 8_000;
const READ_BUDGET_MS = RECORDING_READ_BUDGET_MS;
interface NativeRecording {
  recordingId: string; lobbyName: string; startedAt: string; endedAt?: string; expiresAt?: string | null; ttl?: number;
  transcriptStatus?: string; summaryStatus?: string; summaryRunId?: string; summaryMarkdown?: string; processingAttemptId?: string;
  summaryStatusAt?: string; summaryGeneratedAt?: string; transcriptStatusAt?: string; transcriptGeneratedAt?: string; stage?: string;
}
export interface RecordingSearchRecord extends SearchRecord { searchText?: string }
export interface RecordingSearchProjection { records: RecordingSearchRecord[]; partial: string[] }

function sessionOf(principal: PrincipalRef, tenant: 'orgiq' | 'assessment' = 'orgiq'): Session {
  const s = principal as Partial<Session>;
  // A bare policy principal is not authority to mint a native user token.
  if (!s.grants || !Number.isFinite(s.iat) || s.tenant !== tenant) throw new AppError(503, 'Recording search requires the signed host tenant session');
  return s as Session;
}
export function recordingPlatformUrl(): string | null {
  const value = process.env['DOCUMENT_PLATFORM_INTERNAL_URL'] || process.env['PLATFORM_API_URL'] || process.env['SOCIAL_PLATFORM_INTERNAL_URL'];
  return value ? value.replace(/\/+$/, '') : null;
}
async function request(session: Session, path: string, deadline: number): Promise<Response> {
  const base = recordingPlatformUrl(), secret = realtimeSigningSecret();
  if (!base || !secret) throw new AppError(503, 'Native recording search is unavailable');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AppError(504, 'Native recording search read window expired');
  const { token } = await signRealtimeToken(realtimeClaims(session), secret);
  try {
    const res = await fetch(`${base}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json, text/markdown' }, signal: AbortSignal.timeout(remaining) });
    if (!res.ok) throw new AppError(res.status >= 500 ? 502 : res.status, 'Native recording read unavailable');
    return res;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'Native recording read unavailable');
  }
}
async function body(res: Response): Promise<string> {
  const declaredLength = Number(res.headers.get('Content-Length'));
  if (declaredLength > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw new AppError(502, 'Native recording response is too large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AppError(502, 'Native recording response is too large');
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'Native recording response is unavailable');
  } finally { reader.releaseLock(); }
}
async function json<T>(session: Session, path: string, deadline: number): Promise<T> { return JSON.parse(await body(await request(session, path, deadline))) as T; }
const initiativeId = (lobby: unknown): string | null => typeof lobby === 'string' ? /^orgiq:initiative:([^:\s]{1,200})$/.exec(lobby)?.[1] ?? null : null;
const assessmentTeamId = (lobby: unknown): string | null => typeof lobby === 'string' ? /^assessment:team:(TEAM-[A-Za-z0-9-]{1,120})$/.exec(lobby)?.[1] ?? null : null;
const subjectId = (session: Session, lobby: unknown): string | null => session.tenant === 'orgiq' ? initiativeId(lobby) : assessmentTeamId(lobby);
function expired(row: NativeRecording): boolean {
  if (row.expiresAt != null) {
    const expires = typeof row.expiresAt === 'string' ? Date.parse(row.expiresAt) : NaN;
    return !Number.isFinite(expires) || expires <= Date.now();
  }
  if (row.ttl !== undefined) return typeof row.ttl !== 'number' || !Number.isFinite(row.ttl) || row.ttl * 1000 <= Date.now();
  return false;
}
function revision(row: NativeRecording): string {
  return JSON.stringify([row.transcriptStatus, row.summaryStatus, row.summaryRunId, row.processingAttemptId, row.transcriptStatusAt, row.transcriptGeneratedAt, row.summaryStatusAt, row.summaryGeneratedAt, row.summaryStatus === undefined ? row.summaryMarkdown : undefined]);
}
async function authorizedRecord(session: Session, id: string, deadline: number, scope?: string): Promise<RecordingSearchRecord | null> {
  const path = `/api/recordings/${encodeURIComponent(id)}`;
  // This exact-id native read proves the participant index, independently of
  // page access. Never derive participation from the visible participants array.
  const row = await json<NativeRecording>(session, path, deadline);
  const targetId = subjectId(session, row.lobbyName);
  if (row.recordingId !== id || !targetId || (scope && scope !== targetId) || expired(row)) return null;
  const context = sessionGatewayContext(session);
  if (await admitLobbyRead(context, row.lobbyName) !== 'ok') return null;
  let title: string;
  if (session.tenant === 'orgiq') {
    const project = await getProject(targetId); if (!project) return null; title = project.name;
  } else {
    const { getTeamDetail } = await import('./assessment.js');
    const detail = await getTeamDetail(targetId);
    if (!detail || detail.team.id !== targetId) return null;
    title = detail.team.name;
  }
  const artifacts: string[] = [];
  if (row.transcriptStatus === 'ready') {
    const response = await request(session, `${path}/transcript`, deadline);
    if (response.status !== 200) throw new AppError(502, 'Native transcript is no longer ready');
    const doc = JSON.parse(await body(response)) as { segments?: Parameters<typeof speechSegments>[0] };
    if (!Array.isArray(doc.segments)) throw new AppError(502, 'Native transcript shape unavailable');
    artifacts.push(speechSegments(doc.segments).map(s => `${s.speaker}: ${s.text}`).join('\n'));
  }
  const summaryReady = row.summaryStatus === 'ready' || (row.summaryStatus === undefined && !!row.summaryMarkdown);
  if (summaryReady) {
    const response = await request(session, `${path}/summary`, deadline);
    // 200 explanatory failure/empty placeholders are not summaries.
    if (response.status !== 200 || response.headers.get('X-Summary-Status') !== 'ready') throw new AppError(502, 'Native summary is no longer ready');
    artifacts.push(await body(response));
  }
  // Revocation, deletion, retry or artifact replacement during the reads must
  // not leave stale text in results. Ask both native participation and host
  // authority again; there is no positive cache.
  const latest = await json<NativeRecording>(session, path, deadline);
  if (latest.recordingId !== id || latest.lobbyName !== row.lobbyName || expired(latest) || revision(latest) !== revision(row)
    || await admitLobbyRead(context, row.lobbyName) !== 'ok') return null;
  const text = artifacts.filter(Boolean).join('\n\n');
  const date = Number.isFinite(Date.parse(row.startedAt)) ? new Date(row.startedAt).toISOString().slice(0, 10) : '';
  return { type: 'recording', id, title: `${title} huddle${date ? ` · ${date}` : ''}`,
    description: text ? text.slice(0, 1200) : undefined, searchText: text,
    subtitle: ['Recording', row.transcriptStatus === 'ready' ? 'Transcript' : undefined, summaryReady ? 'Summary' : undefined].filter(Boolean).join(' · '),
    status: row.stage ?? row.transcriptStatus ?? 'saved', updatedAt: row.transcriptGeneratedAt ?? row.endedAt ?? row.startedAt,
    href: session.tenant === 'orgiq' ? `/iq/projects/${encodeURIComponent(targetId)}?tab=docs&recording=${encodeURIComponent(id)}`
      : `/assessment/teams/${encodeURIComponent(targetId)}?tab=documents&recording=${encodeURIComponent(id)}`,
    ...(session.tenant === 'orgiq' ? { sourceRefs: [{ type: 'initiative' as const, id: targetId }] } : {}) };
}
const hidden = (error: unknown): boolean => error instanceof AppError && [403, 404, 410].includes(error.status);

export async function resolveRecordingSearchRecord(principal: PrincipalRef, id: string, scope?: string, tenant: 'orgiq' | 'assessment' = 'orgiq', deadline = Date.now() + READ_BUDGET_MS): Promise<RecordingSearchRecord | null> {
  const session = await currentLiveSession(sessionOf(principal, tenant));
  try {
    const record = await authorizedRecord(session, id, Math.min(deadline, Date.now() + READ_BUDGET_MS), scope);
    await currentLiveSession(session);
    if (!record) return null;
    const { searchText: _private, ...publicRecord } = record;
    return publicRecord;
  } catch (error) { if (hidden(error)) return null; throw error; }
}

export async function listRecordingSearchRecords(principal: PrincipalRef, scope?: string, tenant: 'orgiq' | 'assessment' = 'orgiq'): Promise<RecordingSearchProjection> {
  if (!recordingPlatformUrl()) return { records: [], partial: ['Recordings unavailable'] };
  const session = await currentLiveSession(sessionOf(principal, tenant));
  const deadline = Date.now() + READ_BUDGET_MS;
  const partial: string[] = [];
  const ids = new Set<string>();
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response: { items?: NativeRecording[]; cursor?: string | null } = await json(session, `/api/recordings?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, deadline);
    if (!Array.isArray(response.items)) throw new AppError(502, 'Native recording list shape unavailable');
    response.items.forEach(row => {
      const target = subjectId(session, row.lobbyName);
      if (target && (!scope || scope === target) && !expired(row) && typeof row.recordingId === 'string' && row.recordingId) ids.add(row.recordingId);
    });
    cursor = typeof response.cursor === 'string' && response.cursor ? response.cursor : null;
    if (!cursor) break;
    if (seenCursors.has(cursor)) throw new AppError(502, 'Native recording cursor did not advance');
    seenCursors.add(cursor);
  }
  if (cursor || ids.size > MAX_ARTIFACTS) partial.push('Recordings source window is limited');
  const pending = [...ids].slice(0, MAX_ARTIFACTS);
  const records: RecordingSearchRecord[] = [];
  // At most four artifact reads run together; native DDB/HTTP own the data.
  for (let offset = 0; offset < pending.length; offset += 4) {
    if (Date.now() >= deadline) { partial.push('Recording artifacts read window is limited'); break; }
    await Promise.all(pending.slice(offset, offset + 4).map(async id => {
      try { const record = await authorizedRecord(session, id, deadline, scope); if (record) records.push(record); }
      catch (error) { if (!hidden(error)) partial.push('Recording artifacts unavailable'); }
    }));
  }
  // Invalidate the entire projection if signed authority expired mid-request.
  await currentLiveSession(session);
  return { records, partial: [...new Set(partial)] };
}
