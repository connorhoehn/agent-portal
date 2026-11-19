// The room's live hints: a content-free nudge on the interview's lobby name (`interviews:interview:<id>`), the same
// server-push activity path the work graph's hint uses (lib/gateway-run-feed.ts publishChannelActivity). It tells a
// page to read again NOW instead of waiting for its slow poll; the page's read still decides everything. Only the
// seats of that interview subscribe (lib/gateway/authority.ts), and nobody can publish there but the server.
import { publishChannelActivity } from '../gateway-run-feed.js';
import { interviewLobbyName, interviewOfLobby } from './lobby.js';

/** The candidate knocked: the lead's room reads who is waiting. */
export const INTERVIEW_HINT_KNOCK = 'interview.knock';
/** The lead ended the interview: the candidate's page reads the room. */
export const INTERVIEW_HINT_ENDED = 'interview.ended';

const EVENTS = { knock: INTERVIEW_HINT_KNOCK, ended: INTERVIEW_HINT_ENDED } as const;

/** Fire-and-forget safe: a hint that cannot go out leaves the polls to find the change. */
export async function publishInterviewHint(interviewId: string, kind: keyof typeof EVENTS): Promise<void> {
  const lobby = interviewLobbyName(interviewId);
  if (interviewOfLobby(lobby) !== interviewId) return;
  try { await publishChannelActivity(lobby, EVENTS[kind], { interviewId }); } catch { /* the poll covers it */ }
}
