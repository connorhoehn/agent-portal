// Shapes shared by the meeting assistant's store, intake and detector
// (docs/meeting-assistant-design.md). Words are stored, audio never is.

/** invited -> listening <-> paused -> left. `left` is final. */
export type AssistantState = 'invited' | 'listening' | 'paused' | 'left';

/** One finished caption, attributed to a person. `seq` is the call's own line counter, from 1. */
export interface TranscriptLine {
  callId: string;
  seq: number;
  userId: string;
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
}

/** What a transcript source hands the intake. `userId` is already a person; `participantId` may be empty. */
export interface RawLine {
  userId: string;
  text: string;
  at?: number;
  captionId?: string;
  participantId?: string;
  speakerName?: string;
  startMs?: number;
  endMs?: number;
  speakers?: string[];
}
