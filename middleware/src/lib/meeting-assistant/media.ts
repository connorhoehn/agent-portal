// Arming the media server's per-participant tap for a listening call (docs/meeting-assistant-design.md, package 6a).
//
//   invite / resume  ──► preflight: the three settings are present and the call's channel can be found   (503 and nothing started when not)
//                    ──► a fresh sink token, a tap created for the channel pointing at <sink base>/api/internal/meeting-assistant/pcm/<token>
//   pause / leave / ceiling / call end  ──► the token dies (audio-intake.ts) and the tap is deleted
//
// THE CHANNEL IS THE SERVER'S. It is looked up from the call's own lobby, which the server read from its call store, through
// platform-api's `GET /api/video/sessions/by-lobby/:lobbyName` with the asking person's own realtime token (platform-api lets
// only people who may use the lobby see its channel). Nothing in a request body or header from a browser is ever used for it.
//
// The media server's tap API (live-video-streaming `POST|GET /api/channels/:arn/taps`, `DELETE .../taps/:id`) is called directly
// with the admin token, the way platform-api's captions arming does. The tap never retries and never reads our answer, so
// everything on this side is about making the tap exist: create, and on `409 no audio producer in channel` (nobody has published
// audio yet) try again with a growing pause for up to a minute, then say so in the call chat.
//
// Secrets: the admin token and the sink token never appear in a log line, an error or a chat notice.
import { config } from '../../config.js';
import { AppError } from '../async-handler.js';
import type { Session } from '../session.js';
import { platformBearer, socialPlatformUrl } from '../../providers/social-platform.js';
import { postNoticeQuietly } from './chat.js';
import { ASSISTANT_NAME, CANNOT_HEAR_NOTICE } from './chat-types.js';
import { mockTranscriptEnabled } from './transcript-source.js';
import { SINK_SECRET_SETTING, sinkSecretUsable } from './sink-secret.js';
import type { AudioIntake } from './audio-intake.js';
import { assistantAudio } from './audio-select.js';

export const SINK_PATH = '/api/internal/meeting-assistant/pcm/';
export const TAP_GIVE_UP_MS = 60_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];
/** After the give-up notice, arming is tried again this often for as long as the call is still being listened to. */
export const TAP_REARM_MS = 30_000;
/** A tap delete that failed is tried again after each of these waits; after that, on every later arm or disarm for the call. */
const DELETE_RETRY_MS = [1000, 3000, 9000];
const MAX_PENDING_DELETES_PER_CALL = 20;
/** What a person reads when Milo cannot be started here at all (the missing settings go to the server log, never to them). */
export const NOT_SET_UP = `${ASSISTANT_NAME} isn't set up here. Ask an admin.`;
/** The call has no audio to listen to yet: trying again once someone's microphone is on helps. */
export const NO_AUDIO_YET = `${ASSISTANT_NAME} can join once someone in the call has their microphone on.`;
export { CANNOT_HEAR_NOTICE };

export interface MediaConfig { url: string; adminToken: string; sinkBaseUrl: string }

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
/** The three settings, or null when any is missing or malformed. Read per call so tests can change them. */
export function mediaConfig(): MediaConfig | null {
  const m = (config as { meetingAssistant?: { media?: Partial<MediaConfig> } }).meetingAssistant?.media;
  const url = clean(m?.url).replace(/\/+$/, ''), adminToken = clean(m?.adminToken), sinkBaseUrl = clean(m?.sinkBaseUrl).replace(/\/+$/, '');
  if (!url || !adminToken || !sinkBaseUrl) return null;
  for (const u of [url, sinkBaseUrl]) {
    try { const p = new URL(u); if ((p.protocol !== 'http:' && p.protocol !== 'https:') || p.username || p.password) return null; } catch { return null; }
  }
  return { url, adminToken, sinkBaseUrl };
}

/** Which of the three is missing, for a plain 503 (names settings, never values). */
export function missingMediaSettings(): string[] {
  const m = (config as { meetingAssistant?: { media?: Partial<MediaConfig> } }).meetingAssistant?.media;
  const out: string[] = [];
  if (!clean(m?.url)) out.push('MEETING_ASSISTANT_MEDIA_URL');
  if (!clean(m?.adminToken)) out.push('MEETING_ASSISTANT_MEDIA_ADMIN_TOKEN');
  if (!clean(m?.sinkBaseUrl)) out.push('MEETING_ASSISTANT_SINK_BASE_URL');
  return out.length ? out : (mediaConfig() ? [] : ['MEETING_ASSISTANT_MEDIA_URL or MEETING_ASSISTANT_SINK_BASE_URL (not a plain http(s) address)']);
}

export { liveForced } from './live-flag.js';
import { liveForced } from './live-flag.js';

// ---------------------------------------------------------------------------------------------------------------------
// The media server's tap API

export interface TapInfo { tapId: string; url: string }
export type CreateOutcome = { kind: 'created'; tapId: string } | { kind: 'no-audio' } | { kind: 'refused'; status: number } | { kind: 'error' };

export interface MediaClient {
  list(channelArn: string): Promise<TapInfo[] | null>;
  create(channelArn: string, sinkUrl: string): Promise<CreateOutcome>;
  delete(channelArn: string, tapId: string): Promise<'removed' | 'failed'>;
}

type FetchLike = typeof fetch;

export class DirectMediaClient implements MediaClient {
  constructor(private readonly cfg: () => MediaConfig | null, private readonly fetchImpl: FetchLike = fetch, private readonly timeoutMs = 8000) {}

  private tapsUrl(channelArn: string): string | null {
    const c = this.cfg();
    return c ? `${c.url}/api/channels/${encodeURIComponent(channelArn)}/taps` : null;
  }
  private auth(): Record<string, string> { const c = this.cfg(); return c ? { Authorization: `Bearer ${c.adminToken}` } : {}; }

  async list(channelArn: string): Promise<TapInfo[] | null> {
    const url = this.tapsUrl(channelArn);
    if (!url) return null;
    try {
      const res = await this.fetchImpl(url, { headers: this.auth(), signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return null;
      const body = await res.json() as unknown;
      const rows = Array.isArray(body) ? body : (body as { taps?: unknown[] } | null)?.taps ?? [];
      return rows.flatMap((t) => {
        const tap = t as { tapId?: unknown; id?: unknown; destination?: { url?: unknown } } | null;
        const id = typeof tap?.tapId === 'string' ? tap.tapId : typeof tap?.id === 'string' ? tap.id : '';
        const u = typeof tap?.destination?.url === 'string' ? tap.destination.url : '';
        return id ? [{ tapId: id, url: u }] : [];
      });
    } catch { return null; }
  }

  async create(channelArn: string, sinkUrl: string): Promise<CreateOutcome> {
    const url = this.tapsUrl(channelArn);
    if (!url) return { kind: 'refused', status: 0 };
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST', headers: { ...this.auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: { type: 'webhook-pcm', url: sinkUrl, chunkMs: 200, perParticipant: true } }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({})) as { tapId?: unknown; id?: unknown };
        const id = typeof body.tapId === 'string' ? body.tapId : typeof body.id === 'string' ? body.id : '';
        return id ? { kind: 'created', tapId: id } : { kind: 'error' };
      }
      const text = await res.text().catch(() => '');
      if (res.status === 409 && /no audio producer/i.test(text)) return { kind: 'no-audio' };
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return { kind: 'refused', status: res.status };
      return { kind: 'error' };
    } catch { return { kind: 'error' }; }
  }

  async delete(channelArn: string, tapId: string): Promise<'removed' | 'failed'> {
    const url = this.tapsUrl(channelArn);
    if (!url) return 'failed';
    try {
      const res = await this.fetchImpl(`${url}/${encodeURIComponent(tapId)}`, { method: 'DELETE', headers: this.auth(), signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok || res.status === 404 ? 'removed' : 'failed';
    } catch { return 'failed'; }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Which channel a call is on

export interface ChannelResolver {
  /** The media channel of the call whose lobby the server read from its own call store; null when the call has no live media session. */
  channelOf(session: Session, callId: string, lobby: string): Promise<string | null>;
}

/** platform-api's lookup of the active video session for a lobby, asked as the person who is inviting or resuming. */
export class PlatformChannelResolver implements ChannelResolver {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}
  async channelOf(session: Session, _callId: string, lobby: string): Promise<string | null> {
    const base = socialPlatformUrl();
    if (!base) return null;
    try {
      const res = await this.fetchImpl(`${base}/api/video/sessions/by-lobby/${encodeURIComponent(lobby)}`, {
        headers: { Authorization: `Bearer ${await platformBearer(session)}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const body = await res.json() as { live?: unknown; channelArn?: unknown };
      return body.live === true && typeof body.channelArn === 'string' && body.channelArn.length > 0 && body.channelArn.length < 512 ? body.channelArn : null;
    } catch { return null; }
  }
}

/** The mock world has no media server: a call's "channel" is a name the tap simulator is told. Mock world only, never production. */
export class MockChannelResolver implements ChannelResolver {
  async channelOf(_session: Session, callId: string): Promise<string | null> { return `mock-channel:${callId}`; }
}

let resolverOverride: ChannelResolver | null = null;
export function setChannelResolver(next: ChannelResolver | null): void { resolverOverride = next; }
export function channelResolver(): ChannelResolver {
  if (resolverOverride) return resolverOverride;
  return mockTranscriptEnabled() && !socialPlatformUrl() ? new MockChannelResolver() : new PlatformChannelResolver();
}

// ---------------------------------------------------------------------------------------------------------------------
// Arming

/** Is real audio part of this process's session path? Not in the plain mock world (the scripted session hears no audio). */
export function realAudioPath(): boolean { return !mockTranscriptEnabled() || liveForced(); }

export interface Preflight { channelArn: string; arm: boolean }

/**
 * Before anything starts: can this call be listened to with real audio? Throws a 503 with a plain reason when not; otherwise
 * says which channel, and whether a tap is to be armed (the mock world with the forced-live flag and no media settings has no
 * media server, so the tap simulator stands in for it and nothing is armed).
 */
export async function preflightAudio(session: Session, callId: string, lobby: string): Promise<Preflight | null> {
  if (!realAudioPath()) return null;
  const media = mediaConfig();
  if (!media) {
    if (mockTranscriptEnabled()) return { channelArn: (await new MockChannelResolver().channelOf(session, callId)) ?? '', arm: false };
    console.warn(`[meeting-assistant] live listening is not configured (missing ${missingMediaSettings().join(', ')})`);
    throw new AppError(503, NOT_SET_UP);
  }
  if (!sinkSecretUsable()) {
    console.warn(`[meeting-assistant] live listening is not configured (missing ${SINK_SECRET_SETTING})`);
    throw new AppError(503, NOT_SET_UP);
  }
  const channelArn = await channelResolver().channelOf(session, callId, lobby);
  if (!channelArn) throw new AppError(503, NO_AUDIO_YET);
  return { channelArn, arm: true };
}

interface ArmedTaps { channelArn: string; generation: number; tapIds: Set<string>; sinkUrl: string; noticed: boolean }
interface PendingDelete { channelArn: string; tapId: string }

export interface TapArmerOptions {
  client?: MediaClient;
  config?: () => MediaConfig | null;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  notify?: (callId: string, text: string) => Promise<void>;
  audio?: () => AudioIntake;
  giveUpMs?: number;
}

export class TapArmer {
  private readonly calls = new Map<string, ArmedTaps>();
  private readonly client: MediaClient;
  private readonly cfg: () => MediaConfig | null;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly notify: (callId: string, text: string) => Promise<void>;
  private readonly audio: () => AudioIntake;
  private readonly giveUpMs: number;
  private gen = 0;
  private readonly localTokens = new Map<string, string>();
  /** Taps whose delete failed, by call: a tap left behind keeps posting audio, so each is kept until the media server says it is gone. */
  private readonly pendingDeletes = new Map<string, PendingDelete[]>();
  /** Tap work in flight, so a caller (a test, a shutdown) can wait for it. */
  readonly inFlight = new Set<Promise<void>>();

  constructor(opts: TapArmerOptions = {}) {
    this.cfg = opts.config ?? mediaConfig;
    this.client = opts.client ?? new DirectMediaClient(this.cfg);
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
    this.notify = opts.notify ?? ((callId, text) => postNoticeQuietly(callId, text));
    this.audio = opts.audio ?? assistantAudio;
    this.giveUpMs = opts.giveUpMs ?? TAP_GIVE_UP_MS;
    // Every way a call stops listening (pause, leave, ceiling, call end) kills its token; the tap goes with it.
    this.audio().onDead((callId) => { void this.disarm(callId); });
  }

  /**
   * A fresh token for the call's channel, and the tap that carries audio to it, created in the background (the invite does not
   * wait for the media server). The audio side is armed first, so the moment the tap exists its chunks are accepted.
   */
  async arm(callId: string, channelArn: string, opts: { told?: boolean } = {}): Promise<void> {
    const cfg = this.cfg();
    // A tap that posts audio to an unsecured sink must never be created (audit B4): no secret, no tap, outside dev mode.
    if (cfg && !sinkSecretUsable()) throw new AppError(503, `Live listening is not configured for this deployment (missing ${SINK_SECRET_SETTING})`);
    if (!cfg) {
      // No media server in the picture: only the mock world's tap simulator stands in for it, and it is told the token through the dev route.
      if (!mockTranscriptEnabled()) return;
      this.localTokens.set(callId, await this.audio().arm(callId, channelArn));
      return;
    }
    this.release(callId);
    this.retryPending(callId);
    const token = await this.audio().arm(callId, channelArn);
    // A call armed against a real media server never has its token kept for the dev route: only the simulator-only path above does.
    const sinkUrl = `${cfg.sinkBaseUrl}${SINK_PATH}${token}`;
    const state: ArmedTaps = { channelArn, generation: (this.gen += 1), tapIds: new Set(), sinkUrl, noticed: opts.told === true };
    this.calls.set(callId, state);
    const job = this.createWithRetry(callId, state).catch((e: unknown) => console.warn('[meeting-assistant] tap arming failed', (e as Error).message)).finally(() => { this.inFlight.delete(job); });
    this.inFlight.add(job);
  }

  /**
   * The orchestrator's deaf watchdog heard no audio for a minute while people are seated: arm the call's channel again (a fresh token
   * and tap, through `arm`). The call was told by the watchdog, so this arming starts as one past its one-minute give-up: no second
   * notice, the state view says `no-audio` until the tap exists, and arming goes on slowly. False when this process has not armed the
   * call against a media server (nothing to arm again).
   */
  async rearm(callId: string): Promise<boolean> {
    const state = this.calls.get(callId);
    if (!state) return false;
    await this.arm(callId, state.channelArn, { told: true });
    return true;
  }

  /**
   * Read-only, for the state view: whether the call's audio reaches Milo. `ok` once a tap exists, or when no media server is in the
   * picture (the mock world); `connecting` while the tap is being made; `no-audio` after the give-up notice was said.
   */
  hearing(callId: string): 'ok' | 'connecting' | 'no-audio' {
    const state = this.calls.get(callId);
    if (!state || state.tapIds.size > 0) return 'ok';
    return state.noticed ? 'no-audio' : 'connecting';
  }

  private current(callId: string, state: ArmedTaps): boolean { return this.calls.get(callId) === state; }

  private async createWithRetry(callId: string, state: ArmedTaps): Promise<void> {
    const started = this.clock();
    // A tap an earlier process or token left behind posts to a dead token for ever: remove ours, reuse one that already has this exact target.
    const existing = await this.client.list(state.channelArn);
    if (existing) {
      for (const tap of existing) {
        if (!this.current(callId, state)) return;
        if (tap.url === state.sinkUrl) { state.tapIds.add(tap.tapId); return; }
        if (this.isOurs(tap.url)) await this.deleteTap(callId, state.channelArn, tap.tapId);
      }
    }
    for (let attempt = 0; this.current(callId, state); attempt += 1) {
      const out = await this.client.create(state.channelArn, state.sinkUrl);
      if (!this.current(callId, state)) {
        // Disarmed while the request was out: a tap that came into being anyway must not outlive the call.
        if (out.kind === 'created') await this.deleteTap(callId, state.channelArn, out.tapId);
        return;
      }
      if (out.kind === 'created') { state.tapIds.add(out.tapId); return; }
      if (out.kind === 'refused') {
        console.warn(`[meeting-assistant] the media server refused the tap (HTTP ${out.status})`);
        await this.giveUp(callId, state); return;
      }
      // After the one-minute give-up the notice is said once and arming goes on slowly: a producer that appears later is still heard.
      if (!state.noticed && this.clock() - started >= this.giveUpMs) await this.giveUp(callId, state);
      await this.sleep(state.noticed ? TAP_REARM_MS : BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
    }
  }

  private isOurs(url: string): boolean {
    const cfg = this.cfg();
    return !!cfg && url.startsWith(`${cfg.sinkBaseUrl}${SINK_PATH}`);
  }

  private async giveUp(callId: string, state: ArmedTaps): Promise<void> {
    if (!this.current(callId, state) || state.noticed) return;
    state.noticed = true;
    await this.notify(callId, CANNOT_HEAR_NOTICE).catch(() => undefined);
  }

  /** The call's taps are deleted (the token is already dead: audio-intake calls this when it dies). Best effort, never throws. */
  async disarm(callId: string): Promise<void> {
    this.localTokens.delete(callId);
    const state = this.calls.get(callId);
    if (state) {
      this.calls.delete(callId);
      for (const id of [...state.tapIds]) await this.deleteTap(callId, state.channelArn, id);
    }
    // Earlier deletes of this call that failed are tried again on every disarm, with or without a tap of the current arming.
    this.retryPending(callId);
  }

  /** Forget a call's earlier arming without deleting in the foreground (a new arming follows and clears stale taps by their target). */
  private release(callId: string): void {
    const state = this.calls.get(callId);
    if (!state) return;
    this.calls.delete(callId);
    for (const id of state.tapIds) void this.deleteTap(callId, state.channelArn, id);
  }

  /** One delete attempt. A failure is recorded and retried in the background (1, 3 and 9 s), then on each later arm or disarm of the call. */
  private async deleteTap(callId: string, channelArn: string, tapId: string): Promise<void> {
    const out = await this.client.delete(channelArn, tapId).catch(() => 'failed' as const);
    if (out === 'removed') { this.forgetPending(callId, tapId); return; }
    const list = this.pendingDeletes.get(callId) ?? [];
    if (!list.some((p) => p.tapId === tapId && p.channelArn === channelArn) && list.length < MAX_PENDING_DELETES_PER_CALL) list.push({ channelArn, tapId });
    this.pendingDeletes.set(callId, list);
    this.retryPending(callId);
  }

  private forgetPending(callId: string, tapId: string): void {
    const list = this.pendingDeletes.get(callId)?.filter((p) => p.tapId !== tapId);
    if (list?.length) this.pendingDeletes.set(callId, list); else this.pendingDeletes.delete(callId);
  }

  private readonly retrying = new Set<string>();
  /** Start the timed retries for a call's failed deletes (one runner per call). */
  private retryPending(callId: string): void {
    if (!this.pendingDeletes.get(callId)?.length || this.retrying.has(callId)) return;
    this.retrying.add(callId);
    const job = (async () => {
      try {
        for (const wait of DELETE_RETRY_MS) {
          await this.sleep(wait);
          for (const p of [...(this.pendingDeletes.get(callId) ?? [])]) {
            if ((await this.client.delete(p.channelArn, p.tapId).catch(() => 'failed' as const)) === 'removed') this.forgetPending(callId, p.tapId);
          }
          if (!this.pendingDeletes.get(callId)?.length) return;
        }
      } finally { this.retrying.delete(callId); }
    })().finally(() => { this.inFlight.delete(job); });
    this.inFlight.add(job);
  }

  /** Taps whose delete has not yet been confirmed (for tests and the status line). */
  pendingDeleteCount(callId: string): number { return this.pendingDeletes.get(callId)?.length ?? 0; }

  /**
   * Delete every tap on `channelArn` that points at THIS server's sink (a tap an earlier process left behind posts to a token that no
   * longer exists). True when the channel was listed and every such tap is gone; false (nothing thrown) when the media server could not be
   * asked or a delete failed, so the caller retries on the next boot.
   */
  async deleteStale(channelArn: string): Promise<boolean> {
    if (!this.cfg()) return false;
    const taps = await this.client.list(channelArn).catch(() => null);
    if (!taps) return false;
    let ok = true;
    for (const tap of taps) {
      if (!this.isOurs(tap.url)) continue;
      if ((await this.client.delete(channelArn, tap.tapId).catch(() => 'failed' as const)) !== 'removed') ok = false;
    }
    return ok;
  }

  /** The mock world's token for the tap simulator (dev route only). Never available outside the mock world. */
  localToken(callId: string): string | null { return mockTranscriptEnabled() ? this.localTokens.get(callId) ?? null : null; }
  tapsOf(callId: string): string[] { return [...(this.calls.get(callId)?.tapIds ?? [])]; }
  async idle(): Promise<void> { while (this.inFlight.size) await Promise.allSettled([...this.inFlight]); }
}

let armer: TapArmer | null = null;
/** The process's tap armer; deleting taps is wired to the token's death, so every way a call stops listening removes its tap. */
export function tapArmer(): TapArmer {
  return (armer ??= new TapArmer());
}
export function setTapArmer(next: TapArmer | null): void { armer = next; }
