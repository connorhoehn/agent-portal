// The candidate's own media participant id, told to the server so Milo and the transcript hear the candidate (the meeting
// assistant's taps name media participants, not people; an unbound id's audio is dropped). The server derives who the id
// belongs to from the guest's own session and checks the id is that session's own (routes/interview-invite-media.ts); this
// side only finds the local participant's id and sends it. Sent again now and then while the candidate is in the call, so a
// binding dropped when Milo left is made again when Milo is invited back (the server answers the same for a repeat).
import { useEffect } from 'react';
import { ownMediaId, type CallParticipantLike } from '../../lib/meetingParticipant.ts';
import { GUEST_API } from './guestApi.ts';

/** How often the id is sent again while the candidate is in the call. */
export const GUEST_MEDIA_REPEAT_MS = 30_000;

/** What became of one report: keep sending (`again`), or stop (`stop`: refused, or the candidate declined the transcript). */
export type GuestMediaReport = 'again' | 'stop';

export async function reportGuestMediaId(callId: string, participantId: string, request: typeof fetch = fetch): Promise<GuestMediaReport> {
  try {
    const res = await request(`${GUEST_API}/media/participant`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, participantId }),
    });
    if (res.status === 404 || res.status === 409) return 'stop';
    if (!res.ok) return 'again';
    const body = await res.json().catch(() => null) as { bound?: boolean } | null;
    return body?.bound === false ? 'stop' : 'again';
  } catch { return 'again'; }
}

/** While joined: send this browser's own media id, then again every GUEST_MEDIA_REPEAT_MS until the server says stop. */
export function useGuestMediaBinding(callId: string | null, userId: string, participants: readonly CallParticipantLike[] | undefined): void {
  const mediaId = callId ? ownMediaId(participants, userId) : null;
  useEffect(() => {
    if (!callId || !mediaId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const send = (): void => {
      void reportGuestMediaId(callId, mediaId).then((out) => { if (!stopped && out === 'again') timer = setTimeout(send, GUEST_MEDIA_REPEAT_MS); });
    };
    send();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [callId, mediaId]);
}
