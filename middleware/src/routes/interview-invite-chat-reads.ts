// The candidate's read position in their interview's call chat (the guest room's Chat tab bubble,
// portal hooks/useCallChatUnread.ts): GET/PUT /api/interview-invite/calls/:callId/chat/reads.
// The guest cookie reaches only /api/interview-invite, so the staff route (routes/call-chat.ts) has this guest twin.
//   - who: the guest's own session (requireGuest); the subject is derived from it (`guest:<inviteId>`), never sent;
//   - which call: only a call whose lobby is the guest's own interview, which is live, with the invite admitted and
//     the guest holding an active seat in that call now (the same checks as the guest's media route);
//   - what: lib/call-chat-reads.ts, the same store and rules as the panel's. Anything else is the guest refusal (404).
import { Router, type Request } from 'express';
import { AppError, asyncHandler } from '../lib/async-handler.js';
import { callChatRuntime } from '../lib/call-chat.js';
import { callChatReads } from '../lib/call-chat-reads.js';
import { admissionOf } from '../lib/interviews/invite/admission.js';
import { GUEST_REFUSAL, requireGuest } from '../lib/interviews/invite/guest.js';
import { guestSubject } from '../lib/interviews/invite/realtime.js';
import { inviteStore } from '../lib/interviews/invite/store.js';
import { interviewOfLobby } from '../lib/interviews/milo-policy.js';
import { interviewsStore } from '../lib/interviews/store-select.js';
import { socialChat } from '../lib/social-chat.js';
import type { Session } from '../lib/session.js';
import { interviewsFlagGate } from './interviews.js';

const CALL_ID = /^[a-zA-Z0-9:_-]{1,256}$/;
export const chatReadsGuestRouter = Router();

class GuestRefused extends AppError { constructor() { super(404, GUEST_REFUSAL.error); } }

/** The guest's seat in this call of their own live interview, or the refusal. */
async function assertGuestSeat(callId: string, guest: NonNullable<Request['guest']>): Promise<void> {
  if (!CALL_ID.test(callId)) throw new GuestRefused();
  const subject = guestSubject(guest.inviteId);
  const [invite, interviews] = await Promise.all([inviteStore().getInvite(guest.inviteId), interviewsStore().listInterviews()]);
  const interview = interviews.find((i) => i.id === guest.interviewId) ?? null;
  if (!invite || !interview || invite.interviewId !== interview.id || admissionOf(invite).state !== 'admitted' || interview.state !== 'live') throw new GuestRefused();
  const calls = callChatRuntime();
  const [lobby, seated] = await Promise.all([calls.lobbyOf(callId).catch(() => null), calls.seatedUsers(callId).catch(() => [])]);
  if (interviewOfLobby(lobby) !== interview.id || !seated.some((u) => u.userId === subject && u.active)) throw new GuestRefused();
}

const guestOf = (req: Request) => { const guest = req.guest; if (!guest) throw new GuestRefused(); return guest; };
const sessionOf = (req: Request): Session => ({ sub: guestSubject(guestOf(req).inviteId) }) as Session;
const reads = (req: Request) => callChatReads({ store: () => socialChat().readReceiptStore, assertMember: (callId) => assertGuestSeat(callId, guestOf(req)) });

chatReadsGuestRouter.get('/calls/:callId/chat/reads', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await reads(req).get(String(req.params['callId']), sessionOf(req)));
}));
chatReadsGuestRouter.put('/calls/:callId/chat/reads', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const body = (req.body ?? {}) as Record<string, unknown>;
  // The candidate's pane has no Milo tab: their position is the chat's only.
  if (body['tab'] !== 'chat') { res.status(400).json({ error: 'tab must be chat' }); return; }
  res.json(await reads(req).mark(String(req.params['callId']), sessionOf(req), 'chat', body['readAt']));
}));
