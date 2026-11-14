// Shapes shared by the meeting assistant's store, intake and detector
// (docs/meeting-assistant-design.md). Words are stored, audio never is.

/** invited -> listening <-> paused -> left. `left` is final. */
export type AssistantState = 'invited' | 'listening' | 'paused' | 'left';

/** One finished caption, attributed to a person. `seq` is the call's own line counter, from 1. */
export interface TranscriptLine {
  callId: string;
  seq: number;
  /** The person heard; null when nobody's audio was voiced for the piece (unattributed: never used for the name lock). */
  userId: string | null;
  /** The media server's per-join participant id; the person is `userId`. */
  participantId: string;
  speakerName: string;
  text: string;
  /** Epoch milliseconds the caption ended (or arrived, when the source gave no time). */
  at: number;
  captionId: string;
  /** Offsets in ms within the call session, when the source knows them. */
  startMs?: number;
  endMs?: number;
  /** Everyone heard in this line when speech overlapped; `userId` is the primary speaker. Absent: just `userId`. */
  speakers?: string[];
}

/** A request the detector found, waiting for the brain (package 4). */
export interface PendingRequest {
  id: string;
  askedBy: string;
  text: string;
  lines: number[];
  startedAt: number;
  endedAt: number;
}

export interface AssistantRecord {
  callId: string;
  tenant: string;
  /** The call's lobby name, from the call store (e.g. `orgiq:initiative:p-auth`). */
  lobby: string;
  /** Set when the lobby is an initiative page. */
  initiativeId: string | null;
  state: AssistantState;
  invitedBy: string;
  invitedAt: number;
  pausedBy: string | null;
  leftAt: number | null;
  leftBy: string | null;
  /** People who have acknowledged the transcription notice (the inviter does by inviting). */
  acked: string[];
  /** Everyone who held a seat while the assistant was in the call; the transcript is theirs. */
  attendees: string[];
  /** Seat holders at the moment of the invite: the people who still owe an ack. */
  presentAtInvite: string[];
  requests: number;
  linesStored: number;
  /** The next transcript line number. */
  nextSeq: number;
  pendingRequests: PendingRequest[];
  /** Nova speaks aloud in this call (package 7a). Off by default; a record written before it reads as off. */
  voice?: boolean;
  /** The live session's bookkeeping (package 4a); absent on a record written before it, read as the defaults. */
  session?: AssistantSession;
}

/** What the live session and its money need to survive a restart; one JSONB column. Reads fill any missing field. */
export interface AssistantSession {
  /** Tool calls the server refused (no asker, name not said, not allowed for the asker). */
  refusedCalls: number;
  /** Listening seconds in finished listening periods; the open one is `listeningSince`. */
  listeningSeconds: number;
  /** Listening seconds of earlier settled periods of this call (a restart settled them and a resume started again); the ceiling counts them. */
  settledListeningSeconds: number;
  /** Epoch ms the current listening period began; null while paused, invited or left. */
  listeningSince: number | null;
  /** Listening time allowed for this call, extended by `extend`. */
  ceilingSeconds: number;
  /** The five-minute warning went out for the current ceiling. */
  warned: boolean;
  /** The request cap notice went out. */
  limitNoticed: boolean;
  /** Sessions started after the first because one closed unexpectedly or Nova resumed. */
  replacements: number;
  /** Spend hold ids of the extensions (the invite's own hold is settled by the ledger row and needs no id here). */
  holds: string[];
  /** How many times the ceiling was extended; names the next extension's hold. */
  extensions: number;
  /** Provider seconds and backend tokens from finished sessions, for the settlement. */
  usageSeconds: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** The ledger has been written. */
  settled: boolean;
  /** SHA-256 (base64url) of the live audio sink token while one is valid; null when dead. The plain token is never stored. */
  sinkTokenHash?: string | null;
  /** The last moment this process was known to be alive while the call listened (the orchestrator's tick, at most every 30 s); the boot reconcile closes an open listening period here (audit M5). */
  lastAliveAt?: number;
  /** The media channel the call's tap was armed on, so a later boot can delete a tap that outlived the process. Empty once deleted. */
  channelArn?: string;
  /** Which ledger part the current settlement books under: 0 for the invite's own hold, then the part of the fresh hold a resume after a settlement reserved. */
  ledgerPart?: number;
  /** Which kind of session ran, persisted so a settlement after a restart prices the figures the way the live one would. */
  sessionKind?: 'openai' | 'scripted';
  /** Media participant ids people bound to themselves (id -> user id). */
  participants?: Record<string, string>;
  /** Audio chunks dropped because their participant id is bound to nobody, or their person had not acknowledged, or arrived late. */
  unmappedChunks?: number;
  unackedChunks?: number;
  lateChunks?: number;
}

export const newAssistantSession = (ceilingSeconds: number): AssistantSession => ({
  refusedCalls: 0, listeningSeconds: 0, settledListeningSeconds: 0, listeningSince: null, ceilingSeconds, warned: false, limitNoticed: false, replacements: 0,
  holds: [], extensions: 0, usageSeconds: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, settled: false,
  sinkTokenHash: null, participants: {}, unmappedChunks: 0, unackedChunks: 0, lateChunks: 0,
});

/** The record's session bookkeeping with defaults for anything missing. */
export const sessionOf = (record: Pick<AssistantRecord, 'session'>, fallbackCeilingSeconds = 3600): AssistantSession =>
  ({ ...newAssistantSession(fallbackCeilingSeconds), ...(record.session ?? {}) });

export type TurnKind = 'read' | 'write' | 'private-read';
export type TurnStatus = 'pending' | 'running' | 'done' | 'failed' | 'declined' | 'expired';

/**
 * One tool call that became work for the asker's browser. A read waits in `pending` until the asker's browser posts
 * its result. A write waits in `pending` behind its card and becomes `running` only when the asker confirms; the
 * browser runs only `pending` reads and `running` writes.
 */
export interface AssistantTurn {
  turnId: string;
  callId: string;
  askedBy: string;
  tool: { name: string; args: unknown };
  kind: TurnKind;
  status: TurnStatus;
  actionId?: string;
  createdAt: number;
  expiresAt: number;
  /** Set when one of the asker's browsers claimed the turn to run it (audit B6); a claimed turn is not listed again and takes its result only with this id. */
  claimId?: string;
  claimedAt?: number;
}

/** What a transcript source hands the intake. `userId` is already a person; `participantId` may be empty. */
export interface RawLine {
  /** The person; null for a piece nobody's audio was voiced for. */
  userId: string | null;
  text: string;
  at?: number;
  captionId?: string;
  participantId?: string;
  speakerName?: string;
  startMs?: number;
  endMs?: number;
  speakers?: string[];
}

/** An action Nova offered in the call chat (package 2 records the decision; running the tool is package 4). */
export interface AssistantAction {
  callId: string;
  actionId: string;
  /** The chat message that carries the card; status changes update that message. */
  messageId: string;
  askedBy: string;
  toolName: string;
  argsDigest: string;
  status: 'waiting' | 'confirmed' | 'declined' | 'expired' | 'done' | 'failed';
  createdAt: number;
  /** Who moved it out of `waiting`, and when (the asker, for confirm and decline). */
  decidedBy: string | null;
  decidedAt: number | null;
  resultText: string | null;
}

/** An action item in the minutes. The owner is set only when the SERVER matched a roster display name exactly. */
export interface MinutesActionItem {
  text: string;
  ownerUserId?: string;
  ownerName?: string;
  /** Already done in the call (a write the owner confirmed and ran), so nothing is offered for it. */
  done?: boolean;
}

/** Who wrote the minutes: the scripted rules (mock world), the provider's text model, or nobody (transcript only). */
export type MinutesWriterKind = 'scripted' | 'openai' | 'none';

/**
 * The notes left behind when the assistant leaves (package 5). One per call. `deleted` marks a tombstone: the inviter
 * deleted the record, its content is gone, and the call is never summarised again. Same retention as transcript lines.
 */
export interface MinutesRecord {
  callId: string;
  tenant: string;
  lobby: string;
  initiativeId: string | null;
  callName: string;
  startedAt: number;
  endedAt: number;
  invitedBy: string;
  attendees: string[];
  summary: string;
  decisions: string[];
  actionItems: MinutesActionItem[];
  topics: string[];
  lineCount: number;
  /** The writer saw only part of the transcript (said plainly in the summary too). */
  truncated: boolean;
  writer: MinutesWriterKind;
  createdAt: number;
  deleted?: { at: number; by: string };
}
