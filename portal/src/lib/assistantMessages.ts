// What Milo puts in the call chat, as the portal reads it. The shapes mirror
// middleware/src/lib/meeting-assistant/chat-types.ts; change both together.
//
// Trust: the BFF shows these keys only on a message whose stored author is the assistant's fixed identity
// (lib/call-chat.ts `render`), and refuses them from a person on the way in, so a message that carries them here
// is Milo's. This file still validates the shape so a malformed row renders as an ordinary message, not a broken card.

import { pokeTurns } from './meetingTurnsPoke.ts';
import { PROPOSAL_STATES, type ProposalState } from './meetingProposals.ts';

export type AssistantActionStatus = 'waiting' | 'confirmed' | 'declined' | 'expired' | 'done' | 'failed';
const STATUSES: readonly AssistantActionStatus[] = ['waiting', 'confirmed', 'declined', 'expired', 'done', 'failed'];

/** What a minutes notice counts; `decisions` includes those consented through the call's proposals (the server counts them). */
export interface MinutesCounts { decisions: number; actionItems: number; proposals: number; /** Milo added a later part of the call to minutes that existed. */ added?: boolean }
export interface AssistantNotice {
  kind: 'assistant-notice';
  /** The meeting this notice closes; the chat links to its page. */
  meetingCallId?: string;
  /** Only on the minutes notice: its text is the summary's first sentences, and the chat draws it as a card with these counts. */
  minutes?: MinutesCounts;
}
export interface AssistantReply { kind: 'assistant-reply'; askedBy: string; askedByName: string }
export interface AssistantAction {
  kind: 'assistant-action';
  actionId: string;
  askedBy: string;
  askedByName: string;
  summary: string;
  /** The record's own name, the card's headline; absent on a write that names none (and on cards posted before it existed). */
  title?: string;
  /** What confirming does, in plain words ("Creates a work item"); the card adds where it lands. */
  does?: string;
  detail: string[];
  tool: { name: string; argsDigest: string };
  status: AssistantActionStatus;
  resultText?: string;
}
/** A proposal card: only its id and state ride on the message (the statement is the text); the rest is read from the proposals route. */
export interface AssistantProposalCard { kind: 'assistant-proposal'; proposalId: string; state: ProposalState }
export type AssistantMessage = AssistantNotice | AssistantReply | AssistantAction | AssistantProposalCard;

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function readCounts(v: unknown): MinutesCounts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  return count(c['decisions']) && count(c['actionItems']) && count(c['proposals'])
    ? { decisions: c['decisions'], actionItems: c['actionItems'], proposals: c['proposals'], ...(c['added'] === true ? { added: true } : {}) } : null;
}

/** The assistant message a chat message's metadata describes, or null for anything else. */
export function readAssistantMessage(metadata: Record<string, unknown> | undefined): AssistantMessage | null {
  if (!metadata || metadata['assistant'] !== true) return null;
  if (metadata['kind'] === 'assistant-notice') {
    const minutes = readCounts(metadata['minutes']);
    return { kind: 'assistant-notice', ...(text(metadata['meetingCallId']) ? { meetingCallId: metadata['meetingCallId'] } : {}), ...(minutes ? { minutes } : {}) };
  }
  if (metadata['kind'] === 'assistant-reply') {
    return text(metadata['askedBy']) && text(metadata['askedByName'])
      ? { kind: 'assistant-reply', askedBy: metadata['askedBy'], askedByName: metadata['askedByName'] } : null;
  }
  if (metadata['kind'] === 'assistant-action') {
    const tool = metadata['tool'];
    const status = metadata['status'];
    if (!text(metadata['actionId']) || !text(metadata['askedBy']) || !text(metadata['askedByName']) || !text(metadata['summary'])
      || !tool || typeof tool !== 'object' || !text((tool as Record<string, unknown>)['name']) || !STATUSES.includes(status as AssistantActionStatus)) return null;
    const detail = Array.isArray(metadata['detail']) ? metadata['detail'].filter((x): x is string => typeof x === 'string') : [];
    return {
      kind: 'assistant-action', actionId: metadata['actionId'], askedBy: metadata['askedBy'], askedByName: metadata['askedByName'], summary: metadata['summary'],
      ...(text(metadata['title']) ? { title: metadata['title'] } : {}), ...(text(metadata['does']) ? { does: metadata['does'] } : {}), detail,
      tool: { name: String((tool as Record<string, unknown>)['name']), argsDigest: String((tool as Record<string, unknown>)['argsDigest'] ?? '') },
      status: status as AssistantActionStatus, ...(text(metadata['resultText']) ? { resultText: metadata['resultText'] } : {}),
    };
  }
  if (metadata['kind'] === 'assistant-proposal') {
    return text(metadata['proposalId']) && PROPOSAL_STATES.includes(metadata['state'] as ProposalState)
      ? { kind: 'assistant-proposal', proposalId: metadata['proposalId'], state: metadata['state'] as ProposalState } : null;
  }
  return null;
}

/** Is this chat message Milo's? The same gate as the cards: well-formed assistant metadata, which only Milo's stored messages carry. */
export const isAssistantChatMessage = (message: { metadata?: Record<string, unknown> }): boolean => readAssistantMessage(message.metadata) !== null;

/** The minutes card's counts, each as its own short label: "2 decisions", "1 action item", "0 proposals". */
export function minutesCountLabels(counts: MinutesCounts): { decisions: string; actionItems: string; proposals: string } {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return { decisions: n(counts.decisions, 'decision', 'decisions'), actionItems: n(counts.actionItems, 'action item', 'action items'), proposals: n(counts.proposals, 'proposal', 'proposals') };
}

/** The line under a reply: who asked. */
export const askedByLine = (reply: Pick<AssistantReply, 'askedByName'>): string => `Asked by ${reply.askedByName}`;

/** What a card says about itself and what the viewer may do. Only the asker may decide, and only while it waits. */
export interface ActionCardView {
  statusLabel: string;
  tone: 'info' | 'success' | 'warning' | 'error' | 'neutral' | 'pending';
  /** Active Confirm and Decline: the asker, while waiting. */
  canDecide: boolean;
  /** For everyone else, while it waits: "Waiting for Una". */
  waitingNote: string | null;
}

export function actionCardView(action: AssistantAction, viewerId: string | null): ActionCardView {
  const asker = viewerId !== null && viewerId === action.askedBy;
  const waiting = action.status === 'waiting';
  const label: Record<AssistantActionStatus, [string, ActionCardView['tone']]> = {
    waiting: ['Waiting for confirmation', 'pending'], confirmed: ['Confirmed, running', 'info'], declined: ['Declined', 'neutral'],
    expired: ['Expired', 'warning'], done: ['Done', 'success'], failed: ['Failed', 'error'],
  };
  const [statusLabel, tone] = label[action.status];
  return { statusLabel, tone, canDecide: asker && waiting, waitingNote: waiting && !asker ? `Waiting for ${action.askedByName}` : null };
}

export type ActionDecision = 'confirm' | 'decline';

/** POST the asker's decision; the server updates the card's message, which reaches every reader as an ordinary edit. */
export async function decideAssistantAction(callId: string, actionId: string, decision: ActionDecision, request: typeof fetch = fetch): Promise<void> {
  const response = await request(`/api/calls/${encodeURIComponent(callId)}/assistant/actions/${encodeURIComponent(actionId)}/decision`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision }),
  });
  if (response.ok) { pokeTurns(callId); return; }
  const json: unknown = await response.json().catch(() => null);
  const message = json && typeof json === 'object' && typeof (json as Record<string, unknown>)['error'] === 'string' ? String((json as Record<string, unknown>)['error']) : '';
  throw new Error(message || `The decision could not be saved (${response.status}).`);
}

/** A new work item whose arguments (listed in the card's detail lines) name no initiative lands on the call's own: only then does the card say which. */
export const namesNoInitiative = (action: Pick<AssistantAction, 'tool' | 'detail'>): boolean =>
  action.tool.name === 'create' && action.detail.some((l) => /^kind:\s*work-item\s*$/i.test(l)) && !action.detail.some((l) => /^initiative\b/i.test(l));

// ---- the card's anatomy (one shape for the action, proposal and minutes cards) -------------------------------------------------

/**
 * How big and loud a Milo card is, from its state and the viewer: `you` (it waits on the viewer: the full card, in Milo's accent),
 * `others` (it waits on someone else, or is running: the full card on the plain surface), `done` (one row with a success mark) and
 * `muted` (declined, expired, failed, not a decision...: one quiet row with the reason). A row can be opened to the full card.
 */
export type CardLayout = 'you' | 'others' | 'done' | 'muted';

export function actionLayout(action: Pick<AssistantAction, 'status' | 'askedBy'>, viewerId: string | null): CardLayout {
  if (action.status === 'done') return 'done';
  if (action.status === 'declined' || action.status === 'expired' || action.status === 'failed') return 'muted';
  return action.status === 'waiting' && viewerId !== null && viewerId === action.askedBy ? 'you' : 'others';
}

/** The header's left side: what it is and who asked. */
export const actionHeader = (action: Pick<AssistantAction, 'askedByName'>): string => `Action · asked by ${action.askedByName}`;

/** The headline: the record's own name, or the action's sentence when the write names none. */
export const actionTitle = (action: Pick<AssistantAction, 'title' | 'summary'>): string => action.title ?? action.summary;

/**
 * What confirming will do, in plain words: "Creates a work item in Observability Platform". The call's initiative is named only for
 * a new work item whose arguments name none (it lands there); null on a card that carries no such line (posted before it existed).
 */
export function actionDoesLine(action: Pick<AssistantAction, 'does' | 'tool' | 'detail'>, initiativeName: string | null): string | null {
  if (!action.does) return null;
  return initiativeName && namesNoInitiative(action) && !/\bin\s/.test(action.does) ? `${action.does} in ${initiativeName}` : action.does;
}

/** Who it waits on, in words: "Waiting for you to confirm" for the asker, "Waiting for Vera Green" for everyone else; null once decided. */
export function actionNeedsLine(action: Pick<AssistantAction, 'status' | 'askedBy' | 'askedByName'>, viewerId: string | null): string | null {
  if (action.status !== 'waiting') return null;
  return viewerId !== null && viewerId === action.askedBy ? 'Waiting for you to confirm' : `Waiting for ${action.askedByName}`;
}

/**
 * The one row a finished or closed card collapses to: what was done ("Created “the login cookie bug”") or the headline with the
 * reason ("the nightly audit · Milo was dismissed before this was done."). Always carries the headline, so the row is found by it.
 */
export function actionRowText(action: Pick<AssistantAction, 'status' | 'title' | 'summary' | 'tool' | 'resultText' | 'askedByName'>): string {
  const title = actionTitle(action);
  switch (action.status) {
    case 'done': return action.tool.name === 'create' && action.title ? `Created “${action.title}”` : title;
    case 'declined': return `${title} · ${action.askedByName} declined it, so nothing was done.`;
    case 'expired': return `${title} · ${action.resultText ?? 'Nobody confirmed it in time, so nothing was done.'}`;
    case 'failed': return `${title} · ${action.resultText ?? 'It did not work, so nothing was changed.'}`;
    default: return title;
  }
}

/** The minutes card's counts as one line: "2 decisions · 3 action items · 1 proposal". */
export function minutesCountLine(counts: MinutesCounts): string {
  const l = minutesCountLabels(counts);
  return `${l.decisions} · ${l.actionItems} · ${l.proposals}`;
}

/** A notice longer than this is a block with its first sentence showing and the rest behind "More"; a shorter one stays a pill. */
export const LONG_NOTICE_CHARS = 120;
export const isLongNotice = (content: string): boolean => content.trim().length > LONG_NOTICE_CHARS;

/** A long notice split at its first sentence: what shows, and the rest (empty when it is one sentence). */
export function splitNotice(content: string): { first: string; rest: string } {
  const t = content.trim();
  const m = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(t);
  return m ? { first: m[1]!, rest: m[2]! } : { first: t, rest: '' };
}
