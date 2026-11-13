// Dev-only transcript-line injector for the meeting assistant's mock world:
//
//   POST /api/dev/calls/:callId/transcript-lines
//   body: { userId, text, at?, captionId?, startMs?, endMs?, speakers?, participantId?, speakerName? } or an array of those
//
// It exists only when the mock providers are on AND NODE_ENV is not production AND the assistant flag is on
// (lib/meeting-assistant/transcript-source.ts mockTranscriptEnabled); otherwise it answers 404, not 403, like
// the mock control plane (routes/mock-control.ts). Mounted at the root with no session, like that plane, and under
// the same optional shared secret. Lines are handed to whoever is listening to the call through the mock source;
// an assistant that was never invited receives nothing.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { MOCK_CONTROL_SERVICE_AUTH, requireServiceAuth } from '../lib/service-auth.js';
import { meetingAssistantEnabled, MockTranscriptSource, mockTranscriptEnabled, transcriptSource, type RawLine } from '../lib/meeting-assistant/index.js';

export const meetingAssistantDevRouter = Router();

function gate(_req: Request, res: Response, next: NextFunction): void {
  if (!mockTranscriptEnabled() || !meetingAssistantEnabled()) { res.status(404).json({ error: 'Not found' }); return; }
  next();
}

const MAX_BATCH = 200;
const num = (v: unknown, name: string): number | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new ValidationError(`${name} must be a non-negative number`);
  return v;
};
const optStr = (v: unknown, name: string, max: number): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) throw new ValidationError(`${name} must be a string of at most ${max} characters`);
  return v;
};

function parseLine(raw: unknown): RawLine {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('each line must be an object');
  const b = raw as Record<string, unknown>;
  if (typeof b['userId'] !== 'string' || !b['userId'] || b['userId'].length > 128) throw new ValidationError('userId is required');
  if (typeof b['text'] !== 'string') throw new ValidationError('text is required');
  if (b['speakers'] !== undefined && (!Array.isArray(b['speakers']) || b['speakers'].length > 16 || b['speakers'].some((x) => typeof x !== 'string' || !x || x.length > 128))) {
    throw new ValidationError('speakers must be a list of user ids');
  }
  const out: RawLine = { userId: b['userId'], text: b['text'] };
  const at = num(b['at'], 'at'); if (at !== undefined) out.at = at;
  const startMs = num(b['startMs'], 'startMs'); if (startMs !== undefined) out.startMs = startMs;
  const endMs = num(b['endMs'], 'endMs'); if (endMs !== undefined) out.endMs = endMs;
  const captionId = optStr(b['captionId'], 'captionId', 128); if (captionId !== undefined) out.captionId = captionId;
  const participantId = optStr(b['participantId'], 'participantId', 128); if (participantId !== undefined) out.participantId = participantId;
  const speakerName = optStr(b['speakerName'], 'speakerName', 128); if (speakerName !== undefined) out.speakerName = speakerName;
  if (b['speakers'] !== undefined) out.speakers = b['speakers'] as string[];
  return out;
}

meetingAssistantDevRouter.post('/api/dev/calls/:callId/transcript-lines', gate,
  requireServiceAuth(MOCK_CONTROL_SERVICE_AUTH, 'mock control authentication required'),
  asyncHandler(async (req, res) => {
    const callId = req.params['callId'];
    if (typeof callId !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(callId)) throw new ValidationError('Invalid call id');
    const body: unknown = req.body;
    const items = Array.isArray(body) ? body : [body];
    if (!items.length || items.length > MAX_BATCH) throw new ValidationError(`send between 1 and ${MAX_BATCH} lines`);
    const lines = items.map(parseLine);
    let listeners = 0;
    const target = transcriptSource();
    if (!(target instanceof MockTranscriptSource)) { res.status(404).json({ error: 'Not found' }); return; }
    for (const line of lines) listeners = await target.inject(callId, line);
    res.status(202).json({ accepted: lines.length, listeners });
  }));
