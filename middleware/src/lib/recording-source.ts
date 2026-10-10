// The recording source for `/summarize --recording <id>` and
// `/deck --from recording:<id>` (docs/agentic-flows-migration.md slice 7).
//
// Authority, asked fresh on every call and never cached:
//   1. the caller already passed `chatAccess(channel)` (grants + membership);
//   2. `recordingTranscript` applies the proxy's rule: a `social:` lobby, and a
//      recording the caller was on (upstream `requireOwnRecording`, a 404);
//   3. here: the recording belongs to THIS conversation. A room's call has no
//      chat to carry a card, and a DM call's transcript must never be written
//      into a different audience, so any other pairing is the same 404 as an
//      unknown id.

import type { Request } from 'express';
import type { Session } from './session.js';
import { getUser } from '../providers/identity.js';
import { AppError, NotFoundError, ValidationError } from './async-handler.js';
import type { TranscriptLine } from './conversation-summarize.js';
import { recordingTranscriptLines } from './recording-transcript.js';
import { recordingTranscript } from '../providers/social-platform.js';

export const RECORDING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function recordingIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || !RECORDING_ID.test(raw)) throw new ValidationError('That is not a recording id');
  return raw;
}

/**
 * The caller as platform-api must see them. /api/chat accepts a cookie session OR the realtime
 * bearer (chat-pins `socialSubject`); a bearer carries no session, so one is rebuilt from the
 * authoritative directory row, never from the request.
 */
async function callerSession(req: Request, userId: string): Promise<Session> {
  if (req.session && req.session.sub === userId) return req.session as Session;
  const user = await getUser(userId, { authoritative: true });
  const role = user?.grants.social?.[0];
  if (!user || !role) throw new AppError(403, 'Forbidden');
  return { sub: userId, name: user.displayName, role, tenant: 'social', grants: user.grants, iat: 0 } as unknown as Session;
}

/** A room's call lobby (`social:room:<slug>`): no chat, so its summary card lives in the Recordings pane. */
export const ROOM_LOBBY = /^social:room:[a-z0-9][a-z0-9-]{0,63}$/;

/** The speech lines of one recording the caller may read in `channel` (a DM), or in the room lobby `channel` when it is one. */
export async function readRecordingLines(req: Request, userId: string, channel: string, recordingId: string): Promise<TranscriptLine[]> {
  const transcript = await recordingTranscript(await callerSession(req, userId), recordingId);
  // The caller's participation was asked by recordingTranscript; here the recording must be of THIS conversation or room lobby.
  if (ROOM_LOBBY.test(channel) ? transcript.lobbyName !== channel : transcript.conversation !== channel) {
    throw new NotFoundError(`no recording ${recordingId} in this conversation`);
  }
  if (transcript.status !== 'ready' || !('segments' in transcript)) {
    const terminal = 'terminal' in transcript && transcript.terminal;
    throw new AppError(terminal ? 422 : 409, terminal ? 'This recording has no transcript to use.' : 'The transcript is not ready yet. Try again in a minute.');
  }
  const lines = recordingTranscriptLines(recordingId, transcript.startedAt, transcript.segments);
  if (lines.length === 0) throw new AppError(422, 'This recording has no spoken words to use.');
  return lines;
}

/** Asked on every status/post of a room-recording run: the caller is (still) a participant of that recording's call. */
export async function assertRecordingParticipant(req: Request, userId: string, lobby: string, recordingId: string): Promise<void> {
  const transcript = await recordingTranscript(await callerSession(req, userId), recordingId);
  if (transcript.lobbyName !== lobby) throw new NotFoundError('run not found');
}
