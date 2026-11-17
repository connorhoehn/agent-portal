// /api/interview-invite/runs — the candidate's runs (docs/interviews-tenant-plan.md decisions 3, 13; row I4.4; contract U4).
// Mounted in routes/interview-invite.ts with one line, beside the consents router.
//
// The same shapes as the panel's routes (routes/interviews/runs.ts), for the guest's ONE interview (its invite's):
//   POST /runs                  start           → 202 { run } | 200 (a repeat) | 400 | 402 | 429
//   GET  /runs                  newest first    → { runs }
//   GET  /runs/events           the interview's event stream (server-sent events), resumable with Last-Event-ID
//   GET  /runs/:runId           → { run }
//   POST /runs/:runId/cancel    → { run }; the candidate may cancel any run of the interview, as the panel may
//
// Every route is gated as /knock is (interviewsFlagGate, requireGuest()) and also needs the guest let in by the lead
// (its invite's admission `admitted`) and the interview `live` and technical. Anything else is the router's one
// not-found (GUEST_REFUSAL). What differs from the panel's answers: no panel member is named (a run the panel started
// reads as started by "Interviewer"), and a refused hold reads "Runs are not available for this interview." (the
// candidate is told nothing about money). The stream closes when the interview stops being live or the guest is no
// longer let in, and at the latest after the round's length plus 30 minutes.
import { Router, type Request } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { admissionOf } from '../lib/interviews/invite/admission.js';
import { GUEST_REFUSAL, guestCookieOf, loadGuest, requireGuest } from '../lib/interviews/invite/guest.js';
import { GUEST_DISPLAY_NAME, guestSubject } from '../lib/interviews/invite/realtime.js';
import { inviteStore } from '../lib/interviews/invite/store.js';
import { interviewsStore } from '../lib/interviews/store-select.js';
import type { Interview } from '../lib/interviews/types.js';
import { cancelRun, getRun, guestRunView, listRuns, type RunPerson } from '../lib/interviews/runs/index.js';
import { interviewsFlagGate } from './interviews.js';
import { answerStart, serveRunStream, STREAM_GRACE_MS } from './interviews/runs.js';

export const runsGuestRouter = Router();

export const GUEST_RUNS_REFUSED = 'Runs are not available for this interview.';

/** The guest's interview, when the lead has let it in and it is a live technical round; null otherwise. */
async function guestRunSeat(req: Request): Promise<{ interview: Interview; person: RunPerson } | null> {
  const guest = req.guest!;
  const [invite, interviews] = await Promise.all([inviteStore().getInvite(guest.inviteId), interviewsStore().listInterviews()]);
  const interview = interviews.find((i) => i.id === guest.interviewId) ?? null;
  if (!invite || !interview || admissionOf(invite).state !== 'admitted') return null;
  if (interview.state !== 'live' || interview.type !== 'technical') return null;
  return { interview, person: { id: guestSubject(guest.inviteId), name: GUEST_DISPLAY_NAME, side: 'candidate' } };
}

runsGuestRouter.post('/runs', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const seat = await guestRunSeat(req);
  if (!seat) { res.status(404).json(GUEST_REFUSAL); return; }
  await answerStart(res, seat.interview.id, seat.person, req.body, { view: guestRunView, refused: () => GUEST_RUNS_REFUSED });
}));

runsGuestRouter.get('/runs', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const seat = await guestRunSeat(req);
  if (!seat) { res.status(404).json(GUEST_REFUSAL); return; }
  res.json({ runs: (await listRuns(seat.interview.id)).map(guestRunView) });
}));

runsGuestRouter.get('/runs/events', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const seat = await guestRunSeat(req);
  if (!seat) { res.status(404).json(GUEST_REFUSAL); return; }
  const cookie = guestCookieOf(req);
  await serveRunStream(req, res, seat.interview.id, seat.interview.minutes * 60_000 + STREAM_GRACE_MS, async () => {
    const again = await loadGuest(cookie);
    if (!again || again.interview.id !== seat.interview.id) return false;
    return again.interview.state === 'live' && admissionOf(again.invite).state === 'admitted';
  });
}));

runsGuestRouter.get('/runs/:runId', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const seat = await guestRunSeat(req);
  const run = seat ? await getRun(seat.interview.id, String(req.params['runId'] ?? '')) : null;
  if (!run) { res.status(404).json(GUEST_REFUSAL); return; }
  res.json({ run: guestRunView(run) });
}));

runsGuestRouter.post('/runs/:runId/cancel', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const seat = await guestRunSeat(req);
  const out = seat ? await cancelRun(seat.interview.id, String(req.params['runId'] ?? '')) : null;
  if (!out || out.kind === 'not-found') { res.status(404).json(GUEST_REFUSAL); return; }
  res.json({ run: guestRunView(out.run) });
}));
