// /api/interview-invite/media — the candidate's own media participant id, bound to the candidate (docs/interviews-tenant-plan.md
// decision 9; the meeting assistant's taps name media participants, not people, so an unbound guest's audio is dropped and never
// reaches Milo or the transcript). Mounted in routes/interview-invite.ts with one line, beside the Milo router.
//
//   POST /media/participant   body { callId, participantId } → 200 { bound: true } | { bound: false, why: 'no-transcript' }
//
// The staff route (routes/meeting-assistant.ts POST /participant) is the model, held tighter for a guest:
//   - who: the guest's own session (requireGuest) only; the subject is DERIVED from that session (`guest:<inviteId>`, the same
//     subject the middleware mints in the guest's realtime token, which the media server takes as the participant's user id and
//     stamps as `<user id>-<base36>`). The id must be that subject plus one stamp; another guest's, a staff member's or a bare
//     subject is refused. Nothing in the body names a person.
//   - when: the guest's invite is admitted and the interview is live; the call is this interview's call (its lobby names it) and
//     the guest holds an active seat in it. Anything else is the router's one not-found (GUEST_REFUSAL).
//   - consent: with the transcript declined (or not answered) nothing is bound, so the candidate's audio stays unmapped and dropped
//     (the acknowledgement gate in the audio intake would also drop it; this keeps it from ever being mapped).
//   - after: the guest turned away, its link revoked or replaced, or the interview ended drops every id bound to it
//     (admission.ts `onGuestGone`), so its audio is dropped from then on.
// Milo need not be in the call yet: the binding is kept and taken up when Milo is invited (audio-intake.ts `arm`).
import { Router } from 'express';
import { asyncHandler } from '../lib/async-handler.js';
import { callChatRuntime } from '../lib/call-chat.js';
import { admissionOf, onGuestGone } from '../lib/interviews/invite/admission.js';
import { GUEST_REFUSAL, requireGuest } from '../lib/interviews/invite/guest.js';
import { guestSubject } from '../lib/interviews/invite/realtime.js';
import { inviteStore } from '../lib/interviews/invite/store.js';
import { candidateTranscribed, interviewOfLobby } from '../lib/interviews/milo-policy.js';
import { interviewsStore } from '../lib/interviews/store-select.js';
import { assistantAudio } from '../lib/meeting-assistant/audio-select.js';
import { assistantStore } from '../lib/meeting-assistant/store-select.js';
import { ackElsewhere } from './meeting-assistant.js';
import { interviewsFlagGate } from './interviews.js';

export const mediaGuestRouter = Router();

const CALL_ID = /^[a-zA-Z0-9:_-]{1,256}$/;
const STAMP = /^[0-9a-z]{1,16}$/;

/** The guest's own media id: its subject, one dash, one base36 stamp. Never a bare subject, never anyone else's. */
export function isOwnGuestMediaId(subject: string, id: unknown): id is string {
  if (typeof id !== 'string' || id.length > 256) return false;
  const prefix = `${subject}-`;
  return id.startsWith(prefix) && STAMP.test(id.slice(prefix.length));
}

// A guest who leaves the room for good loses every binding at once.
onGuestGone((subject) => { void assistantAudio().unbindUser(subject).catch(() => undefined); });

mediaGuestRouter.post('/media/participant', interviewsFlagGate, requireGuest(), asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const guest = req.guest!;
  const subject = guestSubject(guest.inviteId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const callId = body['callId'];
  const participantId = body['participantId'];
  if (typeof callId !== 'string' || !CALL_ID.test(callId) || !isOwnGuestMediaId(subject, participantId)) { res.status(404).json(GUEST_REFUSAL); return; }
  const [invite, interviews] = await Promise.all([inviteStore().getInvite(guest.inviteId), interviewsStore().listInterviews()]);
  const interview = interviews.find((i) => i.id === guest.interviewId) ?? null;
  if (!invite || !interview || invite.interviewId !== interview.id || admissionOf(invite).state !== 'admitted' || interview.state !== 'live') {
    res.status(404).json(GUEST_REFUSAL); return;
  }
  const calls = callChatRuntime();
  const [lobby, seated] = await Promise.all([calls.lobbyOf(callId).catch(() => null), calls.seatedUsers(callId).catch(() => [])]);
  if (interviewOfLobby(lobby) !== interview.id || !seated.some((u) => u.userId === subject && u.active)) { res.status(404).json(GUEST_REFUSAL); return; }
  if (!await candidateTranscribed(interview.id)) { res.json({ bound: false, why: 'no-transcript' }); return; }
  const out = await assistantAudio().bindParticipant(callId, participantId, subject);
  if (out !== 'bound') { res.status(409).json({ error: 'This media id cannot be bound.' }); return; }
  // Milo already in the call: the candidate's acknowledgement given in the portal counts from now (its audio is admitted).
  const record = await assistantStore().get(callId).catch(() => null);
  if (record && record.state !== 'left') await ackElsewhere(callId, subject).catch(() => undefined);
  res.json({ bound: true });
}));
