// The PCM sink for the meeting assistant's per-participant taps (docs/meeting-assistant-design.md, "Architecture", intake).
//
//   POST /api/internal/meeting-assistant/pcm/:sinkToken
//     body    raw 16 kHz mono s16le PCM, one 200 ms chunk (at most 64 KB)
//     headers X-Channel-Arn (must be the call's channel), X-Participant-Id, X-Sample-Rate, X-Encoding, X-Channels
//     auth    the unguessable per-call token in the path, and nothing else: no cookie, no session, no CSRF. It is mounted in
//             index.ts BEFORE the browser-origin check, the JSON body parser and the cookie and session middleware, so none of
//             them runs; the media server is the only caller.
//   An unknown, dead, wrong-channel or not-yet-listening token answers 404 with an empty body before the body is read.
//   Everything else answers 204 (an accepted chunk, or one that was dropped for a reason the caller does not need), 400 for
//   a chunk in the wrong format, 413 over 64 KB, 429 past the token's rate. The route only enqueues: it answers in
//   microseconds and never waits on the provider. The media server does not read or retry on the answer.
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { meetingAssistantEnabled } from '../lib/meeting-assistant/index.js';
import { MAX_CHUNK_BYTES } from '../lib/meeting-assistant/audio-intake.js';
import { assistantAudio } from '../lib/meeting-assistant/audio-select.js';

export const meetingAssistantSinkRouter = Router();

const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined);
const tokenOf = (req: Request): string => (typeof req.params['sinkToken'] === 'string' ? req.params['sinkToken'] : '');
const gone = (res: Response): void => { res.status(404).end(); };

function admit(req: Request, res: Response, next: NextFunction): void {
  if (!meetingAssistantEnabled()) { gone(res); return; }
  const verdict = assistantAudio().admit(tokenOf(req), one(req.headers['x-channel-arn']));
  if (verdict === 'unknown') { gone(res); return; }
  if (verdict === 'limited') { res.set('Retry-After', '1').status(429).end(); return; }
  next();
}

meetingAssistantSinkRouter.post('/pcm/:sinkToken', admit, express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }), (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const h = req.headers;
  const result = assistantAudio().accept(tokenOf(req), {
    ...(one(h['x-channel-arn']) !== undefined ? { channelArn: one(h['x-channel-arn'])! } : {}),
    ...(one(h['x-participant-id']) !== undefined ? { participantId: one(h['x-participant-id'])! } : {}),
    ...(one(h['x-sample-rate']) !== undefined ? { sampleRate: one(h['x-sample-rate'])! } : {}),
    ...(one(h['x-encoding']) !== undefined ? { encoding: one(h['x-encoding'])! } : {}),
    ...(one(h['x-channels']) !== undefined ? { channels: one(h['x-channels'])! } : {}),
  }, body);
  if (result === 'unknown') { gone(res); return; }
  if (result === 'bad-format') { res.status(400).end(); return; }
  res.status(204).end();
});

// An oversize or unreadable body: plain statuses, no body, and the error never reaches the app's JSON error handler.
meetingAssistantSinkRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
  const status = (err as { status?: number; statusCode?: number } | null)?.status ?? (err as { statusCode?: number } | null)?.statusCode;
  res.status(status === 413 ? 413 : 400).end();
});
