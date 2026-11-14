// Reports this browser's own media participant id to the call assistant (docs/meeting-assistant-audit.md, M7).
// The assistant's audio taps name media participants, not people; until a person's id is bound, their words are dropped
// as unknown. Only the caller's own id is ever sent: the local participant, whose user id is the session's and whose
// media id begins with `<user id>-`. Pure helpers here; the sending sits in MeetingTurnRunner.

export interface CallParticipantLike { userId: string; isLocal?: boolean; participantId?: string | null }

/** This person's media participant id in the call, or null (the mock walk has none, a call still connecting has none). */
export function ownMediaId(participants: readonly CallParticipantLike[] | undefined, userId: string | null): string | null {
  if (!userId || !participants) return null;
  const me = participants.find((p) => p.isLocal === true && p.userId === userId);
  const id = me?.participantId;
  return typeof id === 'string' && id.length > userId.length + 1 && id.startsWith(`${userId}-`) ? id : null;
}

const reported = new Set<string>();

/** Whether this id has already been taken by the server for this call (a 200, or a 409 that will not change). */
export const alreadyReported = (callId: string, id: string): boolean => reported.has(`${callId}\n${id}`);

/** POSTs the id once per call and id. A refusal that will not change (409: Nova left, id taken) counts as done; a failed request does not. */
export async function reportMediaId(callId: string, id: string, request: typeof fetch = fetch): Promise<boolean> {
  if (alreadyReported(callId, id)) return true;
  try {
    const res = await request(`/api/calls/${encodeURIComponent(callId)}/assistant/participant`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ participantId: id }),
    });
    if (res.ok || res.status === 409 || res.status === 403 || res.status === 404) { reported.add(`${callId}\n${id}`); return true; }
  } catch { /* offline: tried again */ }
  return false;
}
