// /api/interview-invite/pad/events: the candidate's pad log writes (docs/interviews-tenant-plan.md decision 12, row
// I4.3; decision 3; contract U3). Mounted on the guest's router (routes/interview-invite.ts) with one line.
//
//   POST /pad/events   the admitted guest of its own interview, a technical round that is `live`; body
//                      { events: PadEventIn[] } (1 to 50) → { accepted }
//
// Gated as /knock is (the flag, then requireGuest()), and then as the guest's pad seat is (lib/interviews/lobby.ts
// guestSeatRule with the pad): the interview is the invite's and no other, admitted by the lead, technical, and `live`
// here (the pad's channel also opens before the start; the log is written only during the call). A behavioural round,
// a guest not admitted or turned away, an interview not live, a dead link: the one not-found the guest routes give.
// Who wrote it is the invite's guest (`guest:<inviteId>`, side `candidate`), never the body; the server stamps `at`.
// The guest has no read of the log (decision 4): this file mounts no GET.
import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { GUEST_REFUSAL, requireGuest } from '../lib/interviews/invite/guest.js';
import { admissionOf } from '../lib/interviews/invite/admission.js';
import { guestSubject } from '../lib/interviews/invite/realtime.js';
import { guestRoomState } from '../lib/interviews/invite/room.js';
import { inviteStore } from '../lib/interviews/invite/store.js';
import { guestSeatRule } from '../lib/interviews/lobby.js';
import { interviewsEnabled } from '../lib/interviews/flag.js';
import { BAD_POST, appendPadEvents, checkPadPost } from '../lib/interviews/pad/log/index.js';
import { interviewsStore } from '../lib/interviews/store-select.js';
import { interviewsFlagGate } from './interviews.js';

export const padGuestRouter: Router = Router();

padGuestRouter.post('/pad/events', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  const guest = req.guest!;
  const [invite, interviews] = await Promise.all([inviteStore().getInvite(guest.inviteId), interviewsStore().listInterviews()]);
  const interview = interviews.find((i) => i.id === guest.interviewId) ?? null;
  const admission = admissionOf(invite);
  const open = invite && interview ? guestRoomState(invite, interview, admission, new Date()) === 'open' : false;
  const seated = guestSeatRule({ flagOn: interviewsEnabled(), guestInterviewId: invite?.interviewId ?? null, interview, admission: admission.state, pad: true });
  if (!interview || !open || !seated || interview.state !== 'live') { res.status(404).json(GUEST_REFUSAL); return; }
  const events = checkPadPost(req.body);
  if (!events) { res.status(400).json({ error: BAD_POST }); return; }
  res.json({ accepted: await appendPadEvents(interview.id, { id: guestSubject(guest.inviteId), side: 'candidate' }, events) });
}));
