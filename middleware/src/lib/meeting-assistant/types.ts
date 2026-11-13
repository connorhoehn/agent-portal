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
  /** The live session's bookkeeping (package 4a); absent on a record written before it, read as the defaults. */
  session?: AssistantSession;
}

/** What the live session and its money need to survive a restart; one JSONB column. Reads fill any missing field. */
export interface AssistantSession {
  /** Tool calls the server refused (no asker, name not said, not allowed for the asker). */
  refusedCalls: number;
  /** Listening seconds in finished listening periods; the open one is `listeningSince`. */
  listeningSeconds: number;
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
}

export const newAssistantSession = (ceilingSeconds: number): AssistantSession => ({
  refusedCalls: 0, listeningSeconds: 0, listeningSince: null, ceilingSeconds, warned: false, limitNoticed: false, replacements: 0,
  holds: [], extensions: 0, usageSeconds: 0, tokensIn: 0, tokensOut: 0, tokensCached: 0, settled: false,
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
