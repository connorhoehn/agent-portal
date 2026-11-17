// What is kept about an interview, in which class, and when each class is due to go (docs/interviews-tenant-plan.md
// decision 17, row I6.3). Pure: every function takes the clock and the periods.
//
// The classes, decided here:
//   media     the recording, the transcript and Milo's minutes of the interview's call, and the code log (none is kept
//             yet). Due `mediaDays` after the interview's period starts. Also removed at once when the candidate asks.
//   record    the scorecards, the consents (the record of the candidate's answers) and the log of what Milo showed.
//             Due `recordYears` after the period starts. A deletion request does NOT remove them (the notice says the
//             record of answers stays for its period); it takes the candidate's contact details out instead.
//   candidate the résumé file and the candidate's contact details. They belong to the candidate, not to one interview:
//             removed at once on a deletion request (the résumé is media in all but name: a file the candidate gave),
//             and otherwise when the candidate's records are due (every interview of theirs closed and past
//             `recordYears`). A candidate with no interview is not swept here: there is no interview to count from.
//
// When the period starts:
//   ended, scored, reviewed   when the interview ended (`endedAt`; else its scheduled end; else when it was assigned)
//   declined                  the last decline's time, else when it was assigned
//   cancelled                 when it was assigned (the row keeps no cancel time). Neither held a call, so nothing
//                             of media class should exist; the sweep still asks the erasers, which find nothing.
//   assigned, accepted, ready, live   never: an open interview is not erased early by a sweep, whatever its age.

import type { Interview, InterviewState } from '../types.js';
import type { RetentionPeriods } from './periods.js';

export type RetentionClass = 'media' | 'record';
/** What a candidate's deletion log row may name. Never content, never a name, an address or a file name. */
export type RemovedKind = 'recording' | 'transcript-and-minutes' | 'code-log' | 'scorecards' | 'consents' | 'suggestions' | 'resume' | 'contact-details' | 'invite' | (string & {});

export const OPEN_STATES: readonly InterviewState[] = ['assigned', 'accepted', 'ready', 'live'];
const ENDED_STATES: readonly InterviewState[] = ['ended', 'scored', 'reviewed'];

export const DAY_MS = 86_400_000;

export const isOpen = (iv: Pick<Interview, 'state'>): boolean => OPEN_STATES.includes(iv.state);

/** Calendar years in UTC: 29 February plus one year is 1 March. */
export function addYears(ms: number, years: number): number {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** When the interview's retention periods start counting (epoch ms), or null while it is open. */
export function periodStartMs(iv: Pick<Interview, 'state' | 'endedAt' | 'scheduledAt' | 'minutes' | 'assignedAt' | 'declines'>): number | null {
  if (isOpen(iv)) return null;
  const assigned = ms(iv.assignedAt) ?? 0;
  if (ENDED_STATES.includes(iv.state)) {
    const scheduledEnd = ms(iv.scheduledAt);
    return ms(iv.endedAt) ?? (scheduledEnd !== null ? scheduledEnd + iv.minutes * 60_000 : assigned);
  }
  if (iv.state === 'declined') {
    const last = iv.declines.map((d) => ms(d.at)).filter((t): t is number => t !== null).sort((a, b) => b - a)[0];
    return last ?? assigned;
  }
  return assigned; // cancelled
}

type Dated = Parameters<typeof periodStartMs>[0];

/** When the class is due to go for this interview (epoch ms), or null while it is open. */
export function dueAtMs(iv: Dated, cls: RetentionClass, p: RetentionPeriods): number | null {
  const start = periodStartMs(iv);
  if (start === null) return null;
  return cls === 'media' ? start + p.mediaDays * DAY_MS : addYears(start, p.recordYears);
}

export function isDue(iv: Dated, cls: RetentionClass, p: RetentionPeriods, nowMs: number): boolean {
  const due = dueAtMs(iv, cls, p);
  return due !== null && due <= nowMs;
}

/** By when a deletion asked at `requestedAtMs` is to be finished. */
export const deletionDueByMs = (requestedAtMs: number, p: RetentionPeriods): number => requestedAtMs + p.deletionDays * DAY_MS;

/** A candidate's résumé and contact details are due when they have interviews and every one is closed and past its record period. */
export function candidateRecordsDue(interviews: readonly Dated[], p: RetentionPeriods, nowMs: number): boolean {
  return interviews.length > 0 && interviews.every((iv) => isDue(iv, 'record', p, nowMs));
}

/** The lobby an interview's call runs in (lib/interviews/lobby.ts), the name the recording service knows it by. */
export const interviewLobby = (interviewId: string): string => `interviews:interview:${interviewId}`;

// ── Redaction ───────────────────────────────────────────────────────────────
// What a deletion request leaves in the candidate row. The record (applications, interviews, scorecards, consents)
// stays for its period and still points at the candidate's id, so the row stays; what could reach the person goes.
// `source` (careers page, referral, agency…) and `createdAt` stay: they say how the application came, not who it is.

export const REDACTED_NAME = 'Name removed';
export interface ContactFields { name: string; email: string; headline: string; location: string; notes: string }
export const REDACTED_CONTACT: Readonly<ContactFields> = Object.freeze({ name: REDACTED_NAME, email: '', headline: '', location: '', notes: '' });
export const isRedacted = (c: Pick<ContactFields, 'name' | 'email'>): boolean => c.name === REDACTED_NAME && c.email === '';
