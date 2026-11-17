// The meeting assistant's routes (docs/meeting-assistant-design.md), mounted at /api/calls/:callId/assistant.
//
//   POST invite      InviteMeetingAssistant + a seat. Creates the record and starts listening. On a call Milo has left it invites Milo back
//                    (`rejoin`): a new listening period on the same record, a fresh hold against this person, everyone else acknowledges
//                    again. Refused for good once the record was deleted or the call used its whole listening time.
//   POST pause       a seat. Anyone in the call can pause (decision 8).
//   POST resume      a seat. { confirmOverUserBudget? }: after a restart a resume holds money again; only the inviter's confirmation counts.
//   POST dismiss     a seat. The assistant leaves (anyone who may invite it can invite it back).
//   POST ack         a seat. Acknowledges the transcription notice; until then your lines are not stored.
//   POST voice       InviteMeetingAssistant + a seat. { on: boolean }: Milo speaks aloud in this call (off by default) or stops. One notice in the call chat.
//   POST participant a seat. { participantId }: bind YOUR media participant id (the per-join id the media server minted for your seat)
//                    to yourself, so audio the taps send under that id is yours. The id must be `<your user id>-<base36 stamp>`.
//   POST actions/:actionId/decision  a seat, and ONLY the person the action was offered to. { decision: 'confirm' | 'decline' }.
//   POST extend       InviteMeetingAssistant + a seat. Adds the default minutes to the call's listening ceiling, up to the hard maximum,
//                      and holds the money for them against the inviter. { confirmOverUserBudget? }
//   GET  turns?mine=1  a seat. The tool calls waiting for MY browser: pending reads, and writes I confirmed (running), not yet claimed. Only mine.
//   POST turns/:turnId/claim   a seat, ONLY the asker (404 otherwise). Claims the turn for this browser before it runs: { turnId, claimId, tool, kind };
//                      a second claim, an expired turn or one not runnable yet is 409.
//   POST turns/:turnId/result  a seat, and ONLY the person the turn was made for (404 for anyone else). { claimId, ok, output?, error? }:
//                      the browser's result of running the tool as that person (400 without claimId, 409 when it is not the claim). The server
//                      hands it to the live session as data, except a private read's `output.say`, which only the asker is shown.
//   (The three turn routes also serve, without a seat, the executor of one of the call's proposals by the proposals' rule, and then
//    only proposal turns: a consent given on the meeting page after the call runs in that browser.)
//   GET  proposals   a seat, a recorded attendee, or a person a proposal names or makes its executor (who sees only those): the call's
//                    proposals (docs/meeting-consent-design.md) with each person's answer and who is still needed. Anyone else 404.
//                    The lines Milo heard (`heard`, a short quoted excerpt) go only to people who held a seat; a named person or
//                    executor who was never in the call sees the statement and who raised it, never the lines.
//   POST proposals/:id/response  the same people. { response: 'consent' | 'object' | 'withdraw' | 'not-a-decision' | 'reopen', reason? }:
//                    the reason is for an objection only, one line of at most 200 characters, and everyone in the call sees it. "Not
//                    a decision" needs a seat now, and on a proposal a person asked for only the asker may (403). `reopen` undoes a
//                    dismissal, by the person who made it. With `asExecutor: true` (consent only, while it is consented, and only
//                    when the view says `you.canRun`) the caller becomes the one whose browser runs it, and it starts. Answers the
//                    updated proposal, with `run` (the latest run: who, what was made, or why not); 409 once it is running,
//                    finished or expired.
//   POST proposals/:id/raise-again  the same people: an objected or failed proposal is closed and a new open one with the same
//                    outcome is made (no answers carry). 409 when it cannot be raised again or the call has its cap of proposals.
//   GET  state       a seat. State, who invited, who still owes an ack, counters, pending requests.
//   GET  transcript  people who hold or held a seat in this call, nobody else (admins included).
//   GET  minutes     the same rule (`attendeeOf`): the notes the assistant left. 404 for everyone else, and while there are none;
//                    410 (deleted / expired) to an attendee once the record is gone.
//   POST minutes/rewrite  an attendee asks Milo to write failed minutes again (capped; minutes-service.ts MAX_ATTEMPTS).
//   DELETE minutes | transcript   whoever invited Milo into this call, in any period, only (an attendee who is not gets 403; anyone else 404): deletes the minutes AND the
//                    transcript lines and leaves a tombstone, so they are never written again. Only after the assistant has left.
//   (This file also exports `meetingsRouter`, mounted at /api/meetings: the caller's own attended meetings.)
//
// Every route needs: the flag on (else 404), the orgiq tenant, and a currently connected seat of THIS call
// (lib/call-chat.ts assertMember) — except the transcript, which also serves people who have left or after
// the call ended, by attendance, and the proposals, which also serve the people a proposal needs. Every route is refused under a masquerade, reads included: they show a person's own turns and the call's words.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError, asyncHandler, NotFoundError, ValidationError } from '../lib/async-handler.js';
import { requireInitiativeScope } from '../lib/initiative-scope.js';
import { notifyWorkGraphChanged } from '../lib/work-graph/live.js';
import { createWorkItem } from '../providers/work-items.js';
import { requireAction, requireTenant, resolveSession } from '../lib/authz.js';
import { callChatRuntime, onCallChatFinished } from '../lib/call-chat.js';
import type { Session } from '../lib/session.js'; import { getUser } from '../providers/identity.js';
import { userAvatars } from '../providers/user-avatars.js';
import {
  assistantIntake, assistantStore, initiativeOfLobby, meetingAssistantEnabled, TranscriptSourceNotConfigured,
  type AssistantRecord,
} from '../lib/meeting-assistant/index.js';
import { moveAction, nameOf, noticeText, postNoticeQuietly } from '../lib/meeting-assistant/chat.js';
import { eraseCall } from '../lib/meeting-assistant/erase.js';
import { assistantRuntime, describeCall, MAX_RESULT_BYTES, RunStillStopping, type StartContext } from '../lib/meeting-assistant/orchestrator.js';
import { assistantAudio } from '../lib/meeting-assistant/audio-select.js';
import { NOT_SET_UP, preflightAudio, tapArmer, type Preflight } from '../lib/meeting-assistant/media.js';
import { actionCardTurnId, AUTO_ATTEMPTS, MAX_ATTEMPTS, meetingNameOf, minutesWriting, onCallEnded, rewriteMinutes, trackMinutes } from '../lib/meeting-assistant/minutes-service.js';
import { minutesCounts, summaryParts, summaryWithProposals } from '../lib/meeting-assistant/minutes.js';
import { retentionDays } from '../lib/meeting-assistant/retention.js';
import { owedBy } from '../lib/meeting-assistant/proposal-notify.js';
import { endAbandonedCall, settleFromRecord } from '../lib/meeting-assistant/reconcile.js';
import { sessionAvailable } from '../lib/meeting-assistant/session-select.js';
import { ackedBefore, newAssistantSession, periodOf, sessionOf as recordSession, type AssistantSession } from '../lib/meeting-assistant/types.js';
import { assistantLimits, type AssistantLimits } from '../lib/meeting-assistant/limits.js';
import { assistantSpend, listeningSecondsOf, type ReserveOutcome } from '../lib/meeting-assistant/spend.js';
import { ASSISTANT_NAME } from '../lib/meeting-assistant/chat-types.js'; import { familyOfLobby, hasFamilyPolicies, payerFields, policyCallOf, policyFamilies, limitsOfCall, policyForLobby, type PolicyCall, type ReadAccess } from '../lib/meeting-assistant/policy.js'; import { CANNOT_LISTEN_PAST_ROUND, INTERVIEW_FAMILY, registerInterviewsMiloPolicy } from '../lib/interviews/milo-policy.js'; import { interviewsEnabled } from '../lib/interviews/flag.js';
type SpendRefusal = Extract<ReserveOutcome, { ok: false }>['refusal'];
import { notifyOpenProposals } from '../lib/meeting-assistant/proposal-notify.js';
import {
  ANSWERABLE, cleanReason, closeProposals, isDue, listProposalsFor, mayDismiss, mayRaiseAgain, mayReopen, ProposalInputError, raiseAgain, respondToProposal, whatIsMissing, type ResponseKind,
} from '../lib/meeting-assistant/proposals.js';
import { decisionRecordedAs, mayRunProposal } from '../lib/meeting-assistant/proposal-run.js';
import { MAX_PER_CALL, noticeIfCapReached, periodStart } from '../lib/meeting-assistant/decision-watcher.js';
import { updateStatement } from '../lib/meeting-assistant/named-people.js';
import type { MinutesRecord, Proposal, TranscriptLine } from '../lib/meeting-assistant/types.js';
import { getProject } from '../providers/projects.js';
import { config } from '../config.js';

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

/**
 * Every route here is about one person: writes are attributed to them, and reads (state, the transcript, their turns, the minutes)
 * show what was said while they were there. A masquerade splits that identity, so every method is refused (audit B5).
 */
function refuseMasquerade(req: Request, res: Response, next: NextFunction): void {
  if (resolveSession(req)?.act) {
    res.status(403).json({ error: 'stop masquerading to use the meeting assistant; it acts for, and shows words to, the person who was there', code: 'MASQUERADING' });
    return;
  }
  next();
}

meetingAssistantRouter.use(flagGate, staffTenantGate, callTenantAgrees, refuseMasquerade); // Work's calls for Work, an interview's for the interviews tenant

/** Attendance is written only for someone not yet on the record, so a poll from a known attendee reads and writes nothing more. */
async function attendOnce(callId: string, userId: string): Promise<void> {
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record || record.state === 'left' || record.attendees.includes(userId)) return;
  await store.attend(callId, userId);
}

const seatOf = async (req: Request): Promise<{ session: Session; callId: string }> => {
  const session = sessionOf(req); const callId = callIdOf(req);
  await callChatRuntime().assertMember(callId, session, false);
  // A connected seat while the assistant is in the call is attendance (the store ignores it once the assistant has left, audit M1).
  await attendOnce(callId, session.sub).then(() => ackElsewhere(callId, session.sub)).catch(() => undefined); // and an acknowledgement given elsewhere (policy.ts)
  return { session, callId };
};

/** Seat holders who have not acknowledged: everyone known to be present or to have been, minus the inviter and the acked. */
async function mustAck(record: AssistantRecord, callId: string): Promise<string[]> {
  const live = (await callChatRuntime().seatedUsers(callId).catch(() => [])).filter((u) => u.active).map((u) => u.userId);
  // After Milo was invited back, the people of earlier periods who are not here now owe nothing yet: they are asked when they return.
  const earlier = recordSession(record).periods?.length ? [] : record.attendees;
  const everyone = new Set([...record.presentAtInvite, ...earlier, ...live]);
  return [...everyone].filter((u) => u !== record.invitedBy && !record.acked.includes(u) && ackedInCall(record, u)).sort(); // the in-call notice's people only
}

/** Whether the call's audio reaches Milo: `connecting` while it joins or between live sessions, `no-audio` once the tap gave up. */
export function hearingOf(state: AssistantRecord['state'], sessionOpen: boolean | null, tap: 'ok' | 'connecting' | 'no-audio'): 'ok' | 'connecting' | 'no-audio' {
  if (state === 'invited') return 'connecting';
  if (state !== 'listening') return 'ok';
  if (sessionOpen === false) return 'connecting';
  return tap;
}

/**
 * What Milo is working on right now, for everyone in the call: the asker's name and whether it is a lookup or a change, never what
 * was asked. A read waiting on (or running in) the asker's browser, and a confirmed change being made. A change still waiting for
 * its confirmation is not "working": its card says it waits. Proposal runs are left out (their own card shows them).
 * Also, without content, the change cards still waiting for a decision: their expiry, and whether they wait on this viewer.
 */
async function turnsView(callId: string, viewer: string, now: number) {
  const turns = (await assistantStore().listTurns(callId, { statuses: ['pending', 'running'] }).catch(() => []))
    .filter((t) => !t.proposalId && t.expiresAt > now);
  const working = turns.filter((t) => t.kind !== 'write' || t.status === 'running');
  const names = new Map<string, string>();
  for (const id of new Set(working.map((t) => t.askedBy))) names.set(id, await nameOf(id).catch(() => 'Someone'));
  return {
    openRequests: working.map((t) => ({ askerName: names.get(t.askedBy) ?? 'Someone', kind: t.kind === 'write' ? 'change' as const : 'lookup' as const })),
    waitingActions: turns.filter((t) => t.kind === 'write' && t.status === 'pending' && t.actionId)
      .map((t) => ({ actionId: t.actionId!, expiresAt: t.expiresAt, mine: t.askedBy === viewer })),
  };
}

/** What one extend adds to the ceiling now: the default minutes, up to the hard maximum (0 there), as the orchestrator's extend computes it. */
export const extendSecondsOf = (record: AssistantRecord, limits: AssistantLimits = assistantLimits()): number => {
  const ceiling = recordSession(record, limits.maxSeconds).ceilingSeconds;
  return Math.max(0, Math.min(limits.hardMaxSeconds, ceiling + limits.maxSeconds) - ceiling);
};

async function view(record: AssistantRecord | null, callId: string, session: Session) {
  if (!record) return { callId, state: 'none' as const };
  const runtime = assistantRuntime();
  const present = record.state === 'invited' || record.state === 'listening' || record.state === 'paused';
  const turns = present ? await turnsView(callId, session.sub, runtime.deps.clock()) : { openRequests: [], waitingActions: [] };
  const owing = await mustAck(record, callId); const invitedByName = (await getUser(record.invitedBy).catch(() => null))?.displayName ?? null; // null: the directory lost them, the notice says "A participant"
  return {
    callId, state: record.state, lobby: record.lobby, initiativeId: record.initiativeId,
    invitedBy: record.invitedBy, invitedByName, invitedAt: record.invitedAt, pausedBy: record.pausedBy, leftAt: record.leftAt, leftBy: record.leftBy,
    // Who dismissed Milo, by name, so the bar can say why it left ('system' is Milo itself leaving: its time limit or a lost connection).
    leftByName: record.leftBy && record.leftBy !== 'system' ? await nameOf(record.leftBy).catch(() => null) : null,
    // After Milo left: whether it can be invited back, or why never in this call (the record was deleted, the call's listening time is used up).
    ...(record.state === 'left' ? {
      rejoin: await rejoinStanding(record, runtime.deps.clock()),
      // The earlier period's run is still finishing: an invitation back waits for it, and the bar says Milo is leaving.
      leaving: runtime.stillLeaving(callId, periodOf(record) + 1),
    } : {}),
    // While Milo is here: whether it could be invited back if it left now (by the listening time; a record is never deleted while Milo
    // is in the call), so the dismissal question promises an invitation back only when one would be allowed.
    ...(present ? { rejoinLater: rejoinStandingByTime(listeningSecondsOf(record, runtime.deps.clock()), assistantLimits().hardMaxSeconds) } : {}),
    // What "Extend time" would add now (0 at the hard maximum: it is then not offered).
    ...(record.state === 'listening' || record.state === 'paused' ? { extendSeconds: extendSecondsOf(record, await limitsOfCall(policyCallOf(record))) } : {}),
    // This person acknowledged in an earlier period of this call: their notice says they acknowledge once more.
    youAckedBefore: ackedBefore(record, session.sub),
    // Which period of Milo in this call this is (1 for the first); a notice closed in an earlier period shows again in a new one.
    period: (recordSession(record).periods?.length ?? 0) + 1,
    mustAck: owing, youMustAck: owing.includes(session.sub),
    counters: { requests: record.requests, linesStored: record.linesStored },
    refusedCalls: recordSession(record).refusedCalls,
    listeningSeconds: Math.floor(listeningSecondsOf(record, assistantRuntime().deps.clock())),
    ceilingSeconds: recordSession(record, assistantLimits().maxSeconds).ceilingSeconds,
    pendingRequests: record.pendingRequests,
    voice: record.voice === true,
    hearing: hearingOf(record.state, runtime.sessionOpen(callId), tapArmer().hearing(callId)),
    ...turns,
    ...runtime.voiceStats(callId),
    ...runtime.callStats(callId),
  };
}

/** The call's record name for Milo's instructions: the initiative's name, or null. */
async function recordNameOf(initiativeId: string | null): Promise<string | null> {
  if (!initiativeId) return null;
  try { return (await getProject(initiativeId))?.name ?? null; } catch { return null; }
}

/** Start (or restart) the live session for a record that already exists. */
async function startSession(callId: string, record: AssistantRecord, session: Session): Promise<void> {
  const names = await Promise.all([...new Set([...record.presentAtInvite, session.sub])].map((u) => nameOf(u)));
  await assistantRuntime().start({ callId, tenant: record.tenant, inviterId: record.invitedBy, roster: names, recordName: await recordNameOf(record.initiativeId), lobby: record.lobby });
}

/** Arm the media server's tap for a call that is listening now. A failure here never undoes the listening: the call chat says so when the tap cannot be made. */
async function armAudio(callId: string, pre: Preflight | null): Promise<void> {
  if (!pre) return;
  // The channel goes on the record first, so a later boot can delete a tap this process leaves behind (audit M5).
  if (pre.channelArn) await assistantStore().patchSession(callId, { channelArn: pre.channelArn }).catch(() => null);
  try { await tapArmer().arm(callId, pre.channelArn); } catch (e) { console.warn('[meeting-assistant] arming the audio failed', (e as Error).message); }
}

const noteSeat = async (callId: string, session: Session) => { await attendOnce(callId, session.sub); };

// Every sentence below names the assistant through ASSISTANT_NAME (lib/meeting-assistant/chat-types.ts), never a literal name.
const NOT_HERE = `${ASSISTANT_NAME} is not in this call.`;
const ALREADY_LEFT = `${ASSISTANT_NAME} has already left this call.`;
/** A pause, resume or dismiss the record's state does not allow right now, in words (never the state's name). */
function cannotMoveNow(state: AssistantRecord['state']): string {
  if (state === 'invited') return `${ASSISTANT_NAME} is still joining. Try again in a moment.`;
  if (state === 'left') return ALREADY_LEFT;
  return `${ASSISTANT_NAME} could not do that just now. Try again in a moment.`;
}

/**
 * A money refusal from the spend holds, sent with its status, headers and every machine-readable field unchanged, and its `error`
 * replaced by a plain sentence for the person who clicked: what happened, and whether trying again helps. The original reason
 * goes to the server log.
 */
function sendRefusal(res: Response, refusal: SpendRefusal, action: 'invite' | 'resume' | 'extend'): void {
  const body = refusal.body as Record<string, unknown>;
  const lead = action === 'invite' ? `${ASSISTANT_NAME} can't join` : action === 'resume' ? `${ASSISTANT_NAME} can't resume` : `${ASSISTANT_NAME} can't get more time`;
  const gate = typeof body['gate'] === 'string' ? body['gate'] : '';
  const retryAfter = typeof body['retryAfterS'] === 'number' ? body['retryAfterS'] : null;
  const words =
    refusal.status === 409 && body['confirmFlag'] ? (action === 'invite' ? `This would put ${ASSISTANT_NAME}'s time over your budget.` : `This would put ${ASSISTANT_NAME}'s time over the budget of the person who invited it. Only they can choose to go ahead.`)
    : refusal.status === 429 ? `${lead} right now because too much is already running. Try again${retryAfter ? ` in about ${Math.max(1, Math.round(retryAfter / 60))} minute${Math.round(retryAfter / 60) > 1 ? 's' : ''}` : ' shortly'}.`
    : refusal.status === 423 ? `${lead} because spending is paused here. Ask an admin.`
    : refusal.status === 503 ? `${lead} right now because its budget could not be checked. Try again in a few minutes; if it keeps happening, ask an admin.`
    : gate === 'spend-hold' ? `${lead} in a call that is not part of an initiative here. Start the call from an initiative's page, or ask an admin.`
    : `${lead} because the budget for this has reached its limit. Trying again won't help; ask an admin to raise it.`;
  console.warn(`[meeting-assistant] ${action} refused (${refusal.status}${gate ? ` ${gate}` : ''}): ${String(body['error'] ?? '')}`);
  if (refusal.headers) res.set(refusal.headers);
  res.status(refusal.status).json({ ...body, error: words });
}

meetingAssistantRouter.post('/invite', requireAction('InviteMeetingAssistant'), asyncHandler(async (req, res) => {
  const { session, callId } = await inviterSeatOf(req);
  const store = assistantStore();
  const startListening = () => {
    try { assistantIntake().start(callId); } catch (e) {
      if (e instanceof TranscriptSourceNotConfigured) { console.warn('[meeting-assistant] live transcripts are not configured'); throw new AppError(503, NOT_SET_UP); }
      throw e;
    }
  };
  const existing = await store.get(callId);
  if (existing?.state === 'left') { await rejoin(req, res, session, existing, startListening); return; }
  if (existing) {
    startListening(); await noteSeat(callId, session);
    // A record stuck in `invited` (the first request stopped before it moved on): the inviter's repeat finishes it, once (the move is conditional).
    let current = existing; let completed = false;
    if (existing.state === 'invited' && existing.invitedBy === session.sub) {
      const moved = await store.transition(callId, { from: ['invited'], to: 'listening', by: session.sub, at: Date.now() });
      if (moved) { current = moved; completed = true; }
    }
    // After a restart a listening record has no live session in this process: start one again on a repeated invite.
    if (current.state === 'listening' && !assistantRuntime().isRunning(callId)) {
      const pre = await preflightAudio(session, callId, current.lobby);
      const started = await startSession(callId, current, session).then(() => true, () => false);
      if (started) await armAudio(callId, pre);
    }
    if (completed) await postNoticeQuietly(callId, noticeText.joined(await nameOf(session.sub, session.name), config.meetingAssistant.transcriptRetentionDays) + noticeText.nameTwins(await Promise.all([...new Set([...current.presentAtInvite, session.sub])].map((u) => nameOf(u)))));
    res.json(await view((await store.get(callId)) ?? current, callId, session)); return;
  }
  if (!sessionAvailable()) { console.warn('[meeting-assistant] no live session provider is configured'); throw new AppError(503, NOT_SET_UP); }

  const runtime = callChatRuntime();
  const lobby = await runtime.lobbyOf(callId);
  if (!lobby) throw new NotFoundError(CALL_ENDED);
  const present = (await runtime.seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId);
  if (!present.includes(session.sub)) present.push(session.sub);
  // Real audio: the three media settings and the call's channel, found by the server from the call, or a 503 here and nothing started.
  const pre = await preflightAudio(session, callId, lobby);
  startListening();
  // Money first (decision 10): the ceiling's minutes are held against the inviter. A refusal ends the invite here, in the shape
  // the voice mint gives, and Milo never joins.
  const initiativeId = initiativeOfLobby(lobby);
  const ceilingSeconds = (await limitsOfCall({ callId, lobby, tenant: session.tenant })).maxSeconds;
  const spend = assistantSpend(); const payer = payerFields({ callId, lobby, tenant: session.tenant, initiativeId, invitedBy: session.sub }); // the call's policy says whose
  const held = await spend.reserve({
    callId, tenant: session.tenant, ...payer, seconds: ceilingSeconds, part: 0,
    ...(confirmOverBudget(req) && payer.inviterId === session.sub ? { confirmOverUserBudget: true } : {}),
  });
  if (!held.ok) {
    assistantIntake().stop(callId);
    sendRefusal(res, held.refusal, 'invite');
    return;
  }
  const names = await Promise.all([...new Set(present)].map((u) => nameOf(u)));
  const startCtx: StartContext = { callId, tenant: session.tenant, inviterId: session.sub, roster: names, recordName: await recordNameOf(initiativeId), lobby };
  const giveBack = async () => { assistantIntake().stop(callId); await spend.release(held.holdId ? [held.holdId] : []); };
  try { await assistantRuntime().start(startCtx); } catch (e) {
    await giveBack();
    console.warn('[meeting-assistant] the live session did not start', (e as Error).message);
    throw new AppError(503, `${ASSISTANT_NAME} could not start. Try again in a moment.`);
  }
  // `invited` is the moment of the invite; the inviter acknowledges by inviting, so listening starts at once.
  const invitedAt = assistantRuntime().deps.clock();
  let created: Awaited<ReturnType<typeof store.create>>;
  try {
    created = await store.create({
      callId, tenant: session.tenant, lobby, initiativeId, state: 'invited',
      invitedBy: session.sub, invitedAt, pausedBy: null, leftAt: null, leftBy: null,
      acked: [session.sub, ...(await ackedElsewhereAt({ callId, lobby, tenant: session.tenant }, present, session.sub))], attendees: [...new Set(present)], presentAtInvite: [...new Set(present)],
      requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [],
      session: { ...newAssistantSession(ceilingSeconds), listeningSince: invitedAt },
    });
  } catch (e) { await assistantRuntime().stop(callId); await giveBack(); throw e; }
  const { record } = created;
  if (!created.created) {
    // Two invites at once: the other request wrote the record first. This request's hold is a second one for the same call, so it goes back,
    // no second notice is posted, and the caller gets the record that exists (the other request arms the audio).
    await spend.release(held.holdId ? [held.holdId] : []);
    res.json(await view(record, callId, session));
    return;
  }
  const listening = await store.transition(callId, { from: ['invited'], to: 'listening', by: session.sub, at: Date.now() });
  await armAudio(callId, pre);
  await postNoticeQuietly(callId, noticeText.joined(await nameOf(session.sub, session.name), config.meetingAssistant.transcriptRetentionDays) + noticeText.nameTwins(names));
  res.status(201).json(await view(listening ?? record, callId, session));
}));

/** Why Milo cannot be invited back into a call it left, for good: the record was deleted, or the call used all the listening time it may have. */
export const REJOIN_DELETED = `This call's record was deleted, so ${ASSISTANT_NAME} cannot join it again.`;
export const REJOIN_LIMIT = `${ASSISTANT_NAME} has already listened to this call for as long as it can.`;
/** Less than REJOIN_MIN_SECONDS of the call's listening time is left: an invitation back would be over almost at once. */
export const REJOIN_ALMOST = `${ASSISTANT_NAME} has almost used this call's listening time and cannot be invited back.`;
export const REJOIN_MIN_SECONDS = 5 * 60;
export type RejoinStanding = 'allowed' | 'deleted' | 'limit' | 'almost';
/** Milo was dismissed a moment ago and is still leaving (its notice, its settlement and its session closing take a second or two). */
export const REJOIN_STILL_LEAVING = `${ASSISTANT_NAME} is still leaving this call. Try again in a moment.`;
/** How long an invitation back waits for Milo's earlier leave to finish before it answers REJOIN_STILL_LEAVING. Tests shorten it. */
let rejoinWaitMs = 8_000;
export function setRejoinWaitMs(ms: number | null): void { rejoinWaitMs = ms ?? 8_000; }

/**
 * Seconds Milo listened in this call so far, every period included. A `left` record should have no period open; one a dead process left
 * open counts only to that process's last heartbeat (never past the leave), as the reconcile closes it, never to now: otherwise a call
 * would read as having used its whole listening time just because time passed.
 */
export const heardSoFar = (record: AssistantRecord, now: number): number => {
  const s = recordSession(record);
  if (record.state !== 'left' || s.listeningSince == null) return listeningSecondsOf(record, now);
  const aliveAt = s.lastAliveAt ?? record.leftAt ?? s.listeningSince;
  return listeningSecondsOf(record, Math.min(record.leftAt ?? now, now, Math.max(s.listeningSince, aliveAt)));
};

/** By the listening time alone: used up, less than REJOIN_MIN_SECONDS left, or enough for an invitation back. */
export const rejoinStandingByTime = (heardSeconds: number, hardMaxSeconds: number): RejoinStanding =>
  heardSeconds >= hardMaxSeconds ? 'limit' : hardMaxSeconds - heardSeconds < REJOIN_MIN_SECONDS ? 'almost' : 'allowed';

/** Whether a call Milo left may have it back: no for good once its record was deleted, or its whole-call listening time is (almost) used up. */
async function rejoinStanding(record: AssistantRecord, now: number): Promise<RejoinStanding> {
  if ((await assistantStore().getMinutes(record.callId).catch(() => null))?.deleted) return 'deleted';
  return rejoinStandingByTime(heardSoFar(record, now), assistantLimits().hardMaxSeconds);
}

/**
 * Milo is invited back into a call it left (`POST /invite` on a `left` record): a new listening period on the same record. Anyone who may
 * invite and holds a seat may do it. The earlier period was settled when Milo left (settled here from the record first if it was not);
 * a fresh hold is reserved against the person inviting it back for the time left under the hard maximum, under the next ledger part; then
 * the live session starts, and one conditional step moves the record back to listening. Of two at once one wins; the other gives its
 * hold back and answers with the record as it stands. Everyone but the person inviting owes a new acknowledgement; the voice is off.
 */
async function rejoin(req: Request, res: Response, session: Session, read: AssistantRecord, startListening: () => void): Promise<void> {
  const store = assistantStore(); const callId = read.callId; const runtime = assistantRuntime();
  const limits = await limitsOfCall({ callId, lobby: read.lobby, tenant: read.tenant });
  // The earlier period's run may still be stopping (a dismissal's notice, settlement and closing session take a moment): wait for it before
  // anything is settled or held, so its stop never closes or bills the new period. Nothing is held when it takes too long.
  if (!(await runtime.settled(callId, rejoinWaitMs, periodOf(read) + 1))) throw new AppError(409, REJOIN_STILL_LEAVING);
  const before = (await store.get(callId)) ?? read;
  // Someone else brought Milo back meanwhile: the caller sees the record as it stands, and nothing of that period is touched here.
  if (before.state !== 'left') { res.json(await view(before, callId, session)); return; }
  const standing = await rejoinStanding(before, runtime.deps.clock());
  if (standing === 'deleted') throw new AppError(409, REJOIN_DELETED);
  if (standing === 'limit') throw new AppError(409, REJOIN_LIMIT);
  if (standing === 'almost') throw new AppError(409, REJOIN_ALMOST);
  if (!sessionAvailable()) { console.warn('[meeting-assistant] no live session provider is configured'); throw new AppError(503, NOT_SET_UP); }
  // The earlier period's money is booked before a new one starts: a leave whose settlement did not finish is settled from the record now.
  let prior = before;
  if (!recordSession(prior).settled || recordSession(prior).listeningSince != null) {
    await settleFromRecord(callId, { clock: runtime.deps.clock, period: periodOf(prior) }); // only the period that left
    prior = (await store.get(callId)) ?? prior;
    if (!recordSession(prior).settled) throw new AppError(503, `${ASSISTANT_NAME} could not start. Try again in a moment.`);
  }
  if (prior.state !== 'left' || prior.leftAt === null) { res.json(await view(prior, callId, session)); return; }
  const s = recordSession(prior, limits.maxSeconds);
  const heard = s.settledListeningSeconds + s.listeningSeconds;
  const grant = Math.min(limits.maxSeconds, limits.hardMaxSeconds - heard);
  if (grant <= 0) throw new AppError(409, REJOIN_LIMIT);
  const present = (await callChatRuntime().seatedUsers(callId).catch(() => [])).filter((u) => u.active).map((u) => u.userId);
  if (!present.includes(session.sub)) present.push(session.sub);
  const pre = await preflightAudio(session, callId, prior.lobby);
  startListening();
  const part = Math.max(s.extensions, s.ledgerPart ?? 0) + 1;
  const spend = assistantSpend(); const payer = payerFields(prior, session.sub);
  // The person inviting Milo back owns this hold (the call's policy may say otherwise), so their own confirmation past their budget counts (as on a first invite).
  const held = await spend.reserve({
    callId, tenant: prior.tenant, ...payer, seconds: grant, part,
    ...(confirmOverBudget(req) && payer.inviterId === session.sub ? { confirmOverUserBudget: true } : {}),
  });
  const stopIntakeIfLeft = async () => { if ((await store.get(callId).catch(() => null))?.state === 'left') assistantIntake().stop(callId); };
  if (!held.ok) { await stopIntakeIfLeft(); sendRefusal(res, held.refusal, 'invite'); return; }
  const giveBack = async () => { await spend.release(held.holdId ? [held.holdId] : []); };
  const names = await Promise.all([...new Set(present)].map((u) => nameOf(u)));
  try { await runtime.start({ callId, tenant: prior.tenant, inviterId: session.sub, roster: names, recordName: await recordNameOf(prior.initiativeId), fromSeq: prior.nextSeq, period: periodOf(prior) + 1, lobby: prior.lobby }); } catch (e) {
    await giveBack(); await stopIntakeIfLeft();
    if (e instanceof RunStillStopping) throw new AppError(409, REJOIN_STILL_LEAVING); // a leave that began after the wait above
    console.warn('[meeting-assistant] the live session did not start', (e as Error).message);
    throw new AppError(503, `${ASSISTANT_NAME} could not start. Try again in a moment.`);
  }
  const now = runtime.deps.clock();
  // Who acknowledged in the period that closes is kept with it: their notice in the new period says they acknowledge once more.
  const period = { invitedBy: prior.invitedBy, from: s.periodFrom ?? prior.invitedAt, leftAt: prior.leftAt, leftBy: prior.leftBy, part: s.periodPart ?? 0, acked: [...new Set([prior.invitedBy, ...prior.acked])] };
  const patch: Partial<AssistantSession> = {
    // A new ledger period, as a resume after a settlement starts one: what was heard stays on the call's clock, so the hard maximum
    // holds for the call as a whole, and the ceiling is what was heard plus this grant.
    settled: false, ledgerPart: part, extensions: part, holds: [], listeningSeconds: 0, listeningSince: now, settledListeningSeconds: heard,
    ceilingSeconds: heard + grant, warned: false, replacements: 0, usageSeconds: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, lastAliveAt: now,
    periodFrom: now, periods: [...(s.periods ?? []), period], periodPart: part, ackedEver: [...new Set([...(s.ackedEver ?? []), prior.invitedBy, ...prior.acked])], // `acked` starts again; who acknowledged before stays known
    // The request cap counts this period on its own (each period is paid for on its own), and its notices can be said again.
    requestsBefore: prior.requests, limitNoticed: false,
  };
  let moved: AssistantRecord | null = null;
  try { moved = await store.rejoin(callId, { leftAt: prior.leftAt, by: session.sub, at: now, present, session: patch }); } catch (e) {
    await giveBack(); await stopIntakeIfLeft();
    if ((await store.get(callId).catch(() => null))?.state === 'left') await runtime.stop(callId).catch(() => undefined);
    throw e;
  }
  if (!moved) {
    // Another invitation back won (or the record moved on, or its words were erased meanwhile): this hold goes back. A run this request
    // started for a record that is still left is stopped; one the winner uses is left alone. A deleted record answers why; otherwise the
    // caller sees the record as it stands.
    await giveBack();
    const current = await store.get(callId);
    if (!current || current.state === 'left') { assistantIntake().stop(callId); await runtime.stop(callId).catch(() => undefined); }
    if ((await store.getMinutes(callId).catch(() => null))?.deleted) throw new AppError(409, REJOIN_DELETED);
    res.json(await view(current, callId, session));
    return;
  }
  // The call may have ended while Milo was being invited back: its end found Milo still out and did nothing for this period. Milo then
  // leaves with the call now, the way a call end takes it out (the new period closed and settled, its hold settled with it), and the
  // person is told. A lookup that fails is not an end.
  if ((await callChatRuntime().lobbyOf(callId).catch(() => prior.lobby)) === null) {
    await endWithCall(callId);
    throw new AppError(409, CALL_ENDED);
  }
  runtime.setVoice(callId, false);
  await armAudio(callId, pre);
  await assistantAudio().refresh(callId).catch(() => undefined); // only the person inviting Milo back is heard until the others acknowledge
  await postNoticeQuietly(callId, noticeText.rejoined(await nameOf(session.sub, session.name), config.meetingAssistant.transcriptRetentionDays, Math.round(grant / 60)) + noticeText.nameTwins(names));
  res.json(await view(moved, callId, session));
}

const confirmOverBudget = (req: Request): boolean => (req.body as { confirmOverUserBudget?: unknown } | undefined)?.confirmOverUserBudget === true;

/** A call is asked at most this often to have the inviter step in, however many times a refused resume or extend is clicked. */
export const INVITER_ASK_EVERY_MS = 2 * 60_000;
/** Per runtime (one per process; a test's fresh runtime starts clean): when each call last asked its inviter. */
const inviterAsked = new WeakMap<object, Map<string, number>>();
export const inviterAskLine = (inviter: string, asker: string, what: 'resume' | 'extend'): string =>
  `${asker} could not ${what === 'resume' ? `resume ${ASSISTANT_NAME}` : `extend ${ASSISTANT_NAME}'s time`} because it would go past ${inviter}'s budget. ${inviter}, you can ${what === 'resume' ? `resume ${ASSISTANT_NAME}` : `extend ${ASSISTANT_NAME}'s time`} and confirm the cost.`;

/**
 * A resume or an extend was refused over the inviter's budget, by someone who is not the inviter: they cannot confirm past it, so one
 * chat line asks the inviter, by name, to do it. Never for the inviter (they get the confirmation ask), and once per call per window.
 */
async function askInviterQuietly(callId: string, inviterId: string, session: Session, what: 'resume' | 'extend'): Promise<void> {
  if (session.sub === inviterId) return;
  const runtime = assistantRuntime(); const now = runtime.deps.clock();
  let asked = inviterAsked.get(runtime);
  if (!asked) { asked = new Map(); inviterAsked.set(runtime, asked); }
  const last = asked.get(callId);
  if (last !== undefined && now - last < INVITER_ASK_EVERY_MS) return;
  asked.set(callId, now);
  await postNoticeQuietly(callId, inviterAskLine(await nameOf(inviterId), await nameOf(session.sub, session.name), what)).catch(() => undefined);
}

/** Shared by pause, resume and dismiss: do the move, or say why not. A repeat of the state you are already in is a success. */
function move(to: 'paused' | 'listening' | 'left', from: AssistantRecord['state'][]) {
  return asyncHandler(async (req, res) => {
    const { session, callId } = await seatOf(req);
    const store = assistantStore();
    await noteSeat(callId, session);
    const before = await store.get(callId);
    if (to === 'listening' && before?.state === 'paused' && !sessionAvailable()) { console.warn('[meeting-assistant] no live session provider is configured'); throw new AppError(503, NOT_SET_UP); }
    // Resuming listens again: a new token and a new tap, so the channel is looked up again first (503, still paused, when it cannot be).
    const pre = to === 'listening' && before?.state === 'paused' ? await preflightAudio(session, callId, before.lobby) : null;
    // Leaving: whoever holds a seat right now was there while Milo was (read before the record becomes `left`, which closes attendance).
    if (to === 'left') for (const u of await callChatRuntime().seatedUsers(callId).catch(() => [])) if (u.active) await attendOnce(callId, u.userId);
    // A resume after a settlement (the reconcile after a restart booked the spend and released the hold) starts a fresh period: a fresh
    // hold first, so a refusal ends the resume here with the record still paused (audit M5).
    let fresh: { holdId: string | null; patch: Partial<AssistantSession> } | null = null;
    if (to === 'listening' && before?.state === 'paused' && recordSession(before).settled) {
      const prior = recordSession(before); const limits = assistantLimits();
      const part = Math.max(prior.extensions, prior.ledgerPart ?? 0) + 1; const payer = payerFields(before);
      const held = await assistantSpend().reserve({
        callId, tenant: before.tenant, ...payer, seconds: limits.maxSeconds, part,
        // As on invite and extend: going past a budget is the budget owner's choice, so only the confirmation of the person it counts against (the inviter) counts.
        ...(confirmOverBudget(req) && session.sub === payer.inviterId ? { confirmOverUserBudget: true } : {}),
      });
      if (!held.ok) {
        await askInviterQuietly(callId, payer.inviterId, session, 'resume');
        sendRefusal(res, held.refusal, 'resume'); return;
      }
      fresh = { holdId: held.holdId, patch: {
        settled: false, ledgerPart: part, extensions: part, holds: [], listeningSeconds: 0, listeningSince: null, limitNoticed: false,
        // The ceiling counts the whole call: what was settled stays on the clock, so a restart does not buy a second full period.
        settledListeningSeconds: prior.settledListeningSeconds + prior.listeningSeconds, ceilingSeconds: prior.ceilingSeconds, warned: prior.warned,
        replacements: 0, usageSeconds: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0,
      } };
    }
    const giveBackFresh = async () => { if (fresh) await assistantSpend().release(fresh.holdId ? [fresh.holdId] : []); };
    const done = await store.transition(callId, { from, to, by: session.sub, at: Date.now() });
    if (!done) await giveBackFresh();
    if (done) {
      const runtime = assistantRuntime();
      if (to === 'listening') {
        try {
          if (fresh) await store.patchSession(callId, fresh.patch);
          // After a restart nothing in this process is hearing the call's captions: start the intake again (a no-op when it is running).
          try { assistantIntake().start(callId); } catch (e) { if (e instanceof TranscriptSourceNotConfigured) { console.warn('[meeting-assistant] live transcripts are not configured'); throw new AppError(503, NOT_SET_UP); } throw e; }
          if (runtime.isRunning(callId)) await runtime.resume(callId); else await startSession(callId, (await store.get(callId)) ?? done, session);
        } catch (e) {
          // No session to listen with: back to paused, and say so. A fresh hold is given back and the period stays settled.
          await giveBackFresh();
          if (fresh) await store.patchSession(callId, { settled: true }).catch(() => null);
          await store.transition(callId, { from: ['listening'], to: 'paused', by: session.sub, at: Date.now() });
          if (e instanceof AppError) throw e;
          console.warn('[meeting-assistant] resume failed', (e as Error).message);
          throw new AppError(503, `${ASSISTANT_NAME} could not start. Try again in a moment.`);
        }
        await armAudio(callId, pre);
      }
      if (to === 'listening') await postNoticeQuietly(callId, noticeText.resumed(await nameOf(session.sub, session.name)));
      // Pause and dismiss: the same steps "Milo, pause" and "Milo, leave" said in the call take (the notice, and for a dismiss the
      // proposals closed, absent people told, the run stopped and the minutes settled).
      else await runtime.afterMove(callId, to, done, { userId: session.sub, name: session.name });
      res.json(await view(await store.get(callId), callId, session));
      return;
    }
    const current = await store.get(callId);
    if (!current) throw new NotFoundError(NOT_HERE);
    if (current.state === to) { res.json(await view(current, callId, session)); return; }
    throw new AppError(409, cannotMoveNow(current.state));
  });
}
meetingAssistantRouter.post('/pause', move('paused', ['listening']));
meetingAssistantRouter.post('/resume', move('listening', ['paused']));
meetingAssistantRouter.post('/dismiss', move('left', ['invited', 'listening', 'paused']));

meetingAssistantRouter.post('/ack', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const store = assistantStore();
  const current = await store.get(callId);
  if (!current) throw new NotFoundError(NOT_HERE);
  if (current.state === 'left') throw new AppError(409, ALREADY_LEFT); if (!ackedInCall(current, session.sub)) throw new AppError(409, ACKED_ELSEWHERE);
  const acked = await store.ack(callId, session.sub);
  await assistantAudio().refresh(callId); // this person's audio is admitted from now on, not at the next gate refresh
  res.json(await view(acked, callId, session));
}));

/** Milo speaking aloud is a per-call switch (decision 4), off until someone with the invite right turns it on; the call is told either way. */
meetingAssistantRouter.post('/voice', requireAction('InviteMeetingAssistant'), asyncHandler(async (req, res) => {
  const { session, callId } = await inviterSeatOf(req);
  const on = (req.body as { on?: unknown } | undefined)?.on;
  if (typeof on !== 'boolean') throw new ValidationError('on must be true or false');
  const store = assistantStore();
  const current = await store.get(callId);
  if (!current) throw new NotFoundError(NOT_HERE);
  if (current.state === 'left') throw new AppError(409, ALREADY_LEFT);
  if (current.voice === true === on) { res.json(await view(current, callId, session)); return; }
  const updated = await store.setVoice(callId, on);
  if (!updated) throw new NotFoundError(NOT_HERE);
  assistantRuntime().setVoice(callId, on);
  const who = await nameOf(session.sub, session.name);
  await postNoticeQuietly(callId, on ? noticeText.voiceOn(who) : noticeText.voiceOff(who));
  res.json(await view(updated, callId, session));
}));

/**
 * A person binds their own media participant id (decision 8: audio is mixed in only for people who have acknowledged, and the
 * taps name participants, not people). The media server mints the id as `${userId}-${Date.now().toString(36)}` from the same `sub`
 * platform-api passes at join (and the call-binding proof pins to this session's `sub`), so the id must start with the caller's
 * own `sub` and a base36 stamp; nobody can claim another person's id, and an id already bound to someone else is refused.
 */
const PARTICIPANT_STAMP = /^[0-9a-z]{1,16}$/;
meetingAssistantRouter.post('/participant', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const id = (req.body as { participantId?: unknown } | undefined)?.participantId;
  if (typeof id !== 'string' || id.length < 3 || id.length > 256) throw new ValidationError('participantId must be a string');
  const prefix = `${session.sub}-`;
  if (!id.startsWith(prefix) || !PARTICIPANT_STAMP.test(id.slice(prefix.length))) throw new AppError(403, 'You can only bind your own media participant id');
  const record = await assistantStore().get(callId);
  if (!record) throw new NotFoundError(NOT_HERE);
  if (record.state === 'left') throw new AppError(409, ALREADY_LEFT);
  const out = await assistantAudio().bindParticipant(callId, id, session.sub);
  if (out === 'taken') throw new AppError(409, 'That media participant id is already bound to someone else');
  if (out === 'too-many') throw new AppError(409, 'Too many media participant ids are bound for this call');
  res.json({ callId, participantId: id, bound: true });
}));

/** Anyone who may invite Milo may extend its time (decision 10): the default minutes, once per request, up to the hard maximum. */
meetingAssistantRouter.post('/extend', requireAction('InviteMeetingAssistant'), asyncHandler(async (req, res) => {
  const { session, callId } = await inviterSeatOf(req);
  await noteSeat(callId, session);
  const out = await assistantRuntime().extend(callId, session, confirmOverBudget(req));
  if (out.ok) { res.json(await view(await assistantStore().get(callId), callId, session)); return; }
  if (out.why === 'refused') {
    const record = await assistantStore().get(callId);
    if (record) await askInviterQuietly(callId, payerFields(record).inviterId, session, 'extend');
    sendRefusal(res, out.refusal, 'extend'); return;
  }
  if (out.why === 'no-assistant') throw new NotFoundError(NOT_HERE);
  if (out.why === 'left') throw new AppError(409, ALREADY_LEFT);
  const atEnd = await assistantStore().get(callId);
  if (atEnd && policyForLobby(atEnd.lobby).listeningLimitMinutes) throw new AppError(409, CANNOT_LISTEN_PAST_ROUND);
  throw new AppError(409, `${ASSISTANT_NAME} is already at its longest time for this call (${Math.round(assistantLimits().hardMaxSeconds / 60)} minutes), so it cannot be extended further.`);
}));

/** Only the person an action was offered to decides it (decision 5). Everyone else, and anyone with no such action: no. */
meetingAssistantRouter.post('/actions/:actionId/decision', asyncHandler(async (req, res) => {
  const { session, callId } = await seatOf(req);
  const actionId = req.params['actionId'];
  if (typeof actionId !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(actionId)) throw new ValidationError('Invalid action id');
  const decision = (req.body as { decision?: unknown } | undefined)?.decision;
  if (decision !== 'confirm' && decision !== 'decline') throw new ValidationError("decision must be 'confirm' or 'decline'");
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record) throw new NotFoundError(NOT_HERE);
  // The minutes' "Create a work item" cards (ids `m-...`) are offered after the assistant has left; every other card ends with it.
  if (record.state === 'left' && !actionId.startsWith('m-')) throw new AppError(409, ALREADY_LEFT);
  const action = await store.getAction(callId, actionId);
  if (!action) throw new NotFoundError('No such action');
  if (action.askedBy !== session.sub) throw new AppError(403, `Only the person who asked ${ASSISTANT_NAME} can decide this.`);
  const to = decision === 'confirm' ? 'confirmed' : 'declined';
  const moved = await moveAction(callId, actionId, { from: ['waiting'], to, by: session.sub });
  if (!moved) {
    // Already decided: the same decision again is a success, a different one is a conflict.
    if (action.status === to) { res.json({ actionId, status: action.status, decidedBy: action.decidedBy, decidedAt: action.decidedAt }); return; }
    throw new AppError(409, `This action is already ${action.status}`);
  }
  await assistantRuntime().onDecision(callId, actionId, decision);
  res.json({ actionId, status: moved.status, decidedBy: moved.decidedBy, decidedAt: moved.decidedAt });
}));

/**
 * Who may use the turn routes: a seat in the call, or, without one, the executor of one of the call's proposals by the proposals'
 * own rule (they may consent on the meeting page after the call, and their consent runs it in their browser there). Without a seat
 * only proposal turns are served; anyone else gets the seat's own refusal.
 */
async function turnCallerOf(req: Request): Promise<{ session: Session; callId: string; proposalsOnly: boolean }> {
  try { return { ...(await seatOf(req)), proposalsOnly: false }; } catch (e) {
    if (!(e instanceof AppError)) throw e;
    const v = await proposalViewer(req).catch(() => null);
    if (!v || !(await assistantStore().listProposals(v.callId)).some((p) => p.executor === v.session.sub && visibleTo(v, p))) throw e;
    return { session: v.session, callId: v.callId, proposalsOnly: true };
  }
}

/** Without a seat, a turn that is not a proposal's is the same 404 as an unknown one. */
async function assertTurnServed(callId: string, turnId: string, proposalsOnly: boolean): Promise<void> {
  if (proposalsOnly && !(await assistantStore().getTurn(callId, turnId))?.proposalId) throw new NotFoundError('No such turn');
}

/** The turns waiting for MY browser. Never anyone else's: the list is filtered by the caller's own id. */
meetingAssistantRouter.get('/turns', asyncHandler(async (req, res) => {
  const { session, callId, proposalsOnly } = await turnCallerOf(req);
  const turns = (await assistantRuntime().turnsFor(callId, session.sub)).filter((t) => !proposalsOnly || !!t.proposalId);
  res.json({ callId, turns: turns.map((t) => ({ turnId: t.turnId, kind: t.kind, status: t.status, tool: t.tool, actionId: t.actionId ?? null, createdAt: t.createdAt, expiresAt: t.expiresAt })) });
}));

const turnIdOf = (req: Request): string => {
  const id = req.params['turnId'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) throw new NotFoundError('No such turn');
  return id;
};

/**
 * A browser claims a turn before running it (audit B6). Only the asker; anyone else, and an unknown turn, get the same 404.
 * Answers { turnId, claimId, tool: { name, args }, kind }; a second claim, an expired or not-yet-runnable turn answers 409.
 */
meetingAssistantRouter.post('/turns/:turnId/claim', asyncHandler(async (req, res) => {
  const { session, callId, proposalsOnly } = await turnCallerOf(req);
  const turnId = turnIdOf(req);
  await assertTurnServed(callId, turnId, proposalsOnly);
  const out = await assistantRuntime().claimTurn(callId, turnId, session.sub);
  if (!out) throw new NotFoundError('No such turn');
  if ('conflict' in out) throw new AppError(409, `This turn cannot be claimed: ${out.conflict}`);
  // `expiresAt` is the turn's expiry after the claim (a claimed write is given time to finish), so a late write keeps its result.
  res.json({ turnId, claimId: out.turn.claimId, tool: out.turn.tool, kind: out.turn.kind, expiresAt: out.turn.expiresAt });
}));

/** The browser's result of a turn, with the claim id its claim returned (400 without it, 409 when it is not the claim). A caller who is not the asker, or an unknown turn, gets the 404. */
meetingAssistantRouter.post('/turns/:turnId/result', asyncHandler(async (req, res) => {
  const { session, callId, proposalsOnly } = await turnCallerOf(req);
  const turnId = turnIdOf(req);
  await assertTurnServed(callId, turnId, proposalsOnly);
  const body = (req.body ?? {}) as { ok?: unknown; claimId?: unknown; output?: unknown; error?: unknown };
  if (typeof body.ok !== 'boolean') throw new ValidationError('ok must be true or false');
  if (typeof body.claimId !== 'string' || !/^[0-9a-f]{8,64}$/.test(body.claimId)) throw new ValidationError('claimId is required: claim the turn first');
  if (body.error !== undefined && typeof body.error !== 'string') throw new ValidationError('error must be a string');
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(body.output ?? null)); } catch { throw new ValidationError('output must be JSON'); }
  if (size > MAX_RESULT_BYTES) throw new AppError(413, `output may be at most ${MAX_RESULT_BYTES} bytes`);
  const out = await assistantRuntime().submitResult(callId, turnId, session.sub, { ok: body.ok, claimId: body.claimId, output: body.output, ...(typeof body.error === 'string' ? { error: body.error } : {}) });
  if (!out) throw new NotFoundError('No such turn');
  if ('conflict' in out) throw new AppError(409, `This turn is ${out.conflict}`);
  res.json({ turnId, status: out.turn.status });
}));

// ---- proposals (docs/meeting-consent-design.md) ---------------------------------------------------------------------------------

/**
 * Who may see and answer a call's proposals: the call has an assistant record in the caller's tenant, and the caller holds a seat now,
 * or held one while the assistant was in the call, or is named by a proposal or is its executor (they must consent even if they were
 * never there; they see only those proposals). Everyone else gets the same 404 as "no such call".
 */
interface ProposalViewer { session: Session; callId: string; record: AssistantRecord; seated: boolean; attendee: boolean; access: ReadAccess }
async function proposalViewer(req: Request): Promise<ProposalViewer> {
  const session = sessionOf(req); const callId = callIdOf(req);
  let record = await assistantStore().get(callId);
  if (!record || record.tenant !== session.tenant) throw new NotFoundError('Not found');
  let seated = false;
  try { await callChatRuntime().assertMember(callId, session, false); seated = true; } catch (e) { if (!(e instanceof AppError)) throw e; }
  if (seated && !record.attendees.includes(session.sub)) { await attendOnce(callId, session.sub).catch(() => undefined); record = (await assistantStore().get(callId)) ?? record; }
  if ((await assistantStore().getMinutes(callId))?.deleted) throw new NotFoundError('Not found');
  return { session, callId, record, seated, attendee: record.attendees.includes(session.sub), access: await readsOf(session.sub, session.tenant, seated, record, session.role) };
}

const involves = (p: Proposal, userId: string): boolean => p.executor === userId || p.named.includes(userId);
const visibleTo = (v: ProposalViewer, p: Proposal): boolean => v.access.record || involves(p, v.session.sub);
/** The end of the call for expiry: when the assistant left (the call ending makes it leave). Null while it is in the call. */
const endedAt = (record: AssistantRecord): number | null => (record.state === 'left' ? (record.leftAt ?? record.invitedAt) : null);

const recOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const projectName = async (id: string | null): Promise<string | null> => (id ? getProject(id).then((x) => x?.name?.trim() || null).catch(() => null) : null);

/**
 * What will be written, in plain words: "Record as a decision on Auth Migration", or the write's own sentence with its owner and
 * initiative ('Create a work item titled "Runbook", owned by Lee, on Auth Migration'). Never a tool name or a typed record reference.
 */
async function outcomeSummary(p: Proposal, record: AssistantRecord, names: Record<string, string>): Promise<string> {
  if (p.outcome.kind === 'decision') {
    const name = await projectName(p.outcome.initiativeId ?? record.initiativeId);
    return name ? `Record as a decision on ${name}` : 'Record as a decision';
  }
  const args = recOf(p.outcome.args); const fields = recOf(args['fields']);
  let line = p.outcome.name === 'update' ? updateStatement(args) : describeCall(p.outcome.name, args).summary;
  const assignee = typeof fields['assignee'] === 'string' ? fields['assignee'].trim() : '';
  if (assignee) {
    const self = /^(me|myself|i)$/i.test(assignee) && p.askedBy ? p.askedBy : null;
    const who = self ? names[self] ?? await nameOf(self) : names[assignee] ?? (p.named.includes(assignee) ? await nameOf(assignee) : assignee.slice(0, 80));
    line += `, owned by ${who}`;
  }
  const initiative = typeof fields['initiative'] === 'string' ? fields['initiative'].trim() : '';
  const typed = /^initiative:(.+)$/.exec(initiative);
  const on = typed ? await projectName(typed[1]!) : initiative.slice(0, 120) || null;
  return on ? `${line}, on ${on}` : line;
}

/** The last few lines Milo heard for it, quoted (at most four), for people who held a seat only. */
const HEARD_MAX = 4;
async function heardLines(p: Proposal): Promise<Array<{ speaker: string; text: string }>> {
  const want = p.evidence.slice(-HEARD_MAX);
  if (!want.length) return [];
  const from = want[0]!; const to = want[want.length - 1]!;
  if (to - from > 400) return [];
  const lines = await assistantStore().lines(p.callId, from - 1, to - from + 1).catch(() => []);
  // The speaker by their directory name (as the transcript shows them), never a raw id.
  return Promise.all(lines.filter((l) => want.includes(l.seq)).map(async (l) => ({
    speaker: l.userId ? await nameOf(l.userId).catch(() => l.speakerName) : l.speakerName || 'Someone', text: l.text.length > 240 ? `${l.text.slice(0, 239)}…` : l.text,
  })));
}

/** A run Milo handed back (consented again with a note: the executor may not run it, or was not there). */
const handedBack = (p: Proposal): boolean => p.state === 'consented' && !!p.run && p.run.turnId === null && !!p.run.note && !p.run.raisedAs;

/**
 * Whether `viewer` may run it now ("Run it now", a consent as executor): it is consented, they may run its write, and either they
 * are its executor, or Milo handed it back and they consented, or Milo handed it back, nobody who consented can run it and they have
 * not answered. Anyone else's click before the executor's would break "the executor's click is the last step".
 */
async function canRunNow(p: Proposal, record: AssistantRecord, viewer: string): Promise<boolean> {
  if (p.state !== 'consented') return false;
  const mine = p.responses.find((r) => r.userId === viewer);
  if (mine && mine.response !== 'consent') return false;
  if (!(p.executor === viewer || handedBack(p))) return false;
  const deps = assistantRuntime().proposalDeps;
  const may = await mayRunProposal(deps, p, record, viewer).catch(() => 'no' as const);
  // A write that cannot run at all is still the executor's to start: their click ends it as failed, with the reason.
  if (may === 'never') return p.executor === viewer;
  if (may === 'no') return false;
  if (mine) return true;
  for (const r of p.responses) if (r.response === 'consent' && (await mayRunProposal(deps, p, record, r.userId).catch(() => 'no' as const)) === 'yes') return false;
  return true;
}

async function proposalView(p: Proposal, viewer: string, v: Pick<ProposalViewer, 'record' | 'seated' | 'attendee' | 'access'>) {
  const people = [...new Set([p.executor, ...p.named, ...p.responses.map((r) => r.userId), ...(p.dismissedBy ? [p.dismissedBy] : []), ...(p.run ? [p.run.by] : []), ...(p.askedBy ? [p.askedBy] : [])])];
  const faces = await facesOf(people); const names: Record<string, string> = Object.fromEntries(faces.map((f) => [f.userId, f.name])); // portraits read as the attendees' are
  const mine = p.responses.find((r) => r.userId === viewer);
  const wasThere = v.access.record; // the viewer's, by the call's policy: by default, seated now or an attendee
  const answerable = ANSWERABLE.includes(p.state);
  const recordsAs = p.state === 'done' ? p.run?.recordedAs ?? null : answerable ? await decisionRecordedAs(assistantRuntime().proposalDeps, p, v.record.initiativeId) : null;
  return {
    id: p.id, callId: p.callId, statement: p.statement, outcome: { ...p.outcome, summary: await outcomeSummary(p, v.record, names) }, argsDigest: p.argsDigest, source: p.source,
    // Who raised it: the person who asked Milo, or Milo from what it heard. The lines it heard go only to people who were there.
    askedBy: p.askedBy ? { userId: p.askedBy, name: names[p.askedBy] } : null,
    evidence: wasThere ? p.evidence : [], heard: wasThere && p.source !== 'asked' ? await heardLines(p) : [],
    // A decision recorded as decided by its executor, or as waiting for the initiative owner's decision.
    recordsAs, state: p.state, executor: { userId: p.executor, name: names[p.executor], avatarUrl: avatarIn(faces, p.executor) },
    named: p.named.map((u) => ({ userId: u, name: names[u], avatarUrl: avatarIn(faces, u) })), // a portrait for everyone it names, in the call or not
    // A reason is shared with everyone who can see the proposal, and labelled so.
    responses: p.responses.map((r) => ({ userId: r.userId, name: names[r.userId], avatarUrl: avatarIn(faces, r.userId), response: r.response, reason: r.reason, reasonShared: r.reason !== null, at: r.at })),
    missing: whatIsMissing(p), dismissedBy: p.dismissedBy, dismissedByName: p.dismissedBy ? names[p.dismissedBy] : null, createdAt: p.createdAt, updatedAt: p.updatedAt, expiresAt: p.expiresAt,
    // The latest run (proposal-run.ts): running with its executor; done with what was made (`title`, and `href` for a decision record);
    // failed, or handed back to consented, with one sentence (`note`) the card shows.
    run: p.run ? { by: { userId: p.run.by, name: names[p.run.by] }, at: p.run.at, title: p.run.title, href: p.run.href, note: p.run.note, raisedAs: p.run.raisedAs ?? null } : null,
    you: {
      userId: viewer, response: mine?.response ?? null, isExecutor: p.executor === viewer, isNamed: p.named.includes(viewer),
      isAsker: !!p.askedBy && p.askedBy === viewer,
      canRun: await canRunNow(p, v.record, viewer),
      // "Not a decision" (Milo raised it) or "Drop it" (the asker's own), in the call only; its undo by the same person; raise it again.
      canDismiss: v.seated && answerable && mayDismiss(p, viewer),
      canReopen: mayReopen(p, viewer) && !isDue({ state: 'open', expiresAt: p.expiresAt }, Date.now()),
      canRaiseAgain: mayRaiseAgain(p),
    },
  };
}

meetingAssistantRouter.get('/proposals', asyncHandler(async (req, res) => {
  const v = await proposalViewer(req);
  const all = await listProposalsFor(assistantStore(), v.callId, Date.now(), endedAt(v.record));
  const shown = all.filter((p) => visibleTo(v, p));
  if (!v.access.record && !shown.length) throw new NotFoundError('Not found');
  res.json({ callId: v.callId, proposals: await Promise.all(shown.map((p) => proposalView(p, v.session.sub, v))) });
}));

const RESPONSES: readonly ResponseKind[] = ['consent', 'object', 'withdraw', 'not-a-decision', 'reopen'];
meetingAssistantRouter.post('/proposals/:proposalId/response', asyncHandler(async (req, res) => {
  const v = await proposalViewer(req);
  const id = req.params['proposalId'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) throw new NotFoundError('No such proposal');
  const body = (req.body ?? {}) as { response?: unknown; reason?: unknown; asExecutor?: unknown };
  if (body.asExecutor !== undefined && typeof body.asExecutor !== 'boolean') throw new ValidationError('asExecutor must be true or false');
  const asExecutor = body.asExecutor === true;
  if (!RESPONSES.includes(body.response as ResponseKind)) throw new ValidationError("response must be 'consent', 'object', 'withdraw', 'not-a-decision' or 'reopen'");
  const response = body.response as ResponseKind;
  let reason: string | null;
  try { reason = cleanReason(body.reason); } catch (e) { if (e instanceof ProposalInputError) throw new ValidationError(e.message); throw e; }
  if (reason !== null && response !== 'object') throw new ValidationError('a reason goes with an objection only');
  const store = assistantStore();
  const existing = await store.getProposal(v.callId, id);
  if (!existing || !visibleTo(v, existing)) throw new NotFoundError('No such proposal');
  if (response === 'not-a-decision' && !v.seated) throw new AppError(403, 'Only someone in the call can mark a proposal as not a decision');
  if (response === 'not-a-decision' && !mayDismiss(existing, v.session.sub)) throw new AppError(403, 'Only the person who asked for it can drop it');
  if (asExecutor && !(await canRunNow(existing, v.record, v.session.sub))) throw new AppError(409, 'Only the person running it, or someone who can when they cannot, may run it now');
  const joins = asExecutor && !existing.responses.some((r) => r.userId === v.session.sub);
  const out = await respondToProposal(store, v.callId, id, { userId: v.session.sub, response, reason, at: Date.now(), ...(asExecutor ? { asExecutor } : {}), ...(joins ? { mayJoin: true } : {}) }, endedAt(v.record));
  if (!out.ok) {
    if (out.why === 'not-found') throw new NotFoundError('No such proposal');
    if (out.why === 'reason-not-allowed') throw new ValidationError('a reason goes with an objection only');
    if (out.why === 'busy') throw new AppError(409, 'Too many answers at once; try again');
    if (out.why === 'not-a-consenter') throw new AppError(409, 'Only someone who consented can run it');
    if (out.why === 'not-allowed') throw new AppError(403, response === 'reopen' ? 'Only the person who dismissed it can reopen it' : 'Only the person who asked for it can drop it');
    throw new AppError(409, `This proposal is ${out.proposal?.state ?? 'finished'}`);
  }
  res.json(await proposalView(out.proposal, v.session.sub, v));
}));

meetingAssistantRouter.post('/proposals/:proposalId/raise-again', asyncHandler(async (req, res) => {
  const v = await proposalViewer(req);
  const id = req.params['proposalId'];
  if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,128}$/.test(id)) throw new NotFoundError('No such proposal');
  const store = assistantStore();
  const existing = await store.getProposal(v.callId, id);
  if (!existing || !visibleTo(v, existing)) throw new NotFoundError('No such proposal');
  const out = await raiseAgain(store, v.callId, id, v.session.sub, Date.now(), MAX_PER_CALL, periodStart(v.record));
  if (!out.ok) {
    if (out.why === 'not-found') throw new NotFoundError('No such proposal');
    if (out.why === 'cap') throw new AppError(409, 'This call already has as many proposals as it can hold');
    if (out.why === 'busy') throw new AppError(409, 'Too many answers at once; try again');
    throw new AppError(409, `This proposal is ${out.proposal?.state ?? 'finished'}`);
  }
  // A copy raised after the call ended keeps the call's deadline on the meeting page.
  if (endedAt(v.record) !== null) await closeProposals(store, v.callId, endedAt(v.record)!);
  // A watcher proposal raised again during the call can be the one that reaches the cap: the call is told once, as when Milo raises it.
  else await noticeIfCapReached(store, v.callId, out.proposal.source, postNoticeQuietly).catch(() => false);
  res.json(await proposalView((await store.getProposal(v.callId, out.proposal.id)) ?? out.proposal, v.session.sub, v));
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

/**
 * THE attendee rule, applied by every read of a call's words (transcript and minutes; the meeting list asks the store for
 * the same test): the assistant has a record for this call in the caller's tenant, and the caller held an ACTIVE seat at some
 * moment between the invite and the assistant leaving (recorded as it happens; nothing is inferred from a seat read afterwards). Same answer for "no assistant", "another tenant's call" and "you were not there": 404.
 * Admins get no exception.
 */
export async function attendeeOf(session: Session, callId: string, part: keyof ReadAccess = 'record'): Promise<AssistantRecord> {
  const record = await assistantStore().get(callId);
  if (!record || !(await readsOf(session.sub, session.tenant, false, record, session.role))[part]) throw new NotFoundError('Not found'); // the call's policy (by default this rule)
  return record;
}

/** A deleted record is gone for everyone, its transcript included. */
async function liveRecordOf(session: Session, callId: string, part: keyof ReadAccess): Promise<AssistantRecord> {
  const record = await attendeeOf(session, callId, part);
  if ((await assistantStore().getMinutes(callId))?.deleted) throw new NotFoundError('Not found');
  return record;
}

/**
 * The stored lines, oldest first, for the people who were there (`liveRecordOf`), during the call and after it. Two ways to page:
 * `after`/`limit` (forward from a seq, as the meeting page and the live view's polling read), or `tail` (the newest `tail` lines,
 * optionally those before the seq `before`, with `earlier` saying whether older lines exist: the live view's first read and its
 * "Load earlier lines"). Every answer names the speakers of the lines it carries, with their portraits, so a view needs no second read,
 * and `since` (when Milo was invited) so a line's time reads from the start of Milo's listening.
 */
meetingAssistantRouter.get('/transcript', asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  const tail = req.query['tail'] === undefined ? null : intParam(req.query['tail'], 'tail', 1, 500, 100);
  if (tail === null && req.query['before'] !== undefined) throw new ValidationError('before needs tail');
  if (tail !== null && (req.query['after'] !== undefined || req.query['limit'] !== undefined)) throw new ValidationError('tail cannot be combined with after or limit');
  const record = await liveRecordOf(session, callId, 'transcript');
  const store = assistantStore();
  let after: number; let lines: TranscriptLine[]; let earlier: boolean | undefined;
  if (tail !== null) {
    const before = intParam(req.query['before'], 'before', 1, 1_000_000_000, record.nextSeq);
    after = Math.max(0, Math.min(before, record.nextSeq) - 1 - tail);
    lines = (await store.lines(callId, after, tail)).filter((l) => l.seq < before);
    earlier = after > 0 && (await store.lines(callId, 0, 1)).some((l) => l.seq <= after);
  } else {
    after = intParam(req.query['after'], 'after', 0, 1_000_000_000, 0);
    lines = await store.lines(callId, after, intParam(req.query['limit'], 'limit', 1, 500, 100));
  }
  const speakers = await facesOf([...new Set(lines.flatMap((l) => (l.userId ? [l.userId] : [])))]);
  res.json({ callId, after, lines, next: lines.length ? lines[lines.length - 1]!.seq : after, speakers, since: record.invitedAt, ...(earlier === undefined ? {} : { earlier }) });
}));

/** Notes and transcript are personal data: reading them is attributed to the person who was there, so no masquerade. */
function refuseMasqueradeRead(req: Request, res: Response, next: NextFunction): void {
  if (resolveSession(req)?.act) { res.status(403).json({ error: 'stop masquerading to read meeting records; they belong to the people who were there', code: 'MASQUERADING' }); return; }
  next();
}

async function namesOf(ids: readonly string[]): Promise<Array<{ userId: string; name: string }>> {
  return Promise.all(ids.map(async (userId) => ({ userId, name: await nameOf(userId) })));
}

/**
 * The people of a meeting with their portraits, read the way the people directory reads them (`userAvatars`: the user's own picture,
 * else their linked person's). Best effort: a failed read leaves `avatarUrl` null and the portal draws initials.
 */
async function facesOf(ids: readonly string[]): Promise<Array<{ userId: string; name: string; avatarUrl: string | null }>> {
  const named = await namesOf(ids);
  const users = await Promise.all(ids.map(async (id) => ({ id, personId: (await getUser(id).catch(() => null))?.personId ?? null })));
  const avatars = await userAvatars(users).catch(() => new Map<string, string | null>());
  return named.map((p) => ({ ...p, avatarUrl: avatars.get(p.userId) ?? null }));
}

/**
 * The call's proposals as the minutes list them, read live (a consent on the meeting page after the call shows): the statement, its
 * state, and who consented or objected by NAME only. Reasons stay on the proposal itself, where the people it concerns read them.
 */
async function minutesProposals(all: readonly Proposal[]) {
  return Promise.all(all.map(async (p) => ({
    id: p.id, statement: p.statement, state: p.state, outcome: p.outcome.kind,
    consentedBy: (await namesOf(p.responses.filter((r) => r.response === 'consent').map((r) => r.userId))).map((x) => x.name),
    objectedBy: (await namesOf(p.responses.filter((r) => r.response === 'object').map((r) => r.userId))).map((x) => x.name),
  })));
}

const DAY_MS = 86_400_000;

/**
 * What Milo covered, from the call's record: the seconds it listened (not the meeting's length), the rest of its time in the call
 * (paused, or waiting to start), and how many people were in the call without agreeing to be transcribed. A count only: the people
 * who did not acknowledge are never named.
 */
export function coverageOf(record: AssistantRecord, attendees: readonly string[]) {
  const end = record.leftAt ?? Date.now();
  const s = recordSession(record);
  // Every period counts: the seconds listened include the earlier ones (`settledListeningSeconds`), and Milo's time in the call is the
  // sum of its periods, so the time between them (Milo was not there) is neither listening nor paused.
  const listenedSeconds = Math.floor(listeningSecondsOf(record, end));
  const inCallMs = (s.periods ?? []).reduce((n, p) => n + Math.max(0, p.leftAt - p.from), 0) + Math.max(0, end - (s.periodFrom ?? record.invitedAt));
  const pausedSeconds = Math.max(0, Math.floor(inCallMs / 1000) - listenedSeconds);
  // Transcribed: everyone who acknowledged in any period (an invitation back resets `acked`, never `ackedEver`) and every inviter.
  const acked = new Set([record.invitedBy, ...record.acked, ...(s.ackedEver ?? []), ...(s.periods ?? []).map((p) => p.invitedBy)]);
  return { listenedSeconds, pausedSeconds, untranscribed: attendees.filter((u) => !acked.has(u)).length };
}

/**
 * A meeting's minutes, for the people who were in the call. A record the inviter deleted, or the retention sweep emptied, answers those
 * people 410 with why (MEETING_DELETED, MEETING_EXPIRED): they were there, so it reveals nothing. Everyone else keeps the plain 404, and
 * once the sweep removed the call entirely nothing is left to tell anyone, so the 404 is all there is. While Milo is still writing the
 * first minutes, an attendee gets 404 MINUTES_WRITING.
 */
meetingAssistantRouter.get('/minutes', refuseMasqueradeRead, asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  const record = await attendeeOf(session, callId, 'minutes');
  const m = await assistantStore().getMinutes(callId);
  if (m?.deleted) {
    const expired = m.deleted.by === 'system';
    res.status(410).json({ code: expired ? 'MEETING_EXPIRED' : 'MEETING_DELETED', error: expired ? 'This meeting\'s record was removed after the retention period.' : 'This meeting\'s record was deleted.' });
    return;
  }
  if (!m) {
    if (minutesWriting(callId)) { res.status(404).json({ code: 'MINUTES_WRITING', error: `${ASSISTANT_NAME} is writing the minutes.` }); return; }
    throw new NotFoundError('No minutes');
  }
  const attendees = await facesOf(m.attendees);
  const attempts = m.attempts ?? (m.writer === 'none' ? 0 : 1);
  // An action item whose "Create a work item" card was carried out (or that was done in the call) has its work item.
  const doneTurns = new Set((await assistantStore().listTurns(callId, { statuses: ['done'] }).catch(() => [])).map((t) => t.turnId));
  // One made from the meeting page carries its id; the link is built here from that id and the meeting's own initiative.
  const actionItems = m.actionItems.map(({ workItemId, ...item }, i) => ({
    ...item, workItemCreated: item.done === true || !!workItemId || doneTurns.has(actionCardTurnId(callId, i)),
    workItemHref: workItemId && m.initiativeId ? workItemHref(m.initiativeId, workItemId) : null,
  }));
  const live = await listProposalsFor(assistantStore(), callId, Date.now(), endedAt(record)); // the proposals as they stand, read once
  const parts = summaryWithProposals(m, live); // the summary's lead and bullets; the bullets about proposals are built from `live`, never stored
  res.json({
    proposals: await minutesProposals(live),
    callId, callName: meetingNameOf(m, attendees.map((a) => a.name)), lobby: m.lobby, initiativeId: m.initiativeId, startedAt: m.startedAt, endedAt: m.endedAt,
    invitedBy: m.invitedBy, invitedByName: await nameOf(m.invitedBy), inviters: await namesOf(invitersOf(record)), attendees, summary: m.summary, decisions: m.decisions,
    summaryLead: parts.lead, summaryPoints: parts.points,
    actionItems, topics: m.topics, lineCount: m.lineCount, truncated: m.truncated, writer: m.writer, createdAt: m.createdAt,
    // Anyone who invited Milo into this call, in any period, may delete its record.
    youAreInviter: invitedAssistantHere(record, session.sub),
    // The retention sweep removes the call this long after it ended (retention.ts counts from the same end time).
    keptUntil: (record.leftAt ?? m.endedAt) + retentionDays() * DAY_MS,
    coverage: coverageOf(record, m.attendees),
    // No draft, or an addition that could not be written: whether an attendee may ask Milo to try again (a hard cap on runs, each of
    // which may cost model money; an owed addition's runs are counted apart from the first write's); `autoRetrying`: the sweep still will.
    rewrite: m.writer !== 'none' && m.additionOwed
      ? { writing: minutesWriting(callId), possible: true, attemptsLeft: Math.max(0, MAX_ATTEMPTS - (m.additionAttempts ?? 0)), autoRetrying: (m.additionAttempts ?? 0) < AUTO_ATTEMPTS }
      : { writing: minutesWriting(callId), possible: m.writer === 'none' && m.retryable === true, attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts), autoRetrying: m.writer === 'none' && m.retryable === true && attempts < AUTO_ATTEMPTS },
    // Milo was invited back and is in the call now: what it hears is added to these minutes when it leaves.
    backInCall: record.state !== 'left',
    // A later part of the call could not be added yet: these minutes stand as they are until it is.
    additionOwed: m.writer !== 'none' && m.additionOwed === true, additionDue: additionDueFor(record, m),
    additions: m.additions ?? 0,
  });
}));

/** The portal's page for a work item on its initiative's Work tab. */
export const workItemHref = (initiativeId: string, workItemId: string): string =>
  `/iq/projects/${encodeURIComponent(initiativeId)}?tab=work&item=${encodeURIComponent(workItemId)}`;

const creatingWorkItem = new Set<string>();

/**
 * "Create work item" on a meeting page's action item: the server makes the work item on the meeting's initiative and records it
 * against the item, so the page can say it was created and link to it. An attendee only, of live minutes; the item must be theirs or
 * nobody's and not done in the call; and the same gates as creating work anywhere (`DispatchAgentRun`, someone who owns or
 * contributes to the initiative). Once: an item that already has its work item answers with it and creates nothing.
 */
meetingAssistantRouter.post('/minutes/action-items/:index/work-item', refuseMasqueradeRead, requireAction('DispatchAgentRun'), asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  const raw = req.params['index'];
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) throw new NotFoundError('No such action item');
  const index = Number(raw);
  await liveRecordOf(session, callId, 'minutes');
  const store = assistantStore();
  const m = await store.getMinutes(callId);
  const item = m && !m.deleted ? m.actionItems[index] : undefined;
  if (!m || !item) throw new NotFoundError('No such action item');
  if (item.workItemId) { res.json({ index, created: false, workItemCreated: true, workItemHref: m.initiativeId ? workItemHref(m.initiativeId, item.workItemId) : null }); return; }
  if (!m.initiativeId) throw new AppError(409, 'This meeting has no initiative to add work to');
  if (item.done) throw new AppError(409, 'This was already done in the call');
  if (item.ownerUserId && item.ownerUserId !== session.sub) throw new AppError(403, 'Only the person this action item names can create its work item');
  if (!await requireInitiativeScope(req, res, m.initiativeId, { action: 'create work' })) return;
  const key = `${callId}#${index}`;
  if (creatingWorkItem.has(key)) throw new AppError(409, 'This work item is already being created');
  creatingWorkItem.add(key);
  try {
    const created = await createWorkItem({ projectId: m.initiativeId, type: 'story', title: item.text.trim().slice(0, 200), status: 'open', priority: 'medium' });
    void notifyWorkGraphChanged(created.projectId, 'work-item');
    const recorded = await store.setActionItemWorkItem(callId, index, created.id);
    const id = recorded ? created.id : ((await store.getMinutes(callId))?.actionItems[index]?.workItemId ?? created.id);
    res.status(recorded ? 201 : 200).json({ index, created: recorded, workItemCreated: true, workItemHref: workItemHref(m.initiativeId, id) });
  } finally { creatingWorkItem.delete(key); }
}));

/** An attendee asks Milo to write minutes that failed again. Refused while a write runs and once MAX_ATTEMPTS runs were made. */
meetingAssistantRouter.post('/minutes/rewrite', refuseMasqueradeRead, asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  await liveRecordOf(session, callId, 'minutes');
  const { outcome } = await rewriteMinutes(callId, MAX_ATTEMPTS);
  if (outcome === 'started') { res.status(202).json({ callId, writing: true }); return; }
  if (outcome === 'busy') { res.status(409).json({ code: 'MINUTES_WRITING', error: `${ASSISTANT_NAME} is already writing these minutes.` }); return; }
  if (outcome === 'limit') { res.status(429).json({ code: 'MINUTES_ATTEMPTS', error: `${ASSISTANT_NAME} has tried to write these minutes ${MAX_ATTEMPTS} times and will not try again. The transcript is still here to read.` }); return; }
  res.status(409).json({ code: 'MINUTES_WRITTEN', error: 'These minutes do not need writing again.' });
}));

/** The delete found Milo back in the call: someone invited it back between the delete's check and its erase. */
export const DELETE_WHILE_BACK = `${ASSISTANT_NAME} is back in this call. The meeting can be deleted after it leaves.`;

/** The person invited Milo into this call, in this period or an earlier one: they may delete its record (after Milo has left). */
export const invitedAssistantHere = (record: AssistantRecord, userId: string): boolean =>
  record.invitedBy === userId || (recordSession(record).periods ?? []).some((p) => p.invitedBy === userId);

/**
 * The inviter's delete: minutes and transcript go, a tombstone stays. The inviter may repeat it: every step is safe to run again, so a
 * failed chat step is finished by the next attempt. Anyone else gets a 404 once the record is deleted.
 */
const deleteRecord = asyncHandler(async (req, res) => {
  const session = sessionOf(req); const callId = callIdOf(req);
  const record = await attendeeOf(session, callId);
  const deleted = !!(await assistantStore().getMinutes(callId))?.deleted;
  const inviter = invitedAssistantHere(record, session.sub);
  if (deleted && !inviter) throw new NotFoundError('Not found');
  if (!inviter) throw new AppError(403, `Only the person who invited ${ASSISTANT_NAME} can delete this meeting.`);
  if (record.state !== 'left') throw new AppError(409, (await seatedHere(callId, session.sub)) ? `${ASSISTANT_NAME} is back in this call. Dismiss ${ASSISTANT_NAME} before deleting this meeting.` : DELETE_WHILE_BACK);
  // The erase itself is conditional on Milo being out of the call: one invited back since the check above keeps everything.
  const lines = await eraseCall(assistantStore(), callId, session.sub, Date.now());
  if (lines === null) throw new AppError(409, DELETE_WHILE_BACK);
  res.json({ callId, deleted: true, linesRemoved: lines });
});
meetingAssistantRouter.delete('/minutes', refuseMasqueradeRead, deleteRecord);
meetingAssistantRouter.delete('/transcript', refuseMasqueradeRead, deleteRecord);

/** The call ended with Milo in it: Milo leaves with the call (settled, minutes written), and its open proposals move to the meeting page. */
async function endWithCall(callId: string): Promise<void> {
  const store = assistantStore();
  await onCallEnded(callId, { stop: (id) => assistantRuntime().stop(id), stopIntake: (id) => assistantIntake().stop(id) });
  const ended = await store.get(callId);
  if (ended?.state === 'left') {
    await closeProposals(store, callId, ended.leftAt ?? Date.now()).catch(() => 0);
    await notifyOpenProposals(store, callId);
  }
}
export const CALL_ENDED = 'This call has ended.';

// The call ended with the assistant still in it: it leaves with the call and the minutes are written. One subscription per process.
let watchingCallEnd = false;
function watchCallEnd(): void {
  if (watchingCallEnd) return;
  watchingCallEnd = true;
  onCallChatFinished((callId, seated) => trackMinutes((async () => {
    const store = assistantStore();
    if (!(await store.get(callId))) return;
    // With the feature off a call that ends still settles its spend and leaves; no run or minutes are started for it.
    if (!meetingAssistantEnabled()) { await endAbandonedCall(callId, Date.now()); return; }
    for (const userId of seated) await attendOnce(callId, userId);
    await endWithCall(callId);
  })()));
}
watchCallEnd();

/** `GET /api/meetings`: the meetings the caller attended with the assistant present, newest first. Never anyone else's. */
export const meetingsRouter = Router();
meetingsRouter.use(flagGate, staffTenantGate, refuseMasqueradeRead); // each tenant lists its own family's meetings (lobbyAgrees)
meetingsRouter.get('/', asyncHandler(async (req, res) => {
  const session = sessionOf(req);
  const limit = intParam(req.query['limit'], 'limit', 1, 100, 25);
  const rawBefore = req.query['before'];
  if (rawBefore !== undefined && (typeof rawBefore !== 'string' || !/^\d{1,14}$/.test(rawBefore) || Number(rawBefore) < 1)) throw new ValidationError('before must be an epoch in milliseconds');
  const before = rawBefore === undefined ? undefined : Number(rawBefore);
  const initiative = req.query['initiative'];
  if (initiative !== undefined && (typeof initiative !== 'string' || !/^[A-Za-z0-9:_-]{1,200}$/.test(initiative))) throw new ValidationError('Invalid initiative');
  const rows = await assistantStore().listMinutes({ tenant: session.tenant, userId: session.sub, limit, ...(initiative ? { initiativeId: initiative } : {}), ...(before ? { before } : {}) });
  const store = assistantStore(); const now = Date.now();
  const meetings = await Promise.all(rows.filter((m) => lobbyAgrees(session.tenant, m.lobby) && policyForLobby(m.lobby).listsMeeting(m, session.sub)).map(async (m) => {
    const faces = await facesOf(m.attendees);
    const attendees = faces.map((a) => a.name);
    // Proposals from this meeting that wait on the caller's answer, read for the caller alone.
    const proposals = await listProposalsFor(store, m.callId, now, m.endedAt).catch(() => []);
    const waitingOnYou = proposals.filter((p) => ANSWERABLE.includes(p.state) && owedBy(p).includes(session.sub)).length;
    // Milo's listening time (not the meeting's length), and what came out of it: decisions (agreed proposals included, as the minutes
    // card counts them), action items and the proposals still open.
    const record = await store.get(m.callId).catch(() => null);
    const listenedSeconds = record ? Math.floor(listeningSecondsOf(record, record.leftAt ?? now)) : null;
    const counts = minutesCounts(m, proposals);
    return {
      callId: m.callId, callName: meetingNameOf(m, attendees), lobby: m.lobby, initiativeId: m.initiativeId, startedAt: m.startedAt, endedAt: m.endedAt,
      attendees, people: faces.map((f) => ({ name: f.name, avatarUrl: f.avatarUrl })), summary: m.summary, summaryLead: summaryParts(m.summary).lead, decisionCount: m.decisions.length, actionItemCount: m.actionItems.length, waitingOnYou,
      listenedSeconds, outcomes: { decisions: counts.decisions, actionItems: counts.actionItems, open: proposals.filter((p) => ANSWERABLE.includes(p.state)).length },
    };
  }));
  res.json({ meetings, next: rows.length === limit ? rows[rows.length - 1]!.endedAt : null });
}));

// ---- helpers declared last, so the routes above keep their line numbers (the voice inventory and the wire snapshots name them) ----

/** A person's portrait among faces read by `facesOf`; null when none. */
function avatarIn(faces: ReadonlyArray<{ userId: string; avatarUrl: string | null }>, userId: string): string | null {
  return faces.find((f) => f.userId === userId)?.avatarUrl ?? null;
}

/** Everyone who invited Milo into this call, in the order of their periods, once each (the meeting page's header names them all). */
function invitersOf(record: AssistantRecord): string[] {
  return [...new Set([...(recordSession(record).periods ?? []).map((p) => p.invitedBy), record.invitedBy].filter(Boolean))];
}

/**
 * Milo has left again and these minutes do not cover that leave yet: its addition (or the rewrite of failed minutes) is due. Read from
 * the record, not from this process, so a page keeps reading while another process writes it.
 */
function additionDueFor(record: AssistantRecord, m: MinutesRecord): boolean {
  return record.state === 'left' && (record.leftAt ?? 0) > m.endedAt && (m.writer !== 'none' || m.retryable === true);
}

/** Is this person seated in the running call (so they could dismiss Milo themselves)? */
async function seatedHere(callId: string, userId: string): Promise<boolean> {
  return (await callChatRuntime().seatedUsers(callId).catch(() => [])).some((u) => u.active && u.userId === userId);
}

// ---- the call's policy (lib/meeting-assistant/policy.ts), declared last as well ----

/** Refused on POST ack to a person whose acknowledgement the call's policy takes from somewhere else (decision 5 of the interviews plan). */
export const ACKED_ELSEWHERE = 'Your consent for this call was asked before you joined, so there is nothing to acknowledge here.';

/** The policy of a call whose record may not exist yet (an invite): the record's lobby, else the call's own; neither: the default. */
async function policyHere(callId: string, tenant: string): Promise<{ policy: ReturnType<typeof policyForLobby>; call: PolicyCall }> {
  const record = await assistantStore().get(callId).catch(() => null);
  if (record) return { policy: policyForLobby(record.lobby), call: policyCallOf(record) };
  const lobby = hasFamilyPolicies() ? await callChatRuntime().lobbyOf(callId).catch(() => null) : null;
  return { policy: policyForLobby(lobby), call: { callId, lobby, tenant } };
}

/** A seat, and the call's policy letting this person invite Milo, turn its voice on and add time (after Cedar's InviteMeetingAssistant). */
async function inviterSeatOf(req: Request): Promise<{ session: Session; callId: string }> {
  const seat = await seatOf(req);
  const { policy, call } = await policyHere(seat.callId, seat.session.tenant);
  const why = await policy.inviteRefusal({ userId: seat.session.sub, tenant: seat.session.tenant, role: seat.session.role }, call);
  if (why !== null) throw new AppError(403, why);
  return seat;
}

/** What this person may read of the call's record, by its policy. `seated`: they hold a seat in the running call now. */
async function readsOf(userId: string, tenant: string, seated: boolean, record: AssistantRecord, role?: string): Promise<ReadAccess> {
  return policyForLobby(record.lobby).reads({ userId, tenant, seated, ...(role !== undefined ? { role } : {}) }, record);
}

/** Does this person acknowledge Milo with the notice in the call (the default for everyone), not somewhere else? */
function ackedInCall(record: AssistantRecord, userId: string): boolean {
  return policyForLobby(record.lobby).acknowledgement(policyCallOf(record), userId) === 'in-call-notice';
}

/** Of the people present at an invite, those whose acknowledgement comes from elsewhere and who gave it (never the inviter, who acknowledges by inviting). */
async function ackedElsewhereAt(call: PolicyCall, present: readonly string[], inviter: string): Promise<string[]> {
  if (!hasFamilyPolicies()) return [];
  const policy = policyForLobby(call.lobby);
  const elsewhere = [...new Set(present)].filter((u) => u !== inviter && policy.acknowledgement(call, u) === 'elsewhere');
  if (!elsewhere.length || !policy.acknowledgedElsewhere) return [];
  return (await policy.acknowledgedElsewhere(call, elsewhere)).filter((u) => elsewhere.includes(u));
}

/** A person taking a seat whose acknowledgement comes from elsewhere and who gave it there is acknowledged now (their audio is admitted). */
async function ackElsewhere(callId: string, userId: string): Promise<void> {
  if (!hasFamilyPolicies()) return;
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record || record.state === 'left' || record.acked.includes(userId) || ackedInCall(record, userId)) return;
  const given = await policyForLobby(record.lobby).acknowledgedElsewhere?.(policyCallOf(record), [userId]) ?? [];
  if (!given.includes(userId)) return;
  await store.ack(callId, userId);
  await assistantAudio().refresh(callId).catch(() => undefined);
}

// ---- the tenant gate (interviews plan row I3.2), declared last as well ----

const INTERVIEWS = 'interviews';
const workTenant = requireTenant('orgiq');

/**
 * Who may reach these routes at all: a Work session (`requireTenant('orgiq')`, the admin's break-glass included), or, while the
 * interviews tenant is on, an interviews session, which `callTenantAgrees` then holds to an interview's call. A guest holds no session
 * and is refused here (401), as everyone else is (403).
 */
function staffTenantGate(req: Request, res: Response, next: NextFunction): void {
  if (resolveSession(req)?.tenant === INTERVIEWS && interviewsEnabled()) { next(); return; }
  workTenant(req, res, next);
}

/**
 * Does a session in `tenant` reach a call in this lobby? An interviews session reaches an interview's call only, and only while its
 * policy is registered (an interview under the default policy would read as a Work call); every other session reaches anything but
 * an interview's call. An unknown lobby is no interview: Work's routes decide it as before, an interviews session gets nothing.
 */
export function lobbyAgrees(tenant: string, lobby: string | null | undefined): boolean {
  const interview = familyOfLobby(lobby) === INTERVIEW_FAMILY;
  if (tenant === INTERVIEWS) return interview && policyFamilies().includes(INTERVIEW_FAMILY);
  return !interview;
}

/**
 * Where the call is resolved: the call's lobby (Milo's record's, else the live call's) must agree with the session's tenant, so a Work
 * session never reaches an interview's record and an interviews session never reaches Work's. The same 404 as no call at all. With no
 * family policy registered nothing is read for a Work session (no interview call can be served then).
 */
function callTenantAgrees(req: Request, _res: Response, next: NextFunction): void {
  const session = resolveSession(req); const callId = req.params['callId'];
  if (!session || typeof callId !== 'string' || (session.tenant !== INTERVIEWS && !hasFamilyPolicies())) { next(); return; }
  void (async () => {
    const record = await assistantStore().get(callId).catch(() => null);
    const lobby = record?.lobby ?? await callChatRuntime().lobbyOf(callId).catch(() => null);
    return lobbyAgrees(session.tenant, lobby);
  })().then((ok) => next(ok ? undefined : new NotFoundError('Not found')), next);
}

// Milo's policy for an interview call (lib/interviews/milo-policy.ts), registered once while the tenant is on.
registerInterviewsMiloPolicy();
