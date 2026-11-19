// A candidate's guest identity in an interview call (invite/realtime.ts `guestSubject`: `guest:<inviteId>`): the one check.
const GUEST = /^guest:(.+)$/;

/** Is this user id a candidate's guest identity? */
export const isGuestId = (userId: string): boolean => GUEST.test(userId);

/** The invite a guest id was minted from belongs to this interview (a guest's seat is checked by the gateway; this is the second look). */
export async function guestOfInterview(userId: string, interviewId: string): Promise<boolean> {
  const inviteId = GUEST.exec(userId)?.[1];
  if (!inviteId) return false;
  const { inviteStore } = await import('./invite/store.js');
  const invite = await inviteStore().getInvite(inviteId).catch(() => null);
  return invite?.interviewId === interviewId;
}
