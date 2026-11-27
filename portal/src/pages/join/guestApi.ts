// The guest's calls (docs/interviews-tenant-plan.md row I2.3): the consents (C4) and the waiting room (C2), all
// under /api/interview-invite, on the guest cookie only. No Referer, nothing cached.
import type { CaptionsRead } from './guestCaptionLines.ts';
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

/**
 * C2 with `told` (gap audit 2026-11-20 §4): the admission and whether the seats know the candidate is waiting (a bell
 * went out, or a seat is in the call). One boolean; the server says nothing about who. Null when there is no answer.
 */
export async function readWaiting(): Promise<{ admission: Admission; told: boolean } | null> {
  const res = await fetch(`${GUEST_API}/admission`, INIT);
  if (!res.ok) return null;
  const body = (await res.json()) as { admission?: Admission; told?: unknown };
  return body.admission ? { admission: body.admission, told: body.told === true } : null;
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
    const body = (await res.json()) as { admission?: Admission; told?: unknown };
    const admission = body.admission;
    if (!admission) return { kind: 'failed' };
    return typeof body.told === 'boolean' ? { kind: 'knocked', admission, told: body.told } : { kind: 'knocked', admission };
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

/** Gap audit 2026-11-20 §6: the longest note the candidate may send with "I can't make this time". */
export const CANT_MAKE_NOTE_MAX = 280;

export type CantMakeOutcome = { kind: 'told'; sentAt: string | null; message: string } | { kind: 'refused'; message: string } | { kind: 'dead' };

/** "I can't make this time": the recruiter is told; a repeat within the server's window answers the same. */
export async function sendCantMake(note: string): Promise<CantMakeOutcome> {
  try {
    const res = await fetch(`${GUEST_API}/cant-make`, {
      ...INIT, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(note.trim() ? { note } : {}),
    });
    if (res.status === 404) return { kind: 'dead' };
    const body = (await res.json().catch(() => ({}))) as { cantMake?: { sentAt?: string | null }; message?: string; error?: string };
    if (res.ok) return { kind: 'told', sentAt: body.cantMake?.sentAt ?? null, message: body.message ?? 'The recruiter has been told. They will be in touch.' };
    return { kind: 'refused', message: body.error ?? 'That did not go through. Try again in a moment.' };
  } catch {
    return { kind: 'refused', message: 'That did not go through. Check your connection and try again.' };
  }
}

/**
 * The candidate's own live captions after `after` (gap audit 2026-11-20 §11). Null for not-found (not offered, not live, not let
 * in, the transcript declined, a dead link: the room's own read tells those apart) and for a failed read.
 */
export async function readCaptions(after: number): Promise<CaptionsRead | null> {
  const res = await fetch(`${GUEST_API}/captions?after=${Math.max(0, Math.floor(after))}`, INIT).catch(() => null);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as { captions?: CaptionsRead } | null;
  return body?.captions ?? null;
}
