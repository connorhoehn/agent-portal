// The voice dock's phase machine (docs/voice-navigator-spec.md §1 "P3
// phases", §5 "Phase rules"). Pure: a reducer over what the client reports
// plus `phaseAt(state, now)`, because two of the phases are inferred from
// time, not announced:
//
//   thinking   The Live API sends no thinking event. It runs from the user's
//              last input transcript delta until the first output transcript
//              delta or session.delegation.created. The last delta cannot be
//              known when it arrives (mid-sentence gaps reach 700 ms in the
//              V1 log), so the microphone decides: thinking needs the mic
//              quiet for MIC_QUIET_MS. It gives up after THINKING_MAX_MS (a
//              cough the model ignores must not spin the ring forever).
//   speaking   Output audio streams silence continuously (V1), so frames
//              arriving mean nothing: speaking needs an output transcript
//              delta within SPEAKING_HOLD_MS, or output level above
//              SPEAKING_LEVEL.
//
// Priority while live: confirming > executing > speaking > thinking >
// listening. Executing covers an open delegation (session.delegation.created
// until its continuation completes with no call left open) and any running
// tool, so a slow tool shows progress although the voice falls silent (§1).

export type VoicePhase = 'off' | 'connecting' | 'listening' | 'thinking' | 'executing' | 'speaking' | 'confirming' | 'ended' | 'unavailable';

export const SPEAKING_HOLD_MS = 1500;
export const SPEAKING_LEVEL = 0.08;
export const MIC_ACTIVE_LEVEL = 0.06;
export const MIC_QUIET_MS = 300;
export const THINKING_MAX_MS = 8000;

type Base = 'off' | 'connecting' | 'live' | 'closing' | 'ended' | 'unavailable';

export interface MachineState {
  base: Base;
  /** Why `unavailable`, or why the last session ended early. */
  reason: string | null;
  lastInputAt: number | null;
  lastOutputAt: number | null;
  lastMicActiveAt: number | null;
  /** The user spoke and nothing has answered yet. */
  awaitingReply: boolean;
  outputLevel: number;
  openDelegations: readonly string[];
  runningCalls: readonly string[];
  /** The call whose confirm card is up, else null. */
  confirming: string | null;
}

export type MachineEvent =
  | { type: 'start' }
  | { type: 'unavailable'; reason: string }
  /** The mint answered 409 on the user's budget: a card, before any session exists. */
  | { type: 'budget-confirm' }
  | { type: 'failed'; reason: string }
  | { type: 'started' }
  | { type: 'input'; at: number }
  | { type: 'output'; at: number }
  | { type: 'levels'; at: number; input: number; output: number }
  | { type: 'delegation'; id: string }
  | { type: 'delegation-done'; id: string }
  | { type: 'confirm-shown'; callId: string }
  | { type: 'confirm-resolved'; callId: string }
  | { type: 'call-running'; callId: string }
  | { type: 'call-done'; callId: string }
  | { type: 'stop' }
  | { type: 'closed'; reason?: string | null };

/** `confirming` while the budget card is up (no session, no call). */
export const BUDGET_CONFIRMING = 'budget';

export const initialMachine: MachineState = {
  base: 'off', reason: null, lastInputAt: null, lastOutputAt: null, lastMicActiveAt: null, awaitingReply: false,
  outputLevel: 0, openDelegations: [], runningCalls: [], confirming: null,
};

const without = (list: readonly string[], id: string) => list.filter((x) => x !== id);
const withId = (list: readonly string[], id: string) => (list.includes(id) ? list : [...list, id]);

export function reduce(s: MachineState, e: MachineEvent): MachineState {
  switch (e.type) {
    case 'start':
      // From off, ended or unavailable (a retry). Never while a session is open or closing.
      return s.base === 'connecting' || s.base === 'live' || s.base === 'closing' ? s : { ...initialMachine, base: 'connecting' };
    case 'unavailable':
      return { ...initialMachine, base: 'unavailable', reason: e.reason };
    case 'budget-confirm':
      return { ...initialMachine, base: 'off', confirming: BUDGET_CONFIRMING };
    case 'failed':
      return { ...initialMachine, base: 'ended', reason: e.reason };
    case 'started':
      return s.base === 'connecting' ? { ...s, base: 'live' } : s;
    case 'input':
      // Barge-in: the user talking stops the "speaking" hold.
      return s.base === 'live' ? { ...s, lastInputAt: e.at, lastOutputAt: null, awaitingReply: true } : s;
    case 'output':
      return s.base === 'live' ? { ...s, lastOutputAt: e.at, awaitingReply: false } : s;
    case 'levels':
      return { ...s, outputLevel: e.output, lastMicActiveAt: e.input > MIC_ACTIVE_LEVEL ? e.at : s.lastMicActiveAt };
    case 'delegation':
      return s.base === 'live' ? { ...s, awaitingReply: false, openDelegations: withId(s.openDelegations, e.id) } : s;
    case 'delegation-done':
      return { ...s, openDelegations: without(s.openDelegations, e.id) };
    case 'confirm-shown':
      return s.base === 'live' ? { ...s, confirming: e.callId } : s;
    case 'confirm-resolved':
      return s.confirming === e.callId ? { ...s, confirming: null } : s;
    case 'call-running':
      return s.base === 'live' ? { ...s, runningCalls: withId(s.runningCalls, e.callId) } : s;
    case 'call-done':
      return { ...s, runningCalls: without(s.runningCalls, e.callId) };
    case 'stop':
      return s.base === 'live' || s.base === 'connecting' ? { ...s, base: 'closing', confirming: null } : s;
    case 'closed':
      return s.base === 'off' || s.base === 'unavailable' ? s : { ...initialMachine, base: 'ended', reason: e.reason ?? s.reason };
  }
}

/** The phase the dock shows at `now`. */
export function phaseAt(s: MachineState, now: number): VoicePhase {
  switch (s.base) {
    case 'off': return s.confirming === BUDGET_CONFIRMING ? 'confirming' : 'off';
    case 'connecting': return 'connecting';
    case 'unavailable': return 'unavailable';
    case 'closing':
    case 'ended': return 'ended';
    case 'live': break;
  }
  if (s.confirming) return 'confirming';
  if (s.runningCalls.length > 0 || s.openDelegations.length > 0) return 'executing';
  if ((s.lastOutputAt != null && now - s.lastOutputAt <= SPEAKING_HOLD_MS) || s.outputLevel > SPEAKING_LEVEL) return 'speaking';
  if (s.awaitingReply && s.lastInputAt != null && now - s.lastInputAt < THINKING_MAX_MS
    && (s.lastMicActiveAt == null || now - s.lastMicActiveAt >= MIC_QUIET_MS)) return 'thinking';
  return 'listening';
}

/** Whether the session holds resources (a start is refused, a stop is meaningful). */
export function sessionOpen(s: MachineState): boolean {
  return s.base === 'connecting' || s.base === 'live' || s.base === 'closing';
}
