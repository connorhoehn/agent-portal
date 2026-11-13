// The call assistant ("Nova") as the portal sees it: the server's state payload
// (middleware routes/meeting-assistant.ts `view`), reduced to what the call bar,
// the roster line and the transcription notice show. Pure, so node:test covers it.

export type AssistantPhase = 'none' | 'invited' | 'listening' | 'paused' | 'left';

export interface AssistantView {
  callId: string;
  phase: AssistantPhase;
  invitedBy: string | null;
  /** Display name of the inviter, when the directory has one. */
  invitedByName: string | null;
  pausedBy: string | null;
  leftBy: string | null;
  /** True when this person has not yet acknowledged the transcription notice. */
  youMustAck: boolean;
}

/** The state is refreshed this often while a call is live (docs: keep any poll at 5 s or slower). */
export const ASSISTANT_POLL_MS = 5000;

export const ASSISTANT_NAME = 'Nova';
export const ASSISTANT_LABEL = 'Assistant';

const PHASES: readonly AssistantPhase[] = ['none', 'invited', 'listening', 'paused', 'left'];
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Reads one `GET …/assistant/state` (or an action's) body; anything unrecognised reads as "no assistant". */
export function parseAssistantState(callId: string, body: unknown): AssistantView {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const phase = PHASES.find((p) => p === b['state']) ?? 'none';
  return {
    callId, phase,
    invitedBy: text(b['invitedBy']), invitedByName: text(b['invitedByName']),
    pausedBy: text(b['pausedBy']), leftBy: text(b['leftBy']),
    youMustAck: phase !== 'none' && phase !== 'left' && b['youMustAck'] === true,
  };
}

export const NO_ASSISTANT = (callId: string): AssistantView => parseAssistantState(callId, null);

/** Nova is in the call and taking part (listening or paused). */
export const assistantPresent = (v: AssistantView): boolean => v.phase === 'invited' || v.phase === 'listening' || v.phase === 'paused';

/** The state in words, for the call bar and the roster line. Null when there is nothing to say. */
export function assistantStateWords(v: AssistantView): string | null {
  if (v.phase === 'listening' || v.phase === 'invited') return `${ASSISTANT_NAME} is listening`;
  if (v.phase === 'paused') return `${ASSISTANT_NAME} is paused`;
  if (v.phase === 'left') return `${ASSISTANT_NAME} has left this call`;
  return null;
}

export interface AssistantControls {
  /** The whole feature is hidden: flag off, or no call. */
  hidden: boolean;
  invite: boolean;
  pause: boolean;
  resume: boolean;
  dismiss: boolean;
  /** Nova left this call; the server refuses a re-invite, so the bar says so instead of offering Invite. */
  left: boolean;
}

/** What the call bar offers. Invite needs the capability; pause, resume and dismiss are for everyone in the call. */
export function assistantControls(input: { enabled: boolean; inCall: boolean; canInvite: boolean; view: AssistantView }): AssistantControls {
  const off: AssistantControls = { hidden: true, invite: false, pause: false, resume: false, dismiss: false, left: false };
  if (!input.enabled || !input.inCall) return off;
  const { phase } = input.view;
  return {
    hidden: false,
    invite: phase === 'none' && input.canInvite,
    pause: phase === 'listening' || phase === 'invited',
    resume: phase === 'paused',
    dismiss: assistantPresent(input.view),
    left: phase === 'left',
  };
}

/** The transcription notice shows to someone who still owes an acknowledgement while Nova is in the call. */
export const noticeVisible = (enabled: boolean, v: AssistantView): boolean => enabled && assistantPresent(v) && v.youMustAck;

/** The notice's sentences. Plain words: who invited, where speech goes, how long it is kept, what is kept before you agree. */
export function noticeText(v: AssistantView): { title: string; body: string } {
  const who = v.invitedByName ?? 'A participant';
  return {
    title: `${who} invited ${ASSISTANT_NAME} to listen to this call`,
    body: `${ASSISTANT_NAME} sends what is said to a speech provider and keeps it as text for 30 days. Nothing you say is kept until you acknowledge.`,
  };
}

/** The roster line for the people lists the call surfaces already have ("Nova (Assistant, listening)"). */
export function rosterEntry(v: AssistantView): string | null {
  if (!assistantPresent(v)) return null;
  return `${ASSISTANT_NAME} (${ASSISTANT_LABEL}, ${v.phase === 'paused' ? 'paused' : 'listening'})`;
}
