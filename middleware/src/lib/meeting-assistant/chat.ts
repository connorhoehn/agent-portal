// Milo's voice in the call chat (docs/meeting-assistant-design.md, decisions 4 to 6, 8).
//
// The path. A seatless server post: `postThreadMessage` (lib/social-chat.ts), the same one REST comments and bot-run
// system comments use. It writes the call chat's own message store, then hands the row to the gateway's
// `appendServerMessage` IN-PROCESS, which broadcasts it through the router; every recipient's frame then passes the
// call chat's `filterFrame` (seat check, history floor, `render`). A status change goes through `updateThreadMessage`
// (`ChatService.updateSystemMessage`: persist, then `messageUpdated`). Nothing here opens a socket or presents a
// token to the gateway, so it does not depend on the gateway running with authentication off; with the gateway
// off (a unit test, the BFF alone) the row is stored and readers get it on their next read. That in-process hand-off
// is the ONE coupling, and it lives in `social-chat.ts` (`setThreadLiveAppend` / `setThreadLiveUpdate`).
//
// Who may post: only server code that calls this module. The huddle send path refuses the author and the keys
// (call-chat-send.ts), and `render` only shows the assistant keys on a message Milo authored (call-chat.ts).
//
// When: only while an assistant record exists for the call and is not `left`; the dismiss notice is the one
// exception (`leaving`). A private reply is not a chat message: `postPrivately` goes to one person's notifications.
import { createHash, randomBytes } from 'node:crypto';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';
import { config } from '../../config.js';
import { getUser } from '../../providers/identity.js';
import { callChatChannel, callChatRuntime } from '../call-chat.js';
import { notify } from '../social-notify.js';
import { postThreadMessage, updateThreadMessage } from '../social-chat.js';
import { assistantStore } from './store-select.js';
import { assistantLimits } from './limits.js';
import { nameTwins } from './detector.js';
import { onProposalChanged } from './proposals.js';
import type { Proposal } from './types.js';
import { policyCallOf, policyForLobby } from './policy.js';
import {
  APPROVED_QUESTION_KEY, ASSISTANT_NAME, ASSISTANT_USER_ID, DELETED_RECORD_LINE, LEGACY_DELETED_RECORD_LINES, isAssistantUserId,
  type ActionInput, type AssistantActionStatus, type AssistantMetadata, type ReplyInput,
} from './chat-types.js';

/** The call chat's own message store: the one the seat checks and history reads use. */
const chatStore = () => callChatRuntime().messages;

const messageId = (at: string): string => `${Date.parse(at).toString(36)}${randomBytes(6).toString('hex')}`;

/** A person's display name, never the raw id when a name exists. */
export async function nameOf(userId: string, fallback?: string): Promise<string> {
  if (fallback && fallback !== userId) return fallback;
  try { const u = await getUser(userId); if (u?.displayName) return u.displayName; } catch { /* fall through */ }
  return fallback || userId;
}

export interface PostOptions {
  /** The leave notice, and the "Milo left before it could finish" replies that follow it, are allowed once Milo has left. */
  leaving?: boolean;
  /** So is the minutes message after it (and the action cards that message offers): minutes.ts is the only caller. */
  minutes?: boolean;
  /** A fixed message id and time, for a message that must be found again without storing its id (a proposal card). */
  fixed?: { id: string; at: string };
}

/** Is Milo in this call (a record that has not left)? */
export async function assistantPresent(callId: string): Promise<boolean> {
  const record = await assistantStore().get(callId);
  return !!record && record.state !== 'left';
}

/**
 * Put one message into the call's chat as Milo. Returns the stored message, or null when the assistant is not
 * in the call (no record, or it left) and this is not the leave notice. No seat, no client.
 */
export async function postAsAssistant(callId: string, message: { text: string; metadata: AssistantMetadata }, opts: PostOptions = {}): Promise<ChatMessage | null> {
  const record = await assistantStore().get(callId);
  if (!record || (record.state === 'left' && !opts.leaving && !opts.minutes)) return null;
  const at = opts.fixed?.at ?? new Date().toISOString();
  const row: ChatMessage = {
    id: opts.fixed?.id ?? messageId(at), clientId: 'server:assistant', userId: ASSISTANT_USER_ID, channel: callChatChannel(callId),
    message: message.text, metadata: { ...message.metadata }, timestamp: at,
  };
  await postThreadMessage(row, chatStore());
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Notices. Plain sentences, no emoji. Names are display names.

export const noticeText = {
  joined: (inviterName: string, retentionDays: number = config.meetingAssistant.transcriptRetentionDays, minutes: number = Math.round(assistantLimits().maxSeconds / 60)): string =>
    `${ASSISTANT_NAME} joined at ${inviterName}'s invitation. Once you acknowledge, what you say is sent to the speech provider and kept as text for ${retentionDays} days. ` +
    `${ASSISTANT_NAME} writes minutes for the people in the call and leaves after ${minutes} minutes. ` +
    `Anyone here can pause ${ASSISTANT_NAME}, or dismiss it for everyone.`,
  /**
   * Milo was invited back into a call it had left: the same facts as `joined`, said again, because everyone acknowledges for the new
   * period. Said to everyone, so it never says "again" (some never acknowledged); it says the voice is off, since an invitation back
   * always turns it off, and "adds what it hears to the minutes", as the consent notice of a later period does.
   */
  rejoined: (inviterName: string, retentionDays: number = config.meetingAssistant.transcriptRetentionDays, minutes: number = Math.round(assistantLimits().maxSeconds / 60)): string =>
    `${ASSISTANT_NAME} is back in this call at ${inviterName}'s invitation and is listening again. Once you acknowledge, what you say is sent to the speech provider and kept as text for ${retentionDays} days. ` +
    `${ASSISTANT_NAME} adds what it hears to the minutes for the people in the call and leaves after ${minutes >= 1 ? `${minutes} minutes` : 'less than a minute'}. ` +
    `${ASSISTANT_NAME}'s voice is off until someone turns it on. Anyone here can pause ${ASSISTANT_NAME}, or dismiss it for everyone.`,
  /**
   * Added to the join and the rejoin notice: of the seated people's display names, those whose first name is a way Milo's name is
   * heard (detector.ts `nameTwins`), in one sentence; nothing when there is nobody. Leads with a space so it can be appended.
   */
  nameTwins: (seated: readonly string[]): string => {
    const names = nameTwins(seated);
    if (!names.length) return '';
    const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    const one = names.length === 1;
    return ` ${who} ${one ? 'is' : 'are'} also in this call. ${ASSISTANT_NAME} takes anything said to "${ASSISTANT_NAME}" as a request for itself, so call ${one ? 'them by their last name' : 'them by their last names'}.`;
  },
  paused: (name: string): string => `${name} paused ${ASSISTANT_NAME}. Nothing is being heard or stored.`,
  resumed: (name: string): string => `${name} resumed ${ASSISTANT_NAME}. ${ASSISTANT_NAME} is listening again.`,
  dismissed: (name: string, recordedNothing = false): string => `${name} dismissed ${ASSISTANT_NAME}.${recordedNothing ? ' Nothing was recorded, so there are no minutes.' : ''}`,
  voiceOn: (name: string): string => `${name} turned ${ASSISTANT_NAME}'s voice on. Each person can mute it for themselves.`,
  voiceOff: (name: string): string => `${name} turned ${ASSISTANT_NAME}'s voice off.`,
  nothingRecorded: `${ASSISTANT_NAME} left. Nothing was recorded, so there are no minutes.`,
};

export function postNotice(callId: string, text: string, opts: PostOptions = {}): Promise<ChatMessage | null> {
  return postAsAssistant(callId, { text, metadata: { assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-notice' } }, opts);
}

/** A notice that must never fail the route that caused it: the state change already happened. */
export async function postNoticeQuietly(callId: string, text: string, opts: PostOptions = {}): Promise<void> {
  try { await postNotice(callId, text, opts); } catch (error) { console.warn('[meeting-assistant] notice not posted', (error as Error).message); }
}

/**
 * A question an interview's lead approved for Milo to ask (interviews decision 9, contract E9): the approved words as a plain line of
 * Milo's, with no asker named, carrying the server's mark (APPROVED_QUESTION_KEY), the one kind of Milo's message the candidate reads.
 */
export function postApprovedQuestion(callId: string, text: string, opts: PostOptions = {}): Promise<ChatMessage | null> {
  return postAsAssistant(callId, { text, metadata: { assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-notice', [APPROVED_QUESTION_KEY]: true } }, opts);
}

// ---------------------------------------------------------------------------------------------------------------
// Replies and action cards.

/** An answer shown to everyone in the call, labelled with who asked (decision 6). */
export function postReply(callId: string, input: ReplyInput, opts: PostOptions = {}): Promise<ChatMessage | null> {
  return postAsAssistant(callId, {
    text: input.text,
    metadata: { assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-reply', askedBy: input.askedBy, askedByName: input.askedByName, private: false },
  }, opts);
}

export interface PostedAction { message: ChatMessage; created: boolean }

/**
 * Offer an action as a card. The store keeps who asked and the decision; the chat message carries the card. The same
 * `actionId` twice posts one card (the second call returns the first). Null when the assistant is not in the call.
 */
export async function postAction(callId: string, input: ActionInput, opts: PostOptions = {}): Promise<PostedAction | null> {
  const store = assistantStore();
  const prior = await store.getAction(callId, input.actionId);
  if (prior) {
    const store2 = chatStore();
    const existing = store2.getMessage ? await store2.getMessage(callChatChannel(callId), prior.messageId) : (await store2.listMessages(callChatChannel(callId), 20_000)).find((m) => m.id === prior.messageId) ?? null;
    return existing ? { message: existing, created: false } : null;
  }
  const status = input.status ?? 'waiting';
  const metadata: AssistantMetadata = {
    assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-action', actionId: input.actionId, askedBy: input.askedBy, askedByName: input.askedByName,
    summary: input.summary, ...(input.title ? { title: input.title } : {}), ...(input.does ? { does: input.does } : {}),
    ...(input.detail?.length ? { detail: input.detail } : {}), tool: input.tool, status,
    ...(input.resultText ? { resultText: input.resultText } : {}),
  };
  const message = await postAsAssistant(callId, { text: input.summary, metadata }, opts);
  if (!message) return null;
  const { created } = await store.createAction({
    callId, actionId: input.actionId, messageId: message.id, askedBy: input.askedBy, toolName: input.tool.name, argsDigest: input.tool.argsDigest,
    status, createdAt: Date.now(), decidedBy: null, decidedAt: null, resultText: input.resultText ?? null,
  });
  return { message, created };
}

export interface ActionMove { from: readonly AssistantActionStatus[]; to: AssistantActionStatus; by: string; at?: number; resultText?: string }

/**
 * Move an action's status and update THE SAME chat message (no new message per status). Null when the action is
 * unknown or not in one of `from` (two clicks decide once). The store is the authority; the message follows it.
 */
export async function moveAction(callId: string, actionId: string, move: ActionMove) {
  const store = assistantStore();
  const decided = await store.decideAction(callId, actionId, { from: move.from, to: move.to, by: move.by, at: move.at ?? Date.now(), ...(move.resultText !== undefined ? { resultText: move.resultText } : {}) });
  if (!decided) return null;
  await updateThreadMessage(callChatChannel(callId), decided.messageId,
    { metadata: { status: decided.status, ...(decided.resultText ? { resultText: decided.resultText } : {}) } }, chatStore());
  return decided;
}

// ---------------------------------------------------------------------------------------------------------------
// Proposal cards (docs/meeting-consent-design.md). One card per proposal, whatever created it, posted when the proposal is created
// and kept at the proposal's state afterwards (the same message, as an action card's status is). The card's id is derived from the
// proposal (its time and a digest of its id), so it is found again without storing a message id, and a repeat post is the same row.
// The text is the statement; nothing else from the proposal goes into the chat (names, answers and reasons come from the proposals
// route). The card has no buttons: answers are given in the deck.

export function proposalCardId(p: Pick<Proposal, 'id' | 'createdAt'>): string {
  return `${p.createdAt.toString(36)}${createHash('sha256').update(`proposal:${p.id}`).digest('hex').slice(0, 12)}`;
}

export async function postProposalCard(p: Proposal): Promise<ChatMessage | null> {
  return postAsAssistant(p.callId, {
    text: p.statement,
    metadata: { assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-proposal', proposalId: p.id, state: p.state },
  }, { fixed: { id: proposalCardId(p), at: new Date(p.createdAt).toISOString() } });
}

/** Bring the card to the proposal's state as stored now (read again, so two answers at once cannot leave an older state last). */
export async function updateProposalCard(p: Proposal): Promise<boolean> {
  const current = (await assistantStore().getProposal(p.callId, p.id)) ?? p;
  return !!(await updateThreadMessage(callChatChannel(p.callId), proposalCardId(current), { metadata: { state: current.state } }, chatStore()));
}

onProposalChanged(async (p, how) => {
  if (how === 'created') await postProposalCard(p);
  else await updateProposalCard(p);
});

// ---------------------------------------------------------------------------------------------------------------
// A private reply (decision 6: tools about one person's private standing answer only to the asker).
//
// Chosen path: the notifications `notify()` seam (lib/social-notify.ts), to this one user. It is per-user by
// construction, persisted in their inbox (so it survives a reload and a closed tab, which an ephemeral call-chat frame
// would not), and already reaches the bell and toast the portal shows. Nothing is written to the call chat's store.
export async function postPrivately(callId: string, userId: string, input: { text: string; title?: string }): Promise<boolean> {
  const record = await assistantStore().get(callId);
  if (!record || record.state === 'left') return false;
  if (!policyForLobby(record.lobby).rings(policyCallOf(record), userId)) return false; // the call's policy keeps this person's bell quiet
  const sent = await notify([userId], {
    type: 'assistant-private-reply', title: input.title ?? `${ASSISTANT_NAME} (only you can see this)`, body: input.text,
    payload: { tenant: record.tenant, kind: 'assistant-private-reply', callId, assistant: true },
  });
  return sent.includes(userId);
}

// ---------------------------------------------------------------------------------------------------------------
// Erasing Milo's words from a call's chat (audit M2, M3). Only messages authored by the assistant identity change; people's own
// messages are theirs. The text goes through `updateThreadMessage`, the same path a card's status change takes.

/** The most messages of one call chat an erase reads; the update itself is by message id and has no window. */
export const ERASE_SCAN_MAX = 20_000;

/**
 * After a record's delete (or its expiry) the call chat says so ONCE: one of Milo's messages stays as a plain notice with the fixed line
 * (no card, no status, no asker, no tool, no link to the page), and every other message Milo left is hidden with the chat's soft-delete
 * mark (`metadata.deleted`; the call chat's history read drops it), its text the same fixed line and every other key gone, so nothing of
 * the meeting's words or the cards' shape is left. People's messages are never touched. Safe to repeat: a second erase changes nothing.
 * Returns how many messages changed.
 */
export async function eraseAssistantMessages(callId: string): Promise<number> {
  const channel = callChatChannel(callId);
  const rows = await chatStore().listMessages(channel, ERASE_SCAN_MAX);
  if (rows.length >= ERASE_SCAN_MAX) console.warn(`[meeting-assistant] erase read the ${ERASE_SCAN_MAX} newest messages of a call chat; older ones were not looked at`);
  const mine = rows.filter((m) => isAssistantUserId(m.userId) && !m.deletedAt && m.metadata?.['deleted'] !== true);
  const KEPT: Record<string, unknown> = { assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-notice' };
  // A message erased before a rename reads the line and carries the name of its day: it is already erased, and stays as it is.
  const isKept = (m: ChatMessage): boolean => (m.message === DELETED_RECORD_LINE || LEGACY_DELETED_RECORD_LINES.includes(m.message))
    && Object.keys(m.metadata ?? {}).length === Object.keys(KEPT).length
    && Object.entries(KEPT).every(([k, v]) => (k === 'displayName' ? typeof m.metadata?.[k] === 'string' : m.metadata?.[k] === v));
  // The one that stays: a message already erased to the plain line (a repeat), else Milo's newest.
  const keep = mine.find(isKept) ?? mine[mine.length - 1];
  const without = (m: ChatMessage, extra: Record<string, unknown>): Record<string, unknown> =>
    ({ ...Object.fromEntries(Object.keys(m.metadata ?? {}).map((k) => [k, undefined])), ...extra });
  let changed = 0;
  for (const m of mine) {
    if (m === keep && isKept(m)) continue;
    const patch = m === keep
      ? { message: DELETED_RECORD_LINE, metadata: without(m, KEPT) }
      : { message: DELETED_RECORD_LINE, metadata: without(m, { deleted: true }) };
    if (await updateThreadMessage(channel, m.id, patch, chatStore())) changed += 1;
  }
  return changed;
}
