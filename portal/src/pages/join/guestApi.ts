// The guest's calls (docs/interviews-tenant-plan.md row I2.3): the consents (C4) and the waiting room (C2), all
// under /api/interview-invite, on the guest cookie only. No Referer, nothing cached.
import type { Admission, ConsentChoices, GuestConsents } from './steps.ts';

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

/** C2. `refused` when the server will not take the knock (the answers no longer stand). */
export async function knock(): Promise<{ admission: Admission | null; refused: boolean }> {
  const res = await fetch(`${GUEST_API}/knock`, { ...INIT, method: 'POST' });
  if (res.status === 409) return { admission: null, refused: true };
  if (!res.ok) return { admission: null, refused: false };
  return { admission: ((await res.json()) as { admission: Admission }).admission, refused: false };
}
