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
import { NOVA_NAME } from './chat-types.js';
import { mockTranscriptEnabled } from './transcript-source.js';
import type { AudioIntake } from './audio-intake.js';
import { assistantAudio } from './audio-select.js';

export const SINK_PATH = '/api/internal/meeting-assistant/pcm/';
export const TAP_GIVE_UP_MS = 60_000;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 8000];
export const CANNOT_HEAR_NOTICE = `${NOVA_NAME} cannot hear this call yet. Audio has not reached the call's media session.`;

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
    throw new AppError(503, `Live listening is not configured for this deployment (missing ${missingMediaSettings().join(', ')})`);
  }
  const channelArn = await channelResolver().channelOf(session, callId, lobby);
  if (!channelArn) throw new AppError(503, 'This call has no live media session to listen to yet. Try again once someone is publishing audio.');
  return { channelArn, arm: true };
}

interface ArmedTaps { channelArn: string; generation: number; tapIds: Set<string>; sinkUrl: string }

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
  async arm(callId: string, channelArn: string): Promise<void> {
    const cfg = this.cfg();
    if (!cfg) {
      // No media server in the picture: only the mock world's tap simulator stands in for it, and it is told the token through the dev route.
      if (!mockTranscriptEnabled()) return;
      this.localTokens.set(callId, await this.audio().arm(callId, channelArn));
      return;
    }
    this.release(callId);
    const token = await this.audio().arm(callId, channelArn);
    const sinkUrl = `${cfg.sinkBaseUrl}${SINK_PATH}${token}`;
    const state: ArmedTaps = { channelArn, generation: (this.gen += 1), tapIds: new Set(), sinkUrl };
    this.calls.set(callId, state);
    const job = this.createWithRetry(callId, state).catch((e: unknown) => console.warn('[meeting-assistant] tap arming failed', (e as Error).message)).finally(() => { this.inFlight.delete(job); });
    this.inFlight.add(job);
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
        if (this.isOurs(tap.url)) await this.client.delete(state.channelArn, tap.tapId);
      }
    }
    for (let attempt = 0; this.current(callId, state); attempt += 1) {
      const out = await this.client.create(state.channelArn, state.sinkUrl);
      if (!this.current(callId, state)) {
        // Disarmed while the request was out: a tap that came into being anyway must not outlive the call.
        if (out.kind === 'created') await this.client.delete(state.channelArn, out.tapId);
        return;
      }
      if (out.kind === 'created') { state.tapIds.add(out.tapId); return; }
      if (out.kind === 'refused') {
        console.warn(`[meeting-assistant] the media server refused the tap (HTTP ${out.status})`);
        await this.giveUp(callId, state); return;
      }
      if (this.clock() - started >= this.giveUpMs) { await this.giveUp(callId, state); return; }
      await this.sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
    }
  }

  private isOurs(url: string): boolean {
    const cfg = this.cfg();
    return !!cfg && url.startsWith(`${cfg.sinkBaseUrl}${SINK_PATH}`);
  }

  private async giveUp(callId: string, state: ArmedTaps): Promise<void> {
    if (!this.current(callId, state)) return;
    await this.notify(callId, CANNOT_HEAR_NOTICE).catch(() => undefined);
  }

  /** The call's taps are deleted (the token is already dead: audio-intake calls this when it dies). Best effort, never throws. */
  async disarm(callId: string): Promise<void> {
    this.localTokens.delete(callId);
    const state = this.calls.get(callId);
    if (!state) return;
    this.calls.delete(callId);
    for (const id of [...state.tapIds]) await this.client.delete(state.channelArn, id).catch(() => 'failed' as const);
  }

  /** Forget a call's earlier arming without deleting (a new arming follows and clears stale taps by their target). */
  private release(callId: string): void {
    const state = this.calls.get(callId);
    if (!state) return;
    this.calls.delete(callId);
    for (const id of state.tapIds) void this.client.delete(state.channelArn, id).catch(() => undefined);
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
