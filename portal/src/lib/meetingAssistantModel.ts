// The call assistant ("Nova") as the portal sees it: the server's state payload
// (middleware routes/meeting-assistant.ts `view`), reduced to what the call bar,
// the roster line and the transcription notice show. Pure, so node:test covers it.

/** `loading` is the client's own phase until the first state read answers: no Nova control is drawn from a guess. */
export type AssistantPhase = 'loading' | 'none' | 'invited' | 'listening' | 'paused' | 'left';

/** Whether the call's audio reaches Nova (the server's view): joining or between live sessions, or the audio never arrived. */
export type AssistantHearing = 'ok' | 'connecting' | 'no-audio';

/** One request Nova is working on: who asked and whether it looks something up or makes a change. Never what was asked. */
export interface OpenRequest { askerName: string; kind: 'lookup' | 'change' }

/** A change card waiting for its asker's decision: when it expires (epoch ms) and whether it waits on this viewer. */
export interface WaitingAction { actionId: string; expiresAt: number; mine: boolean }

export interface AssistantView {
  callId: string;
  phase: AssistantPhase;
  invitedBy: string | null;
  /** The initiative the call was started from (a work item made from a card lands on it), or null. */
  initiativeId: string | null;
  /** Display name of the inviter, when the directory has one. */
  invitedByName: string | null;
  pausedBy: string | null;
  leftBy: string | null;
  /** The display name of whoever dismissed Nova; null when Nova left on its own (`leftBy` is 'system') or the name is unknown. */
  leftByName: string | null;
  /** True when this person has not yet acknowledged the transcription notice. */
  youMustAck: boolean;
  /** Seconds Nova has listened, and the ceiling it leaves at; null while the server has not said. */
  listeningSeconds: number | null;
  ceilingSeconds: number | null;
  /** Nova speaks aloud in this call (off unless an inviter turned it on). */
  voice: boolean;
  hearing: AssistantHearing;
  openRequests: OpenRequest[];
  waitingActions: WaitingAction[];
  /**
   * After Nova left: whether it can be invited back ('allowed'), or why never in this call: its record was deleted, or the call used all
   * the listening time it may have. Null while Nova is in the call (or none).
   */
  rejoin: RejoinStanding | null;
  /** Which period of Nova in this call this is (1 for the first, 2 after it was invited back once, ...). */
  period: number;
}

export type RejoinStanding = 'allowed' | 'deleted' | 'limit';

/** The state is refreshed this often while a call is live (docs: keep any poll at 5 s or slower). */
export const ASSISTANT_POLL_MS = 5000;

/** Meetings (the nav entry, the palette row, both routes) exist only while the session says the server runs the feature. */
export const meetingsAdvertised = (session: { meetingAssistant?: boolean } | null | undefined): boolean => session?.meetingAssistant === true;

export const ASSISTANT_NAME = 'Nova';
export const ASSISTANT_LABEL = 'Assistant';

const PHASES: readonly AssistantPhase[] = ['none', 'invited', 'listening', 'paused', 'left'];
const HEARING: readonly AssistantHearing[] = ['ok', 'connecting', 'no-audio'];
const REJOIN: readonly RejoinStanding[] = ['allowed', 'deleted', 'limit'];
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const list = <T>(v: unknown, read: (r: Record<string, unknown>) => T | null): T[] =>
  Array.isArray(v) ? v.map((x) => { const r = record(x); return r ? read(r) : null; }).filter((x): x is T => x !== null) : [];
const seconds = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Reads one `GET …/assistant/state` (or an action's) body; anything unrecognised reads as "no assistant". */
export function parseAssistantState(callId: string, body: unknown): AssistantView {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const phase = PHASES.find((p) => p === b['state']) ?? 'none';
  return {
    callId, phase,
    invitedBy: text(b['invitedBy']), initiativeId: text(b['initiativeId']), invitedByName: text(b['invitedByName']),
    pausedBy: text(b['pausedBy']), leftBy: text(b['leftBy']), leftByName: text(b['leftByName']),
    youMustAck: phase !== 'none' && phase !== 'left' && b['youMustAck'] === true,
    listeningSeconds: seconds(b['listeningSeconds']), ceilingSeconds: seconds(b['ceilingSeconds']),
    voice: phase !== 'none' && phase !== 'left' && b['voice'] === true,
    hearing: HEARING.find((h) => h === b['hearing']) ?? 'ok',
    rejoin: phase === 'left' ? REJOIN.find((r) => r === b['rejoin']) ?? null : null,
    period: typeof b['period'] === 'number' && Number.isInteger(b['period']) && b['period'] >= 1 ? b['period'] : 1,
    openRequests: present(phase) ? list(b['openRequests'], (r) => {
      const name = text(r['askerName']);
      return name && (r['kind'] === 'lookup' || r['kind'] === 'change') ? { askerName: name, kind: r['kind'] } : null;
    }) : [],
    waitingActions: present(phase) ? list(b['waitingActions'], (r) => {
      const id = text(r['actionId']); const at = seconds(r['expiresAt']);
      return id && at !== null ? { actionId: id, expiresAt: at, mine: r['mine'] === true } : null;
    }) : [],
  };
}

const present = (phase: AssistantPhase): boolean => phase === 'invited' || phase === 'listening' || phase === 'paused';

export const NO_ASSISTANT = (callId: string): AssistantView => parseAssistantState(callId, null);

/** Before the first state read: nothing is known, so nothing is drawn (no "Invite Nova" flash while Nova is already there). */
export const LOADING_ASSISTANT = (callId: string): AssistantView => ({ ...NO_ASSISTANT(callId), phase: 'loading' });

/** Nova is in the call and taking part (listening or paused). */
export const assistantPresent = (v: AssistantView): boolean => present(v.phase);

/** Nova's time limit is reached (it left on its own at the ceiling). */
const atLimit = (v: AssistantView): boolean => v.listeningSeconds !== null && v.ceilingSeconds !== null && v.listeningSeconds >= v.ceilingSeconds;

/** Why Nova left, for the chip: who dismissed it, its time limit or a lost connection. */
export function leftWords(v: AssistantView): string {
  return v.leftBy && v.leftBy !== 'system' ? `${v.leftByName ?? 'Someone'} dismissed ${ASSISTANT_NAME}`
    : atLimit(v) ? `${ASSISTANT_NAME} reached its time limit` : `${ASSISTANT_NAME} lost its connection`;
}

/** Why Nova can never be invited back into this call, for the left chip's tooltip; null when it can be. The server's sentences. */
export function rejoinRefusedWords(v: AssistantView): string | null {
  if (v.rejoin === 'deleted') return `This call's record was deleted, so ${ASSISTANT_NAME} cannot join it again.`;
  if (v.rejoin === 'limit') return `${ASSISTANT_NAME} has already listened to this call for as long as it can.`;
  return null;
}

/** The button that brings Nova back into a call it left. */
export const INVITE_AGAIN_LABEL = `Invite ${ASSISTANT_NAME} again`;
/** The invite buttons' tooltip, the same for the first invitation and an invitation back. */
export const INVITE_HINT = `${ASSISTANT_NAME} listens to this call and answers when asked by name`;

/** The state in words, for the call bar and the roster line. Null when there is nothing to say. */
export function assistantStateWords(v: AssistantView): string | null {
  if (v.phase === 'invited') return `${ASSISTANT_NAME} is joining`;
  if (v.phase === 'listening' && v.hearing === 'connecting') return `${ASSISTANT_NAME} is connecting`;
  if (v.phase === 'listening' && v.hearing === 'no-audio') return `${ASSISTANT_NAME} cannot hear the call`;
  if (v.phase === 'listening') return `${ASSISTANT_NAME} is listening`;
  if (v.phase === 'paused') return `${ASSISTANT_NAME} is paused`;
  if (v.phase === 'left') return `${ASSISTANT_NAME} has left this call`;
  return null;
}

/** What Nova is doing for someone right now ("Nova is looking that up for Una"), or null. Several at once name the first and count the rest. */
export function workingWords(v: AssistantView): string | null {
  if (v.phase !== 'listening' && v.phase !== 'invited') return null;
  const [first, ...rest] = v.openRequests;
  if (!first) return null;
  const more = rest.length ? ` (+${rest.length} more)` : '';
  return first.kind === 'lookup' ? `${ASSISTANT_NAME} is looking that up for ${first.askerName}${more}` : `${ASSISTANT_NAME} is working on ${first.askerName}'s request${more}`;
}

/** The change cards waiting on this viewer's decision, soonest expiry first. */
export const myWaitingActions = (v: AssistantView): WaitingAction[] => v.waitingActions.filter((a) => a.mine).sort((a, b) => a.expiresAt - b.expiresAt);

/** "expires in 7 min" for a waiting card (rounded up, at least 1), or null when the card is not waiting or its expiry is unknown. */
export function expiresWords(v: AssistantView, actionId: string, now: number): string | null {
  const a = v.waitingActions.find((w) => w.actionId === actionId);
  if (!a) return null;
  return `expires in ${Math.max(1, Math.ceil((a.expiresAt - now) / 60_000))} min`;
}

/** Nova's voice on the mark, so it can be seen without opening the menu: on for the call, and muted by this person. Null when off. */
export function voiceWords(v: AssistantView, mutedForMe: boolean): string | null {
  if (!assistantPresent(v) || !v.voice) return null;
  return mutedForMe ? 'Muted for you' : 'Voice on';
}

/** The standing facts a late joiner missed in the chat, for the top of the menu. */
export function standingFacts(v: AssistantView): string[] {
  if (!assistantPresent(v)) return [];
  return [
    `Invited by ${v.invitedByName ?? 'a participant'}`,
    v.voice ? `${ASSISTANT_NAME}'s voice is on in this call` : `${ASSISTANT_NAME} answers in the chat; its voice is off`,
    `Anyone here can pause or dismiss ${ASSISTANT_NAME}`,
  ];
}

/** The one question asked before a dismissal: it is for everyone. */
export const DISMISS_LABEL = `Dismiss ${ASSISTANT_NAME} for everyone`;
export const DISMISS_QUESTION = `${ASSISTANT_NAME} leaves the call for everyone. Anyone who can invite ${ASSISTANT_NAME} can invite it back later.`;

/** A bar error stays until a refresh shows the phase moved on since it was raised, or this long. */
export const ERROR_CLEAR_MS = 20_000;
export const errorStale = (raised: { at: number; phase: AssistantPhase }, now: number, phase: AssistantPhase): boolean =>
  now - raised.at >= ERROR_CLEAR_MS || phase !== raised.phase;

export interface AssistantControls {
  /** The whole feature is hidden: flag off, or no call. */
  hidden: boolean;
  invite: boolean;
  pause: boolean;
  resume: boolean;
  dismiss: boolean;
  /** This person has not acknowledged yet: Nova cannot hear them, and the mark says so and offers the acknowledgement. */
  acknowledge: boolean;
  /** Add time to the ceiling: people who may invite Nova, while it is in the call. */
  extend: boolean;
  /** Nova left this call: the bar says why. */
  left: boolean;
  /** Nova left and may be invited back: people who may invite get "Invite Nova again" beside the chip. */
  inviteAgain: boolean;
}

/** What the call bar offers. Invite needs the capability; pause, resume and dismiss are for everyone in the call. */
export function assistantControls(input: { enabled: boolean; inCall: boolean; canInvite: boolean; view: AssistantView }): AssistantControls {
  const off: AssistantControls = { hidden: true, invite: false, pause: false, resume: false, dismiss: false, acknowledge: false, extend: false, left: false, inviteAgain: false };
  if (!input.enabled || !input.inCall) return off;
  const { phase } = input.view;
  if (phase === 'loading') return { ...off, hidden: false };
  return {
    hidden: false,
    invite: phase === 'none' && input.canInvite,
    pause: phase === 'listening' || phase === 'invited',
    resume: phase === 'paused',
    dismiss: assistantPresent(input.view),
    acknowledge: assistantPresent(input.view) && input.view.youMustAck,
    extend: (phase === 'listening' || phase === 'paused') && input.canInvite,
    left: phase === 'left',
    inviteAgain: phase === 'left' && input.canInvite && input.view.rejoin === 'allowed',
  };
}

/** The transcription notice shows to someone who still owes an acknowledgement while Nova is in the call. */
export const noticeVisible = (enabled: boolean, v: AssistantView): boolean => enabled && assistantPresent(v) && v.youMustAck;

/** The notice's sentences. Plain words: who invited, where speech goes, how long it is kept, what is kept before you agree. */
export function noticeText(v: AssistantView): { title: string; body: string } {
  const who = v.invitedByName ?? 'A participant';
  return {
    title: v.period > 1 ? `${who} invited ${ASSISTANT_NAME} back into this call` : `${who} invited ${ASSISTANT_NAME} to listen to this call`,
    body: `${ASSISTANT_NAME} is listening to this call. Nothing you say is kept until you acknowledge. After that your words are sent to the speech provider and kept as text for the retention period set by your organisation. ${ASSISTANT_NAME} writes minutes for the people in the call.`,
  };
}

/** The roster line for the people lists the call surfaces already have ("Nova (Assistant, listening)"). */
export function rosterEntry(v: AssistantView): string | null {
  if (!assistantPresent(v)) return null;
  return `${ASSISTANT_NAME} (${ASSISTANT_LABEL}, ${v.phase === 'paused' ? 'paused' : 'listening'})`;
}

/** Minutes before Nova leaves (rounded up), or null when the server has not said. Never negative. */
export function minutesLeft(v: AssistantView): number | null {
  if (v.listeningSeconds === null || v.ceilingSeconds === null) return null;
  return Math.max(0, Math.ceil((v.ceilingSeconds - v.listeningSeconds) / 60));
}

/** The warning is shown from this many minutes before Nova leaves. */
export const LEFT_WARNING_MINUTES = 10;

/** "8 min left" while Nova is listening and the end is near; null otherwise. */
export function timeLeftWords(v: AssistantView): string | null {
  if (v.phase !== 'listening' && v.phase !== 'invited') return null;
  const m = minutesLeft(v);
  return m !== null && m < LEFT_WARNING_MINUTES ? `${m} min left` : null;
}

/** What the mark says: the state, or, once the notice was closed without acknowledging, that Nova cannot hear this person yet. */
export function markWords(v: AssistantView, noticeClosed: boolean): string | null {
  if (noticeClosed && assistantPresent(v) && v.youMustAck) return `${ASSISTANT_NAME} cannot hear you yet`;
  // Hearing trouble outranks the work line: a request made now would not be heard.
  if (v.phase === 'listening' && v.hearing === 'ok') return workingWords(v) ?? assistantStateWords(v);
  return assistantStateWords(v);
}
