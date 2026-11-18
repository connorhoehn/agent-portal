// /api/interview-invite/milo — the candidate's two requests to Milo (docs/interviews-tenant-plan.md decisions 3, 9, 10; rows
// I3.5, I3.8; contract U10). Mounted in routes/interview-invite.ts with one line, after the runs router.
//
//   POST /milo/request   body { request: 'repeat' | 'time' } → 200 { line }
//
// Gated as /knock is (interviewsFlagGate, requireGuest()), and also needs the guest let in by the lead (its invite's admission
// `admitted`) and the interview `live`; anything else is the router's one not-found (GUEST_REFUSAL). The answer is text the
// server holds, never a model's (lib/interviews/speak): the last question Milo was approved to ask, or the time left from the
// round's minutes and its start. It is logged, posted in the call chat with the approved mark and said aloud as approved words
// when Milo is in the call with its voice on; with Milo not listening it is chat only, and with Milo not in the call it is only
// this answer's `line`. At most one request every 10 seconds per interview: within that, `line` is a plain sentence and nothing
// is logged, posted or said, but `line` still answers in text (E4 #35: the cooldown holds the voice, never the answer; the words
// are the server's own, so the text costs nothing). Each spoken line holds a little under the interview's cap (speak `speech`);
// at the cap: chat only.
import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { admissionOf } from '../lib/interviews/invite/admission.js';
import { GUEST_REFUSAL, requireGuest } from '../lib/interviews/invite/guest.js';
import { guestSubject } from '../lib/interviews/invite/realtime.js';
import { inviteStore } from '../lib/interviews/invite/store.js';
import { interviewsStore } from '../lib/interviews/store-select.js';
import { answerCandidate, candidateLine } from '../lib/interviews/speak/index.js';
import { interviewsNowMs } from '../lib/interviews/clock.js';
import { interviewsFlagGate } from './interviews.js';

export const miloGuestRouter = Router();

/** The least time between two of the candidate's requests, per interview. */
export const GUEST_MILO_GAP_MS = 10_000;
const BAD_REQUEST = 'Ask Milo to repeat the question or to tell you the time left.';
const lastAsked = new Map<string, number>();

/** Tests: forget the per-interview limit. */
export function resetGuestMiloLimit(): void { lastAsked.clear(); }

miloGuestRouter.post('/milo/request', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const guest = req.guest!;
  const [invite, interviews] = await Promise.all([inviteStore().getInvite(guest.inviteId), interviewsStore().listInterviews()]);
  const interview = interviews.find((i) => i.id === guest.interviewId) ?? null;
  if (!invite || !interview || admissionOf(invite).state !== 'admitted' || interview.state !== 'live') { res.status(404).json(GUEST_REFUSAL); return; }
  const request = (req.body as Record<string, unknown> | undefined)?.['request'];
  if (request !== 'repeat' && request !== 'time') { res.status(400).json({ error: BAD_REQUEST }); return; }
  const now = interviewsNowMs();
  const last = lastAsked.get(interview.id);
  // Inside the gap: the answer in text only, not logged, posted or said (E4 #35).
  if (last !== undefined && now - last < GUEST_MILO_GAP_MS && now >= last) { res.json({ line: (await candidateLine(interview, request)).text }); return; }
  lastAsked.set(interview.id, now);
  const { line } = await answerCandidate(interview, request, guestSubject(guest.inviteId));
  res.json({ line });
}));
