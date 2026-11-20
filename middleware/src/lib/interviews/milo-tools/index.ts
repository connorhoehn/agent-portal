// Milo's interview tools (docs/interviews-tenant-plan.md, "Milo's interview tools"): one file per tool, registered as one server-tool
// family (family.ts; the mechanism is meeting-assistant/server-tools.ts). Every trigger ends in the one runner, `runServerTool`:
//   (a) the detector's exact phrase, for the tools that take no arguments (a tool's `phrase`: "how much time is left", "repeat the
//       question", "Milo, introduce yourself"), answered at once with no model (milo-policy.ts `answerFromHeldText`, via `phrase`);
//   (b) the live session's function call, for everything else (the orchestrator's checks of a call, then the policy's `runTool`,
//       via `model`);
//   (c) the lead's "Introduce Milo" button (routes/interviews/milo.ts, via `button`).
// Each tool's `mayAsk` decides who may ask (the lead always; anyone for `time_left` and `repeat_question`; the candidate for the pad
// tools only while the lead's switch is on, milo-settings.ts; a panel member not for the pad); the runner runs it and the family
// logs the line Milo will say in the said log, unposted; the orchestrator then posts it with the approved mark and says it as
// approved words, and `heldTextSaid` marks the row. Every refusal is one fixed sentence. Nothing a model writes is ever said: the
// lines are the server's own, and what a model wrote reaches the pad only through the checks of tests.ts, imports.ts and helper.ts.
//
// The pad tools write through Milo's own pad seat (pad/milo-writer.ts, admitted by admitPadChannel), in the pad's language at the
// moment of writing, one write per interview at a time, credited to Milo in the pad log (side `milo`). They cost nothing beyond
// the live session, except a candidate's helper, whose solution check is held and settled under the interview's cap (verdict.ts).
//
// This module keeps the interview-shaped entry points (by interview id) the tests and older callers use.
import { phraseTool, policyAnswer, resetServerTools, runServerTool, serverToolBusy, serverToolPolicy, type ServerToolRun } from '../../meeting-assistant/server-tools.js';
import type { PolicyCall, ServerToolRetry } from '../../meeting-assistant/policy.js';
import { INTERVIEW_FAMILY, lobbyOfInterview } from './call.js';
import { INTERVIEWS_TENANT, type PadLanguage } from '../types.js';
import type { ResponsesFunctionTool } from '../../voice/catalogue.js';
import { whatICanDoIn } from './family.js';
import { liveInterview, logLine, standingOf } from './deps.js';
import { pendingPadWrite } from './pad-request.js';
import { resetVerdicts } from './pad-write.js';

export * from './deps.js';
export { whatICanDo, INTERVIEW_TOOLS, INTERVIEW_TOOL_FAMILY } from './family.js';
export { notePadChange, resetPadNotes } from './pad-notes.js';
export type { PadLanguage };

/** The call of an interview, as the tools see it (the lobby names the interview). */
export const interviewCall = (interviewId: string): PolicyCall => ({ callId: lobbyOfInterview(interviewId), lobby: lobbyOfInterview(interviewId), tenant: INTERVIEWS_TENANT });

const policy = serverToolPolicy(INTERVIEW_FAMILY);

/**
 * Run tool `name` for `askedBy` in the interview, as the live model's call does: who may ask, the tool, the line logged (unposted).
 * The line to post and say, or null for nothing (not a live interview, not one of its people, a repeat of the same request,
 * already introduced).
 */
export async function runMiloTool(interviewId: string, askedBy: string, name: string, args: unknown): Promise<string | ServerToolRetry | null> {
  return policyAnswer(await runServerTool(interviewCall(interviewId), askedBy, name, args, 'model'));
}

/** The argument-less tool an utterance asks for, word for word (anything looser goes to the live model); null when none. */
export async function toolOfPhrase(text: string): Promise<string | null> {
  return (await phraseTool(INTERVIEW_FAMILY, text))?.name ?? null;
}

/**
 * The tools a live interview's session is offered and what its background agent is told (policy `sessionTools`): every tool for
 * a coding round, the spoken ones only otherwise. Nothing for an interview that is not live.
 */
export async function sessionToolsFor(interviewId: string): Promise<{ tools: ResponsesFunctionTool[]; backendInstructions: string }> {
  const out = await policy.sessionTools(interviewCall(interviewId));
  return { tools: [...out.tools], backendInstructions: out.backendInstructions };
}

/** May this person have Milo run `name` here at all (policy `mayUseTool`)? One of the interview's people, in a live interview. */
export async function mayAsk(interviewId: string, userId: string, name: string): Promise<boolean> {
  return policy.mayUseTool(interviewCall(interviewId), { userId, roles: [] }, name);
}

/**
 * The line for a request nothing answered (policy `heldFallback`): what THIS asker may ask, logged; the candidate without pad
 * help gets `candidateLine` (their own fixed sentence, speak/index.ts MILO_CAN_DO); a panel member, nothing.
 */
export async function fallbackLine(interviewId: string, askedBy: string, candidateLine: string): Promise<string | null> {
  const interview = await liveInterview(interviewId);
  if (!interview) return null;
  const line = await whatICanDoIn(interview, askedBy, candidateLine);
  return line === null ? null : logLine(interview, askedBy, { line, source: 'refusal' });
}

/** "On it." for a slow pad request (test cases, a helper) from someone allowed to make it (policy `heldAcknowledgement`), logged. */
export async function acknowledgementLine(interviewId: string, askedBy: string, text: string): Promise<string | null> {
  return (await policy.heldAcknowledgement!(interviewCall(interviewId), { askedBy, text })) ?? null;
}

/** Is Milo writing in this interview's pad now? */
export const padBusy = (interviewId: string): boolean => serverToolBusy(interviewCall(interviewId));

/** Tests: forget the repeat window, the in-flight writes and the solution checks counted. */
export function resetMiloTools(): void { resetServerTools(); resetVerdicts(); }

/**
 * The candidate's pad request waiting for the lead's yes, for the lead's Confirm / Decline control (the room's footer): what was
 * asked and when. Null for anyone but the lead, and when nothing waits.
 */
export async function padConfirmWaiting(interviewId: string, userId: string): Promise<{ text: string; askedAt: string } | null> {
  const interview = await liveInterview(interviewId);
  if (!interview || (await standingOf(interview, userId)) !== 'lead') return null;
  const p = pendingPadWrite(interviewId);
  return p ? { text: p.text, askedAt: new Date(p.atMs).toISOString() } : null;
}

/** The lead pressed Confirm or Decline: the same tool "Milo, go ahead" or "Milo, no" runs, posted and said at once. */
export function pressPadConfirm(interviewId: string, userId: string, allow: boolean): Promise<ServerToolRun | null> {
  return runServerTool(interviewCall(interviewId), userId, allow ? 'confirm_pad_write' : 'decline_pad_write', {}, 'button');
}

