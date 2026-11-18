// The guest's calls (docs/interviews-tenant-plan.md row I2.3): the consents (C4) and the waiting room (C2), all
// under /api/interview-invite, on the guest cookie only. No Referer, nothing cached.
import type { Admission, ConsentChoices, GuestConsents, GuestRoom, KnockOutcome, RoomRead } from './steps.ts';

export const GUEST_API = '/api/interview-invite';
const INIT: RequestInit = { credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' };

/** A dead link answers not-found on every guest route. */
export class LinkDead extends Error {}

export async function readConsents(): Promise<GuestConsents> {
  const res = await fetch(`${GUEST_API}/consents`, INIT);
  if (res.status === 404) throw new LinkDead();
  if (!res.ok) throw new Error('consents');
  return (await res.json()) as GuestConsents;
}

export type SaveResult =
  | { kind: 'saved'; consents: GuestConsents }
  /** The notice changed, the call started, or another window saved first: the server's current view and why. */
  | { kind: 'refused'; consents: GuestConsents; message: string }
  | { kind: 'failed'; message: string };

export async function saveConsents(noticeVersion: string, answers: ConsentChoices): Promise<SaveResult> {
  const res = await fetch(`${GUEST_API}/consents`, {
    ...INIT, method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ noticeVersion, ...answers }),
  });
  if (res.status === 404) throw new LinkDead();
  const body = (await res.json().catch(() => ({}))) as Partial<GuestConsents> & { error?: string };
  if (res.ok) return { kind: 'saved', consents: body as GuestConsents };
  if (res.status === 409 && body.notice) return { kind: 'refused', consents: body as GuestConsents, message: body.error ?? '' };
  return { kind: 'failed', message: body.error ?? 'Your answers could not be saved just now. Try again.' };
}

/** C2. A route that is not there (not-found) reads as no admission: still waiting, never an error. */
export async function readAdmission(): Promise<Admission | null> {
  const res = await fetch(`${GUEST_API}/admission`, INIT);
  if (!res.ok) return null;
  return ((await res.json()) as { admission: Admission }).admission;
}

/** C2. A 409 is `held` when the server says a required part was declined, else `refused`; not-found is a dead link. */
export async function knock(): Promise<KnockOutcome> {
  try {
    const res = await fetch(`${GUEST_API}/knock`, { ...INIT, method: 'POST' });
    if (res.status === 404) return { kind: 'dead' };
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string };
      return body.reason === 'declined-required' ? { kind: 'held' } : { kind: 'refused' };
    }
    if (!res.ok) return { kind: 'failed' };
    const admission = ((await res.json()) as { admission?: Admission }).admission;
    return admission ? { kind: 'knocked', admission } : { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

/** D1. The room while the lead has let the guest in (or `ended` after); not-found otherwise. */
export async function readRoom(): Promise<RoomRead> {
  try {
    const res = await fetch(`${GUEST_API}/room`, INIT);
    if (res.status === 404) return { kind: 'gone' };
    if (!res.ok) return { kind: 'failed' };
    return { kind: 'room', room: ((await res.json()) as { room: GuestRoom }).room };
  } catch {
    return { kind: 'failed' };
  }
}
