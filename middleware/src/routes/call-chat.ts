// The huddle conversation's resolver. Messages, typing, receipts and
// reactions travel over the gateway's `orgiq:huddle:<callId>` chat channel
// under the same participant authority (lib/call-chat.ts); this route only
// tells a current participant which channel that is, who is in it, whether
// they may post, and their replay from their join boundary.
import { Router, type Request } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { resolveSession } from '../lib/authz.js';
import { callChatRuntime } from '../lib/call-chat.js';
import type { Session } from '../lib/session.js';

export const callChatRouter = Router();
function session(req: Request): Session {
  if (!req.session) throw new AppError(401, 'Unauthenticated');
  const value = resolveSession(req); if (!value) throw new AppError(401, 'Unauthenticated'); return value;
}
function callId(req: Request): string {
  const id = req.params['callId'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(id)) throw new ValidationError('Invalid call id'); return id;
}
callChatRouter.get('/:callId/chat', asyncHandler(async (req, res) => {
  const raw = req.query['limit'];
  if (raw !== undefined && (typeof raw !== 'string' || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 100)) {
    throw new ValidationError('limit must be between 1 and 100');
  }
  res.json(await callChatRuntime().get(callId(req), session(req), raw === undefined ? 50 : Number(raw)));
}));
