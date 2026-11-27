// "I can't make this time", from the candidate (gap audit 2026-11-20 §6). The candidate, holding only their invite, says on
// their own page that they cannot make a round that has not started, with an optional note. It writes one record on that
// interview (when, and their words: types.ts CantMakeNotice), rings the recruiters with the tenant's bell (the opening and
// the round, never the candidate) and tells the candidate the recruiter knows and will be in touch. Nothing else changes:
// the round keeps its time and its state, and the recruiter decides.
//
//   the guest      POST /api/interview-invite/cant-make (routes/interview-invite.ts), behind requireGuest and the door's
//                  throttle. The interview is the guest session's own, never one the body names.
//   once a spell   at most one notice per interview per CANT_MAKE_WINDOW_MS: a repeat inside it answers the same
//                  confirmation, writes nothing and rings nothing. The window is the stored notice's time, and, after the
//                  recruiter clears it, this process's memory of the last notice (bounded; a restart forgets it, the
//                  waiting room's rule). A new time is a new question: rescheduling forgets the memory too.
//   the recruiter  sees the notice and the note on the round's row and on the profile (views.ts InterviewRow.cantMake,
//                  contact readers only) and clears it (routes/interviews/cant-make.ts). Rescheduling and cancelling
//                  clear it in the store (store.ts setTime, cancelInterview); erasure removes it (retention/erasers.ts).

import { runWithDbTenant } from '../../providers/db-tenant.js';
import { notifyInterviewCantMake } from '../social-notify.js';
import type { Checked, FieldProblem } from './kit.js';
import { isNotYetLive } from './cancel.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type CantMakeNotice, type Interview } from './types.js';

export const CANT_MAKE_NOTE_MAX = 280;
export const CANT_MAKE_WINDOW_MS = 12 * 60 * 60 * 1000;

/** The guest's body: `{ note? }`. The note is plain text, trimmed, spaces inside kept as typed; empty is none. */
export function checkCantMake(input: unknown): Checked<{ note: string | null }> {
  const body = input !== null && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const raw = body['note'];
  const problems: FieldProblem[] = [];
  let note: string | null = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'string') problems.push({ path: 'note', message: 'The note must be text.' });
    else {
      // Control characters other than line breaks never reach the store.
      const cleaned = raw.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
      if (cleaned.length > CANT_MAKE_NOTE_MAX) problems.push({ path: 'note', message: `Keep the note under ${CANT_MAKE_NOTE_MAX} characters.` });
      note = cleaned || null;
    }
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { note } };
}

// ── The window's memory ──────────────────────────────────────────────────────

const lastNotice = new Map<string, number>();
const MEMORY_MAX = 5000;
function remember(interviewId: string, atMs: number): void {
  lastNotice.delete(interviewId);
  lastNotice.set(interviewId, atMs);
  if (lastNotice.size > MEMORY_MAX) lastNotice.delete(lastNotice.keys().next().value as string);
}
/** A new time is a new question: the candidate may answer it afresh (routes/interviews/assignments.ts time). */
export function forgetCantMake(interviewId: string): void { lastNotice.delete(interviewId); }
/** For tests. */
export function resetCantMake(): void { lastNotice.clear(); }

export type CantMakeMove =
  | { ok: true; kind: 'write'; notice: CantMakeNotice }
  | { ok: true; kind: 'repeat' }
  | { ok: false; reason: 'started'; message: string };

export const STARTED = 'This interview has already started or closed, so there is nothing to tell the recruiter from here.';

/** What the guest's press does now. Pure but for the window's memory, read not written. */
export function cantMakeMove(i: Pick<Interview, 'id' | 'state' | 'cantMake'>, note: string | null, now: Date): CantMakeMove {
  if (!isNotYetLive(i.state)) return { ok: false, reason: 'started', message: STARTED };
  const nowMs = now.getTime();
  const stored = i.cantMake ? Date.parse(i.cantMake.at) : Number.NaN;
  const remembered = lastNotice.get(i.id) ?? Number.NaN;
  const latest = Math.max(Number.isNaN(stored) ? -Infinity : stored, Number.isNaN(remembered) ? -Infinity : remembered);
  if (nowMs - latest < CANT_MAKE_WINDOW_MS) return { ok: true, kind: 'repeat' };
  return { ok: true, kind: 'write', notice: { at: now.toISOString(), note } };
}

/** The notice was written: remember it for the window. */
export function noticeWritten(interviewId: string, notice: CantMakeNotice): void { remember(interviewId, Date.parse(notice.at)); }

/** The holders of the recruiter role in the tenant. */
async function recruiterIds(): Promise<string[]> {
  const { listUsers } = await import('../../providers/identity.js');
  return (await listUsers()).filter((u) => (u.grants[INTERVIEWS_TENANT] ?? []).includes('recruiter')).map((u) => u.id);
}

/** Ring the recruiters: the opening's title and the round's name, never the candidate. Resolves to who was rung; never throws. */
export async function ringCantMake(interview: Interview): Promise<string[]> {
  try {
    return await runWithDbTenant(INTERVIEWS_TENANT, async () => {
      const store = interviewsStore();
      const [applications, openings] = await Promise.all([store.listApplications(), store.listOpenings()]);
      const application = applications.find((a) => a.id === interview.applicationId);
      const opening = application ? openings.find((o) => o.id === application.openingId) : undefined;
      if (!opening) return [];
      const roundName = opening.kit.rounds.find((r) => r.id === interview.roundId)?.name ?? 'A round';
      return notifyInterviewCantMake({ interviewId: interview.id, openingTitle: opening.title, roundName, recruiterIds: await recruiterIds() });
    });
  } catch {
    return [];
  }
}
