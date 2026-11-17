// What the meeting assistant puts in the call chat (docs/meeting-assistant-design.md, decisions 4 to 6). One file, shared by the
// server's posting (chat.ts), the render gate in lib/call-chat.ts and the tests. The portal keeps a mirror of the
// metadata shapes in portal/src/lib/assistantMessages.ts; change both together.
//
// The identity is fixed. A message is the assistant's only if it was stored by chat.ts: `userId` is ASSISTANT_USER_ID (or, for
// a message stored before the rename, a LEGACY_ASSISTANT_USER_IDS entry), and `metadata.assistant === true` with `metadata.kind`
// starting `assistant-`. No signed-in client can produce one: the huddle send path (call-chat-send.ts) refuses the author and the
// keys, and `render` (call-chat.ts) shows the assistant keys only on a message whose stored author is the assistant.

/** The assistant's name, the one place it is spelled: every sentence the server builds for a person or tells the model uses it. */
export const ASSISTANT_NAME = 'Milo' as const;
/** The assistant's fixed author id in the call chat. Neutral, so a rename never touches stored data. */
export const ASSISTANT_USER_ID = 'agent:meeting-assistant';
/**
 * Author ids the assistant's messages were stored under before, under its earlier name. Read, never written: a stored message
 * keeps its author, and the render gate, the erase and the send refusal treat it as the assistant's.
 */
export const LEGACY_ASSISTANT_USER_IDS: readonly string[] = ['agent:nova'];
/** Is this stored author the assistant (under its id now, or one it was stored under before)? */
export const isAssistantUserId = (userId: string | null | undefined): boolean =>
  userId === ASSISTANT_USER_ID || (!!userId && LEGACY_ASSISTANT_USER_IDS.includes(userId));
/** What the assistant's own chat messages say once their call's record is deleted (by the inviter, or by retention). */
export const DELETED_RECORD_LINE = `This record was deleted by the person who invited ${ASSISTANT_NAME}.`;
/** The same line as messages erased before the rename read it; an erase treats such a message as already erased. */
export const LEGACY_DELETED_RECORD_LINES: readonly string[] = ['This record was deleted by the person who invited Nova.'];
export const ASSISTANT_KIND_PREFIX = 'assistant-';

export type AssistantKind = 'assistant-notice' | 'assistant-reply' | 'assistant-action' | 'assistant-proposal';
export const ASSISTANT_KINDS: readonly AssistantKind[] = ['assistant-notice', 'assistant-reply', 'assistant-action', 'assistant-proposal'];

export type AssistantActionStatus = 'waiting' | 'confirmed' | 'declined' | 'expired' | 'done' | 'failed';
export const ACTION_STATUSES: readonly AssistantActionStatus[] = ['waiting', 'confirmed', 'declined', 'expired', 'done', 'failed'];

/**
 * Fields every assistant message carries. `displayName` is the name it was posted under: ASSISTANT_NAME now, and a message stored
 * before a rename keeps the name it was written with.
 */
export interface AssistantBase { assistant: true; displayName: string }

/**
 * The server's mark on a question an interview's lead approved for Milo to ask ("Have Milo ask", interviews decision 9). Set only by
 * chat.ts `postApprovedQuestion`; a person's send that carries it is refused (claimsAssistant). In an interview call it is the one
 * kind of Milo's message a guest reads (lib/call-chat.ts `guestMaySee`, interviews contract E9).
 */
export const APPROVED_QUESTION_KEY = 'approvedQuestion' as const;

export interface AssistantNoticeMetadata extends AssistantBase {
  kind: 'assistant-notice';
  /** An approved question (APPROVED_QUESTION_KEY): posted as a plain line of Milo's, with no asker. */
  approvedQuestion?: true;
  /** The closing notice names the meeting it is about; the portal links to that meeting's page from it. */
  meetingCallId?: string;
  /** The minutes notice only: what the minutes hold, so the chat draws them as a card. The text is the summary's first sentences. */
  minutes?: MinutesCounts;
}

/** The counts a minutes notice carries. `decisions` includes the decisions people consented to through the call's proposals. */
export interface MinutesCounts { decisions: number; actionItems: number; proposals: number; /** The assistant added a later period to minutes that existed. */ added?: boolean }

export interface AssistantReplyMetadata extends AssistantBase {
  kind: 'assistant-reply';
  askedBy: string;
  askedByName: string;
  /** Always false in a chat message; a private reply is never a chat message (postPrivately). */
  private?: false;
}

export interface AssistantActionMetadata extends AssistantBase {
  kind: 'assistant-action';
  actionId: string;
  askedBy: string;
  askedByName: string;
  summary: string;
  /** The record's own name, the card's headline ("the login cookie bug"); absent when the write names none (then the summary is). */
  title?: string;
  /** What confirming does, in plain words ("Creates a work item"); the card adds where it lands. No tool names, ids or `key: value`. */
  does?: string;
  detail?: string[];
  tool: { name: string; argsDigest: string };
  status: AssistantActionStatus;
  resultText?: string;
}

/** States a proposal card shows; the same names as the proposal record's (types.ts ProposalState). */
export type AssistantProposalState = 'open' | 'consented' | 'running' | 'done' | 'failed' | 'objected' | 'dismissed' | 'expired';
export const PROPOSAL_CARD_STATES: readonly AssistantProposalState[] = ['open', 'consented', 'running', 'done', 'failed', 'objected', 'dismissed', 'expired'];

/**
 * A proposal card (docs/meeting-consent-design.md). It carries the proposal's id and state only: the statement is the message text,
 * and names, answers and reasons are read from the proposals route by people allowed to see them. It has no buttons; answers are
 * given in the deck. Deleting the record blanks the text like any other assistant message, and the proposals go with the record.
 */
export interface AssistantProposalMetadata extends AssistantBase {
  kind: 'assistant-proposal';
  proposalId: string;
  state: AssistantProposalState;
}

export type AssistantMetadata = AssistantNoticeMetadata | AssistantReplyMetadata | AssistantActionMetadata | AssistantProposalMetadata;

/** What the caller supplies for each kind; chat.ts adds `assistant`, `displayName` and `kind`. */
export type ReplyInput = { text: string; askedBy: string; askedByName: string };
export type ActionInput = Omit<AssistantActionMetadata, keyof AssistantBase | 'kind' | 'status'> & { status?: AssistantActionStatus };

export const isAssistantKind = (kind: unknown): boolean => typeof kind === 'string' && kind.startsWith(ASSISTANT_KIND_PREFIX);

/** Does a metadata bag carry anything only the assistant may carry? Used to refuse a person's send. */
export function claimsAssistant(metadata: Record<string, unknown> | undefined | null): boolean {
  if (!metadata) return false;
  return 'assistant' in metadata || APPROVED_QUESTION_KEY in metadata || isAssistantKind(metadata['kind']);
}

const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;

function minutesCounts(raw: unknown): MinutesCounts | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  return count(c['decisions']) && count(c['actionItems']) && count(c['proposals'])
    ? { decisions: c['decisions'], actionItems: c['actionItems'], proposals: c['proposals'], ...(c['added'] === true ? { added: true } : {}) } : null;
}

/** Parse stored metadata back into a typed shape; null when it is not a well-formed assistant message. */
export function parseAssistantMetadata(raw: unknown): AssistantMetadata | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m['assistant'] !== true) return null;
  // The name the message was posted under stays (a message stored before a rename keeps its old name); a message without one reads as
  // the assistant's name now.
  const base = { assistant: true as const, displayName: str(m['displayName'], 64) ? m['displayName'] : ASSISTANT_NAME };
  if (m['kind'] === 'assistant-notice') {
    const minutes = minutesCounts(m['minutes']);
    return { ...base, kind: 'assistant-notice', ...(str(m['meetingCallId'], 200) ? { meetingCallId: m['meetingCallId'] } : {}), ...(minutes ? { minutes } : {}),
      ...(m[APPROVED_QUESTION_KEY] === true ? { approvedQuestion: true as const } : {}) };
  }
  if (m['kind'] === 'assistant-reply') {
    if (!str(m['askedBy'], 128) || !str(m['askedByName'], 128)) return null;
    return { ...base, kind: 'assistant-reply', askedBy: m['askedBy'], askedByName: m['askedByName'], ...(m['private'] === false ? { private: false as const } : {}) };
  }
  if (m['kind'] === 'assistant-action') {
    const tool = m['tool'] as Record<string, unknown> | undefined;
    if (!str(m['actionId'], 128) || !str(m['askedBy'], 128) || !str(m['askedByName'], 128) || !str(m['summary'], 500)
      || !tool || !str(tool['name'], 128) || typeof tool['argsDigest'] !== 'string' || !ACTION_STATUSES.includes(m['status'] as AssistantActionStatus)) return null;
    const detail = Array.isArray(m['detail']) && m['detail'].every((x) => typeof x === 'string') ? (m['detail'] as string[]) : undefined;
    return { ...base, kind: 'assistant-action', actionId: m['actionId'], askedBy: m['askedBy'], askedByName: m['askedByName'], summary: m['summary'],
      ...(str(m['title'], 200) ? { title: m['title'] } : {}), ...(str(m['does'], 300) ? { does: m['does'] } : {}),
      ...(detail ? { detail } : {}), tool: { name: tool['name'], argsDigest: tool['argsDigest'] }, status: m['status'] as AssistantActionStatus,
      ...(typeof m['resultText'] === 'string' ? { resultText: m['resultText'] } : {}) };
  }
  if (m['kind'] === 'assistant-proposal') {
    if (!str(m['proposalId'], 128) || !PROPOSAL_CARD_STATES.includes(m['state'] as AssistantProposalState)) return null;
    return { ...base, kind: 'assistant-proposal', proposalId: m['proposalId'], state: m['state'] as AssistantProposalState };
  }
  return null;
}
