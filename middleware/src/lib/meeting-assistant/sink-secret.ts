// The audio sink's second credential (docs/meeting-assistant-design.md, "Running it against real media"; audit B4).
//
// The sink's per-call token travels in the tap's destination address, and the media server can list a channel's tap destinations,
// so the token alone cannot be what lets a request speak for a call. The media server therefore also sends a shared secret in the
// header `X-Live-Captions-Secret` on its PCM posts, to the one origin it is configured for (LIVE_CAPTIONS_SHARED_SECRET with
// LIVE_CAPTIONS_ORIGIN), and never lists it. This module holds this side of that: MEETING_ASSISTANT_SINK_SECRET.
//
// Rules: a configured secret must match, compared in constant time, before the token is looked at. No secret configured: the sink
// refuses everything and tap arming refuses with a 503, except under INSECURE_DEV_MODE (the one switch that may open a security
// default, lib/insecure-dev-mode.ts), where the sink is open and says so once at start.
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '../../config.js';
import { insecureDevMode } from '../insecure-dev-mode.js';

export const SINK_SECRET_HEADER = 'x-live-captions-secret';
export const SINK_SECRET_SETTING = 'MEETING_ASSISTANT_SINK_SECRET';

/** The configured secret, or '' when there is none. Read per call so tests can change it. */
export function sinkSecret(): string {
  const v = (config as { meetingAssistant?: { media?: { sinkSecret?: unknown } } }).meetingAssistant?.media?.sinkSecret;
  return typeof v === 'string' ? v.trim() : '';
}

/** The sink is open (no secret) because INSECURE_DEV_MODE says so. */
export function sinkOpenInDev(): boolean { return sinkSecret() === '' && insecureDevMode(); }

/** Can taps be armed and the sink answer at all? A secret is configured, or dev mode opens it. */
export function sinkSecretUsable(): boolean { return sinkSecret() !== '' || insecureDevMode(); }

const hashed = (v: string): Buffer => createHash('sha256').update(v).digest();

/** Does the presented header value satisfy the sink? Constant time; a missing or wrong value is false when a secret is set. */
export function sinkSecretOk(presented: string | undefined): boolean {
  const secret = sinkSecret();
  if (secret === '') return insecureDevMode();
  if (typeof presented !== 'string') return false;
  return timingSafeEqual(hashed(presented), hashed(secret));
}

let announced = false;
/** Log once, at start, that the sink is open (dev mode, no secret). Returns whether it logged. */
export function announceSinkSecret(log: (line: string) => void = (l) => console.warn(l)): boolean {
  if (announced || !sinkOpenInDev()) return false;
  announced = true;
  log(`[meeting-assistant] the audio sink is OPEN: ${SINK_SECRET_SETTING} is not set and INSECURE_DEV_MODE is on. Never run this way where call participants can reach it.`);
  return true;
}
export function resetSinkAnnouncement(): void { announced = false; }
