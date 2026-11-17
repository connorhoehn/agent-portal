// The time on a round and the candidate's invite link, on the portal side (docs/interviews-tenant-plan.md row I1.5
// and the invite lane): the writes the Upcoming page makes. The server checks everything (middleware
// lib/interviews/assign.ts checkTime) and answers its problem in one sentence on `scheduledAt`.

import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';

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

export type TimeOutcome = { ok: true } | { ok: false; error: string; stale: boolean };

/** Set (an ISO instant) or clear (`null`) a round's time against the revision the page loaded. */
export async function setRoundTime(id: string, revision: number, scheduledAt: string | null): Promise<TimeOutcome> {
  const r = await writeJson<{ fields?: Array<{ message: string }> }>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/time`, 'PUT', { revision, scheduledAt });
  if (r.ok) return { ok: true };
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

/** The link's status in a sentence: sent, opened, expires. */
export function inviteLine(s: InviteStatus, when: (iso: string) => string): string {
  switch (s.state) {
    case 'none': return 'No link yet';
    case 'revoked': return 'Revoked';
    case 'expired': return 'Expired';
    case 'closed': return 'Round closed';
    case 'other-interview': return 'Replaced';
    default: {
      const sent = s.issuedAt ? `Sent ${when(s.issuedAt)}` : 'Sent';
      const opened = s.openCount > 0 && s.lastOpenedAt ? `opened ${s.openCount === 1 ? 'once' : `${s.openCount} times`}` : 'not opened';
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
