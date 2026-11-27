// The time on a round and the candidate's invite link, on the portal side (docs/interviews-tenant-plan.md row I1.5
// and the invite lane): the writes the Upcoming page makes. The server checks everything (middleware
// lib/interviews/assign.ts checkTime) and answers its problem in one sentence on `scheduledAt`.

import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';
import type { SeatConflict } from './interviewsAssign.ts';

export type InviteState = 'none' | 'live' | 'revoked' | 'expired' | 'closed' | 'other-interview';
export interface InviteStatus {
  state: InviteState;
  issuedAt: string | null;
  issuedBy: { id: string; name: string } | null;
  expiresAt: string | null;
  revokedAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
}

/** A saved time answers the seats already booked elsewhere then (ledger row C-17): a warning, the time is saved all the same. */
export type TimeOutcome = { ok: true; conflicts: SeatConflict[] } | { ok: false; error: string; stale: boolean };

/** Set (an ISO instant) or clear (`null`) a round's time against the revision the page loaded. */
export async function setRoundTime(id: string, revision: number, scheduledAt: string | null): Promise<TimeOutcome> {
  const r = await writeJson<{ fields?: Array<{ message: string }>; conflicts?: SeatConflict[] }>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/time`, 'PUT', { revision, scheduledAt });
  if (r.ok) return { ok: true, conflicts: r.data?.conflicts ?? [] };
  return { ok: false, error: r.data?.fields?.[0]?.message ?? r.error ?? 'The time could not be saved. Try again.', stale: r.status === 409 };
}

const invitePath = (id: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/invite`;

export type IssueOutcome = { ok: true; link: string; invite: InviteStatus } | { ok: false; error: string };

/** Make a link. The answer is the only time the link is shown. */
export async function issueInvite(id: string): Promise<IssueOutcome> {
  const r = await writeJson<{ link?: string; invite?: InviteStatus }>(invitePath(id), 'POST', {});
  if (r.ok && r.data?.link && r.data.invite) return { ok: true, link: r.data.link, invite: r.data.invite };
  return { ok: false, error: r.error ?? 'The link could not be made. Try again.' };
}

export async function revokeInvite(id: string): Promise<{ ok: true; invite: InviteStatus } | { ok: false; error: string }> {
  const r = await writeJson<{ invite?: InviteStatus }>(invitePath(id), 'DELETE');
  return r.ok && r.data?.invite ? { ok: true, invite: r.data.invite } : { ok: false, error: r.error ?? 'The link could not be revoked. Try again.' };
}

/**
 * The lead's control in the room for the candidate's link (the server lets the round's lead make it for their own round):
 * copy the link made in this tab, or make one. A live link made earlier cannot be copied (only its hash is kept), so the
 * lead makes a new one, which stops the old one working. A closed round, or a status not read yet, shows nothing.
 */
export type RoomLinkControl = { kind: 'copy' } | { kind: 'make'; label: string; hint: string };
export function roomLinkControl(status: InviteStatus | null, held: boolean): RoomLinkControl | null {
  if (held) return { kind: 'copy' };
  if (!status || status.state === 'closed') return null;
  if (status.state === 'live') {
    return { kind: 'make', label: 'Make a new candidate link', hint: 'The link made earlier is shown only once. A new link stops the old one working.' };
  }
  return { kind: 'make', label: 'Make candidate link', hint: 'The candidate joins from this link. It is shown once, so copy it when it is made.' };
}

/** The link's status in a sentence: made, opened, expires. */
export function inviteLine(s: InviteStatus, when: (iso: string) => string): string {
  switch (s.state) {
    case 'none': return 'No link yet';
    case 'revoked': return 'Revoked';
    case 'expired': return 'Expired';
    case 'closed': return 'Round closed';
    case 'other-interview': return 'Replaced';
    default: {
      const sent = s.issuedAt ? `Made ${when(s.issuedAt)}` : 'Made';
      const opened = s.openCount > 0 && s.lastOpenedAt ? `opened ${s.openCount === 1 ? 'once' : `${s.openCount} times`}` : 'not opened yet';
      return `${sent}, ${opened}${s.expiresAt ? `, expires ${when(s.expiresAt)}` : ''}`;
    }
  }
}

// ── The Consent column (row I2.5): what each round runs without, for the recruiter ───────────────────────────────────────
// Read from GET /consent-effects (the recruiter and the admin only). Plain words, never the candidate's reasons: the
// recruiter is told so they can arrange what replaces a part.

export type ConsentEffectPart = 'recording' | 'transcription' | 'milo';
export interface ConsentEffect { interviewId: string; answered: boolean; off: ConsentEffectPart[] }

export const CONSENT_EFFECTS_PATH = `${INTERVIEWS_API}/consent-effects`;

/** Only the recruiter's Upcoming shows the column. */
export const showsConsentColumn = (role: string | null | undefined): boolean => role === 'recruiter';

const OFF_WORDS: Record<ConsentEffectPart, string> = { recording: 'no recording', transcription: 'no transcript', milo: 'no Milo' };
const ORDER: readonly ConsentEffectPart[] = ['recording', 'transcription', 'milo'];

/**
 * "Not answered", "All on", or what is off ("No recording", "No transcript, no Milo"). When a part off is one the
 * deployment requires (row I6.4, the read's `blocked`): "Cannot go ahead as set: no recording".
 */
export function consentColumnLabel(effect: (Pick<ConsentEffect, 'answered' | 'off'> & { blocked?: boolean }) | null | undefined): string {
  if (!effect || !effect.answered) return 'Not answered';
  const off = ORDER.filter((p) => effect.off.includes(p));
  if (!off.length) return 'All on';
  const text = off.map((p) => OFF_WORDS[p]).join(', ');
  if (effect.blocked) return `Cannot go ahead as set: ${text}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ── The invitation message (gap audit 2026-11-20 §6): a ready message the recruiter copies with the link ──────────────────
// The product sends nothing itself. Built here, in the page, from the row and the link just made; never stored, never
// logged, and shown only where the link is shown (the once-at-creation rule above).

export interface InvitationInput {
  candidateName: string;
  openingTitle: string;
  roundName: string;
  roundType: 'technical' | 'behavioural';
  scheduledAt: string | null;
  minutes: number;
  link: string;
}

/** The first word of a name, or the whole name trimmed; "there" when the name is empty. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || 'there';
}

/** "Thursday 4 March 2027 at 15:30 GMT", in the viewer's zone (or `timeZone`). */
export function invitationWhen(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d).replace(',', '');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
  return `${day} at ${time} ${zone}`;
}

const lengthWords = (minutes: number): string => {
  if (minutes % 60 === 0 && minutes >= 60) return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
};

/** The invitation, plain text, ready to paste into the recruiter's own mail. */
export function invitationMessage(m: InvitationInput, timeZone?: string): string {
  const when = m.scheduledAt && !Number.isNaN(Date.parse(m.scheduledAt)) ? invitationWhen(m.scheduledAt, timeZone) : 'a time we will confirm with you';
  const expect = m.roundType === 'technical'
    ? 'The interview is a video call in your browser, with a shared code pad or whiteboard for the technical part; there is nothing to install.'
    : 'The interview is a video call in your browser; there is nothing to install.';
  return [
    `Hi ${firstNameOf(m.candidateName)},`,
    '',
    `Thank you for applying for ${m.openingTitle.trim()}. Your ${m.roundName.trim()} is on ${when} and lasts ${lengthWords(m.minutes)}.`,
    '',
    `Join from this link when it is time: ${m.link}`,
    '',
    `${expect} The link is yours alone, so please do not share it. If you cannot make this time, open the link and tell us.`,
  ].join('\n');
}
