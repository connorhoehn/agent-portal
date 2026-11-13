// The meeting assistant's routes (docs/meeting-assistant-design.md), mounted at /api/calls/:callId/assistant.
//
//   POST invite      InviteMeetingAssistant + a seat. Creates the record and starts listening.
//   POST pause       a seat. Anyone in the call can pause (decision 8).
//   POST resume      a seat.
//   POST dismiss     a seat. Final: the assistant leaves.
//   POST ack         a seat. Acknowledges the transcription notice; until then your lines are not stored.
//   GET  state       a seat. State, who invited, who still owes an ack, counters, pending requests.
//   GET  transcript  people who hold or held a seat in this call, nobody else (admins included).
//
// Every route needs: the flag on (else 404), the orgiq tenant, and a currently connected seat of THIS call
// (lib/call-chat.ts assertMember) — except the transcript, which also serves people who have left or after
// the call ended, by attendance. Writes are refused under a masquerade: they are attributed to a person.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireTenant, resolveSession } from '../lib/authz.js';
import { callChatRuntime } from '../lib/call-chat.js';
import type { Session } from '../lib/session.js';
import {
  assistantIntake, assistantStore, initiativeOfLobby, meetingAssistantEnabled, TranscriptSourceNotConfigured,
  type AssistantRecord,
} from '../lib/meeting-assistant/index.js';

export const meetingAssistantRouter = Router({ mergeParams: true });


function sessionOf(req: Request): Session {
  const s = resolveSession(req);
  if (!s) throw new AppError(401, 'Unauthenticated');
  return s;
}
function callIdOf(req: Request): string {
  const id = req.params['callId'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,256}$/.test(id)) throw new ValidationError('Invalid call id');
  return id;
}

/** With the flag off the feature does not exist: 404, not 403. */
function flagGate(_req: Request, res: Response, next: NextFunction): void {
  if (!meetingAssistantEnabled()) { res.status(404).json({ error: 'Not found' }); return; }
  next();
}

/** Writes are attributed to a person; a masquerade splits that identity, so refuse (routes/runbooks.ts does the same). */
function refuseMasquerade(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && resolveSession(req)?.act) {
    res.status(403).json({ error: 'stop masquerading to use the meeting assistant; these writes are attributed to a person', code: 'MASQUERADING' });
    return;
  }
  next();
}

meetingAssistantRouter.use(flagGate, requireTenant('orgiq'), refuseMasquerade);

const seatOf = async (req: Request): Promise<{ session: Session; callId: string }> => {
  const session = sessionOf(req); const callId = callIdOf(req);
  await callChatRuntime().assertMember(callId, session, false);
  return { session, callId };
};

/** Seat holders who have not acknowledged: everyone known to be present or to have been, minus the inviter and the acked. */
async function mustAck(record: AssistantRecord, callId: string): Promise<string[]> {
  const live = (await callChatRuntime().seatedUsers(callId).catch(() => [])).filter((u) => u.active).map((u) => u.userId);
  const everyone = new Set([...record.presentAtInvite, ...record.attendees, ...live]);
  return [...everyone].filter((u) => u !== record.invitedBy && !record.acked.includes(u)).sort();
}

async function view(record: AssistantRecord | null, callId: string, session: Session) {
  if (!record) return { callId, state: 'none' as const };
  const owing = await mustAck(record, callId);
  return {
    callId, state: record.state, lobby: record.lobby, initiativeId: record.initiativeId,
    invitedBy: record.invitedBy, invitedAt: record.invitedAt, pausedBy: record.pausedBy, leftAt: record.leftAt, leftBy: record.leftBy,
    mustAck: owing, youMustAck: owing.includes(session.sub),
    counters: { requests: record.requests, linesStored: record.linesStored },
    pendingRequests: record.pendingRequests,
  };
}

const noteSeat = async (callId: string, session: Session) => { await assistantStore().attend(callId, session.sub); };

meetingAssistantRouter.post('/invite', requireAction('InviteMeetingAssistant'), asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const store = assistantStore();
  const startListening = () => {
    try { assistantIntake().start(callId); } catch (e) {
      if (e instanceof TranscriptSourceNotConfigured) throw new AppError(503, 'Live transcripts are not configured for this deployment');
      throw e;
    }
  };
  const existing = await store.get(callId);
  if (existing?.state === 'left') throw new AppError(409, 'The assistant already left this call');
  if (existing) { startListening(); await noteSeat(callId, session); res.json(await view((await store.get(callId)) ?? existing, callId, session)); return; }

  const runtime = callChatRuntime();
  const lobby = await runtime.lobbyOf(callId);
  if (!lobby) throw new NotFoundError('Call is no longer active');
  const present = (await runtime.seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId);
  if (!present.includes(session.sub)) present.push(session.sub);
  startListening();
  // `invited` is the moment of the invite; the inviter acknowledges by inviting, so listening starts at once.
  const { record } = await store.create({
    callId, tenant: session.tenant, lobby, initiativeId: initiativeOfLobby(lobby), state: 'invited',
    invitedBy: session.sub, invitedAt: Date.now(), pausedBy: null, leftAt: null, leftBy: null,
    acked: [session.sub], attendees: [...new Set(present)], presentAtInvite: [...new Set(present)],
    requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
  });
  const listening = await store.transition(callId, { from: ['invited'], to: 'listening', by: session.sub, at: Date.now() });
  res.status(201).json(await view(listening ?? record, callId, session));
}));

/** Shared by pause, resume and dismiss: do the move, or say why not. A repeat of the state you are already in is a success. */
function move(to: 'paused' | 'listening' | 'left', from: AssistantRecord['state'][]) {
  return asyncHandler(async (req, res) => {
    const { session, callId } = await seatOf(req);
    const store = assistantStore();
    await noteSeat(callId, session);
    const done = await store.transition(callId, { from, to, by: session.sub, at: Date.now() });
    if (done) {
      if (to === 'left') {
        // Snapshot who was seated so they can still read the transcript after the call ends.
        for (const u of await callChatRuntime().seatedUsers(callId).catch(() => [])) await store.attend(callId, u.userId);
        assistantIntake().stop(callId);
      }
      res.json(await view(await store.get(callId), callId, session));
      return;
    }
    const current = await store.get(callId);
    if (!current) throw new NotFoundError('The assistant is not in this call');
    if (current.state === to) { res.json(await view(current, callId, session)); return; }
    throw new AppError(409, `The assistant is ${current.state}; it cannot ${to === 'left' ? 'be dismissed' : to === 'paused' ? 'pause' : 'resume'} now`);
  });
}
meetingAssistantRouter.post('/pause', move('paused', ['listening']));
meetingAssistantRouter.post('/resume', move('listening', ['paused']));
meetingAssistantRouter.post('/dismiss', move('left', ['invited', 'listening', 'paused']));

meetingAssistantRouter.post('/ack', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const store = assistantStore();
  const current = await store.get(callId);
  if (!current) throw new NotFoundError('The assistant is not in this call');
  if (current.state === 'left') throw new AppError(409, 'The assistant already left this call');
  res.json(await view(await store.ack(callId, session.sub), callId, session));
}));

meetingAssistantRouter.get('/state', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const store = assistantStore();
  await noteSeat(callId, session);
  res.json(await view(await store.get(callId), callId, session));
}));

/** `?after=<seq>&limit=<1..500>`; digits only, so nothing odd reaches the store. */
function intParam(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new ValidationError(`${name} must be between ${min} and ${max}`);
  return Number(raw);
}

meetingAssistantRouter.get('/transcript', asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  const after = intParam(req.query['after'], 'after', 0, 1_000_000_000, 0);
  const limit = intParam(req.query['limit'], 'limit', 1, 500, 100);
  const store = assistantStore();
  const record = await store.get(callId);
  const seated = (await callChatRuntime().seatedUsers(callId).catch(() => [])).some((u) => u.userId === session.sub);
  // Same answer for "no assistant", "another tenant's call" and "you were not there": nothing, 404.
  if (!record || record.tenant !== session.tenant || !(record.attendees.includes(session.sub) || seated)) throw new NotFoundError('No transcript');
  const lines = await store.lines(callId, after, limit);
  res.json({ callId, after, lines, next: lines.length ? lines[lines.length - 1]!.seq : after });
}));
