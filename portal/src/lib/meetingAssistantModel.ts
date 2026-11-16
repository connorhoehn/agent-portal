// The call assistant ("Milo") as the portal sees it: the server's state payload
// (middleware routes/meeting-assistant.ts `view`), reduced to what the call bar,
// the roster line and the transcription notice show. Pure, so node:test covers it.

/** `loading` is the client's own phase until the first state read answers: no Milo control is drawn from a guess. */
export type AssistantPhase = 'loading' | 'none' | 'invited' | 'listening' | 'paused' | 'left';

/** Whether the call's audio reaches Milo (the server's view): joining or between live sessions, or the audio never arrived. */
export type AssistantHearing = 'ok' | 'connecting' | 'no-audio';

/** One request Milo is working on: who asked and whether it looks something up or makes a change. Never what was asked. */
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
  /** The display name of whoever dismissed Milo; null when Milo left on its own (`leftBy` is 'system') or the name is unknown. */
  leftByName: string | null;
  /** True when this person has not yet acknowledged the transcription notice. */
  youMustAck: boolean;
  /** Seconds Milo has listened, and the ceiling it leaves at; null while the server has not said. */
  listeningSeconds: number | null;
  ceilingSeconds: number | null;
  /** Milo speaks aloud in this call (off unless an inviter turned it on). */
  voice: boolean;
  hearing: AssistantHearing;
  openRequests: OpenRequest[];
  waitingActions: WaitingAction[];
  /**
   * After Milo left: whether it can be invited back ('allowed'), or why never in this call: its record was deleted, or the call used all
   * the listening time it may have. Null while Milo is in the call (or none).
   */
  rejoin: RejoinStanding | null;
  /** While Milo is here: whether it could be invited back if it left now (the dismissal question promises it only then); null when unknown. */
  rejoinLater: RejoinStanding | null;
  /** After Milo left: its earlier period is still finishing, so an invitation back waits for it ("Milo is leaving…"). */
  leaving: boolean;
  /** What one "Extend time" adds now, in seconds (0 at the call's hard maximum: not offered); null when the server has not said. */
  extendSeconds: number | null;
  /** This person acknowledged Milo in an earlier period of this call: their notice says everyone acknowledges once more. */
  youAckedBefore: boolean;
  /** Which period of Milo in this call this is (1 for the first, 2 after it was invited back once, ...). */
  period: number;
}

/** 'almost': less than five minutes of the call's listening time are left, too little for an invitation back. */
export type RejoinStanding = 'allowed' | 'deleted' | 'limit' | 'almost';

/** The state is refreshed this often while a call is live (docs: keep any poll at 5 s or slower). */
export const ASSISTANT_POLL_MS = 5000;

/** Meetings (the nav entry, the palette row, both routes) exist only while the session says the server runs the feature. */
export const meetingsAdvertised = (session: { meetingAssistant?: boolean } | null | undefined): boolean => session?.meetingAssistant === true;

export const ASSISTANT_NAME = 'Milo';
export const ASSISTANT_LABEL = 'Assistant';

const PHASES: readonly AssistantPhase[] = ['none', 'invited', 'listening', 'paused', 'left'];
const HEARING: readonly AssistantHearing[] = ['ok', 'connecting', 'no-audio'];
const REJOIN: readonly RejoinStanding[] = ['allowed', 'deleted', 'limit', 'almost'];
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
    rejoinLater: present(phase) ? REJOIN.find((r) => r === b['rejoinLater']) ?? null : null,
    leaving: phase === 'left' && b['leaving'] === true,
    extendSeconds: phase === 'listening' || phase === 'paused' ? seconds(b['extendSeconds']) : null,
    youAckedBefore: b['youAckedBefore'] === true,
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

/** Before the first state read: nothing is known, so nothing is drawn (no "Invite Milo" flash while Milo is already there). */
export const LOADING_ASSISTANT = (callId: string): AssistantView => ({ ...NO_ASSISTANT(callId), phase: 'loading' });

/** Milo is in the call and taking part (listening or paused). */
export const assistantPresent = (v: AssistantView): boolean => present(v.phase);

/** Milo's time limit is reached (it left on its own at the ceiling). */
const atLimit = (v: AssistantView): boolean => v.listeningSeconds !== null && v.ceilingSeconds !== null && v.listeningSeconds >= v.ceilingSeconds;

/** Why Milo left, for the chip: who dismissed it, its time limit or a lost connection. */
export function leftWords(v: AssistantView): string {
  return v.leftBy && v.leftBy !== 'system' ? `${v.leftByName ?? 'Someone'} dismissed ${ASSISTANT_NAME}`
    : atLimit(v) ? `${ASSISTANT_NAME} reached its time limit` : `${ASSISTANT_NAME} lost its connection`;
}

/** Why Milo can never be invited back into this call, for the left chip's tooltip; null when it can be. The server's sentences. */
export function rejoinRefusedWords(v: AssistantView): string | null {
  if (v.rejoin === 'deleted') return `This call's record was deleted, so ${ASSISTANT_NAME} cannot join it again.`;
  if (v.rejoin === 'limit') return `${ASSISTANT_NAME} has already listened to this call for as long as it can.`;
  if (v.rejoin === 'almost') return `${ASSISTANT_NAME} has almost used this call's listening time and cannot be invited back.`;
  return null;
}

/** The invite-again button: while the invitation back waits for Milo's earlier leave to finish, it says so. */
export const LEAVING_LABEL = `${ASSISTANT_NAME} is leaving…`;
export const inviteAgainLabel = (v: AssistantView, busy: boolean): string => (busy && v.leaving ? LEAVING_LABEL : INVITE_AGAIN_LABEL);

/** The button that brings Milo back into a call it left. */
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

/** What Milo is doing for someone right now ("Milo is looking that up for Una"), or null. Several at once name the first and count the rest. */
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

/** Milo's voice on the mark, so it can be seen without opening the menu: on for the call, and muted by this person. Null when off. */
export function voiceWords(v: AssistantView, mutedForMe: boolean): string | null {
  if (!assistantPresent(v) || !v.voice) return null;
  return mutedForMe ? `${ASSISTANT_NAME} muted for you` : `${ASSISTANT_NAME}'s voice on`;
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

/** The one question asked before a dismissal: it is for everyone. It promises an invitation back only when one would be allowed. */
export const DISMISS_LABEL = `Dismiss ${ASSISTANT_NAME} for everyone`;
export const dismissQuestion = (v: AssistantView): string =>
  `${ASSISTANT_NAME} leaves the call for everyone.${v.rejoinLater === 'allowed' ? ` Anyone who can invite ${ASSISTANT_NAME} can invite it back later.` : ''}`;

/** "Adds 60 minutes, held against Vera Green's budget": what one extend buys and whose budget it is held against. */
export function extendWords(v: AssistantView, mine: boolean): string | null {
  if (v.extendSeconds === null || v.extendSeconds <= 0) return null;
  const m = Math.round(v.extendSeconds / 60);
  return `Adds ${m >= 1 ? `${m} ${m === 1 ? 'minute' : 'minutes'}` : 'less than a minute'}, held against ${mine ? 'your' : `${v.invitedByName ?? 'the inviter'}'s`} budget`;
}

const usd = (v: number): string => `$${v < 1 ? v.toFixed(2) : v.toFixed(2).replace(/\.00$/, '')}`;
/**
 * The over-budget ask for Milo's time, saying what is bought and by whom: "Inviting Milo holds up to $3 of your budget for 60 minutes of
 * listening, which goes past it by $1.50. Go ahead anyway?" Missing figures drop their clause; the question stays.
 */
export function budgetAskWords(action: 'invite' | 'extend' | 'resume', b: { estimateUsd: number | null; remainingUsd: number | null; seconds: number | null }): { title: string; detail: string } {
  const lead = action === 'invite' ? `Inviting ${ASSISTANT_NAME}` : action === 'extend' ? `Extending ${ASSISTANT_NAME}'s time` : `Resuming ${ASSISTANT_NAME}`;
  const m = b.seconds !== null ? Math.round(b.seconds / 60) : null;
  const time = m === null ? '' : ` for ${m >= 1 ? `${m} ${m === 1 ? 'minute' : 'minutes'}` : 'less than a minute'} of listening`;
  const over = b.estimateUsd !== null && b.remainingUsd !== null ? Math.max(0, b.estimateUsd - Math.max(0, b.remainingUsd)) : null;
  const holds = b.estimateUsd !== null ? `${lead} holds up to ${usd(b.estimateUsd)} of your budget${time}` : `${lead} goes past your budget${time}`;
  return { title: 'Over your budget', detail: `${holds}${b.estimateUsd !== null && over !== null && over > 0 ? `, which goes past it by ${usd(over)}` : b.estimateUsd !== null ? ', which goes past it' : ''}. Go ahead anyway?` };
}

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
  /** This person has not acknowledged yet: Milo cannot hear them, and the mark says so and offers the acknowledgement. */
  acknowledge: boolean;
  /** Add time to the ceiling: people who may invite Milo, while it is in the call. */
  extend: boolean;
  /** Milo left this call: the bar says why. */
  left: boolean;
  /** Milo left and may be invited back: people who may invite get "Invite Milo again" beside the chip. */
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
    // Not offered at the call's hard maximum, where it would only fail.
    extend: (phase === 'listening' || phase === 'paused') && input.canInvite && input.view.extendSeconds !== 0,
    left: phase === 'left',
    inviteAgain: phase === 'left' && input.canInvite && input.view.rejoin === 'allowed',
  };
}

/** The transcription notice shows to someone who still owes an acknowledgement while Milo is in the call. */
export const noticeVisible = (enabled: boolean, v: AssistantView): boolean => enabled && assistantPresent(v) && v.youMustAck;

/**
 * The notice's sentences. Plain words: who invited, where speech goes, how long it is kept, what is kept before you agree. After an
 * invitation back, someone who acknowledged before is told everyone acknowledges once more; anyone else gets the first invitation's
 * words. Either way a later period says Milo adds what it hears to the minutes, and that its voice is off, as the chat notice does.
 */
export function noticeText(v: AssistantView): { title: string; body: string } {
  const who = v.invitedByName ?? 'A participant';
  const kept = 'After that your words are sent to the speech provider and kept as text for the retention period set by your organisation.';
  if (v.period <= 1) return {
    title: `${who} invited ${ASSISTANT_NAME} to listen to this call`,
    body: `${ASSISTANT_NAME} is listening to this call. Nothing you say is kept until you acknowledge. ${kept} ${ASSISTANT_NAME} writes minutes for the people in the call.`,
  };
  const later = `${ASSISTANT_NAME} adds what it hears to the minutes for the people in the call. ${ASSISTANT_NAME}'s voice is off until someone turns it on.`;
  return v.youAckedBefore ? {
    title: `${who} invited ${ASSISTANT_NAME} back into this call`,
    body: `${ASSISTANT_NAME} is listening to this call again. Everyone acknowledges once more: nothing you say is kept until you do. ${kept} ${later}`,
  } : {
    title: `${who} invited ${ASSISTANT_NAME} to listen to this call`,
    body: `${ASSISTANT_NAME} is listening to this call. Nothing you say is kept until you acknowledge. ${kept} ${later}`,
  };
}

/** The roster line for the people lists the call surfaces already have ("Milo (Assistant, listening)"). */
export function rosterEntry(v: AssistantView): string | null {
  if (!assistantPresent(v)) return null;
  return `${ASSISTANT_NAME} (${ASSISTANT_LABEL}, ${v.phase === 'paused' ? 'paused' : 'listening'})`;
}

/** Minutes before Milo leaves (rounded up), or null when the server has not said. Never negative. */
export function minutesLeft(v: AssistantView): number | null {
  if (v.listeningSeconds === null || v.ceilingSeconds === null) return null;
  return Math.max(0, Math.ceil((v.ceilingSeconds - v.listeningSeconds) / 60));
}

/** The warning is shown from this many minutes before Milo leaves. */
export const LEFT_WARNING_MINUTES = 10;

/** "8 min left" while Milo is listening and the end is near; null otherwise. */
export function timeLeftWords(v: AssistantView): string | null {
  if (v.phase !== 'listening' && v.phase !== 'invited') return null;
  const m = minutesLeft(v);
  return m !== null && m < LEFT_WARNING_MINUTES ? `${m} min left` : null;
}

/** What the mark says: the state, or, once the notice was closed without acknowledging, that Milo cannot hear this person yet. */
export function markWords(v: AssistantView, noticeClosed: boolean): string | null {
  if (noticeClosed && assistantPresent(v) && v.youMustAck) return `${ASSISTANT_NAME} cannot hear you yet`;
  // Hearing trouble outranks the work line: a request made now would not be heard.
  if (v.phase === 'listening' && v.hearing === 'ok') return workingWords(v) ?? assistantStateWords(v);
  return assistantStateWords(v);
}
