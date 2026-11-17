// Deletions on a candidate's profile, portal side (docs/interviews-tenant-plan.md decision 17, row I6.3): the deletion
// log's rows as the profile reads them, the plain lines each row shows, the prompt's two sentences, and the request.
// The server decides who may ask and read (middleware routes/interviews/retention.ts); its sentence is shown as it comes.
import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export interface RetentionPeriods { mediaDays: number; recordYears: number; deletionDays: number }

export interface DeletionLeft { kind: string; why: 'pending' | 'failed' | 'call-running' | 'no-service'; retry: boolean }

export interface DeletionView {
  id: string;
  reason: 'request' | 'media-period' | 'record-period';
  requestedAt: string;
  requestedBy: { id: string; name: string } | null;
  dueBy: string;
  doneAt: string | null;
  interviews: number;
  removed: { kind: string; count: number }[];
  left: DeletionLeft[];
  /** Not finished, and the date it was due by has passed (the server decides, at the read). */
  overdue: boolean;
  /** Finished, but after the date it was due by. */
  doneLate: boolean;
}

export const deletionsPath = (candidateId: string): string => `${INTERVIEWS_API}/candidates/${encodeURIComponent(candidateId)}/deletions`;
export const deletionPath = (candidateId: string): string => `${INTERVIEWS_API}/candidates/${encodeURIComponent(candidateId)}/deletion`;

/** What each kind is called on the page. A kind this build does not know is shown as "Other records". */
const KIND_LABELS: Record<string, (n: number) => string> = {
  recording: (n) => (n === 1 ? '1 recording' : `${n} recordings`),
  'transcript-and-minutes': (n) => (n === 1 ? 'the transcript and minutes of 1 call' : `the transcripts and minutes of ${n} calls`),
  'code-log': () => 'the code log',
  scorecards: (n) => (n === 1 ? '1 scorecard' : `${n} scorecards`),
  consents: (n) => (n === 1 ? 'the consent answers of 1 interview' : `the consent answers of ${n} interviews`),
  suggestions: () => 'Milo\'s suggestion log',
  resume: () => 'the résumé',
  'contact-details': () => 'the contact details',
  'stage-reasons': (n) => (n === 1 ? 'the reasons written on 1 application\'s stage changes' : `the reasons written on ${n} applications' stage changes`),
  invite: (n) => (n === 1 ? '1 interview link turned off' : `${n} interview links turned off`),
};
const NAMES: Record<string, string> = {
  recording: 'the recordings', 'transcript-and-minutes': 'the transcript and minutes', 'code-log': 'the code log', scorecards: 'the scorecards',
  consents: 'the consent answers', suggestions: 'Milo\'s suggestion log', resume: 'the résumé', 'contact-details': 'the contact details', 'stage-reasons': 'the reasons written on stage changes', invite: 'the interview link',
};

const capital = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** "Removed 1 recording, the résumé and the contact details." */
export function removedLine(row: Pick<DeletionView, 'removed' | 'doneAt' | 'left'>): string {
  const parts = row.removed.filter((r) => r.count > 0).map((r) => (KIND_LABELS[r.kind] ?? (() => 'other records'))(r.count));
  if (!parts.length) return row.doneAt ? 'Nothing was held, so nothing needed removing.' : 'Nothing removed yet.';
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Removed ${list}.`;
}

/** What is left and why, one sentence each; empty when nothing is. */
export function leftLines(row: Pick<DeletionView, 'left'>): string[] {
  return row.left.map((l) => {
    const what = NAMES[l.kind] ?? 'some records';
    if (l.why === 'no-service') return `${capital(what)}: no recording service is connected here, so there was nothing to remove.`;
    if (l.why === 'call-running') return `${capital(what)}: the call was still running. They are removed within the hour after it ends.`;
    return `${capital(what)}: not removed yet. It is tried again within the hour.`;
  });
}

/** Who or what asked. */
export function askedByLine(row: Pick<DeletionView, 'reason' | 'requestedBy'>): string {
  if (row.reason === 'request') return row.requestedBy?.name ?? 'Someone without an account here';
  return row.reason === 'media-period' ? 'Automatic: the recording period ended' : 'Automatic: the record period ended';
}

export const deletionState = (row: Pick<DeletionView, 'doneAt'> & Partial<Pick<DeletionView, 'overdue' | 'doneLate'>>): { label: string; tone: 'success' | 'warning' | 'danger' } => {
  if (row.overdue) return { label: 'Late', tone: 'danger' };
  if (row.doneAt) return row.doneLate ? { label: 'Done late', tone: 'warning' } : { label: 'Done', tone: 'success' };
  return { label: 'In progress', tone: 'warning' };
};

/** The plain sentence a late row leads with, or null when it is not late. */
export function lateLine(row: Pick<DeletionView, 'dueBy' | 'overdue' | 'doneLate'>): string | null {
  const due = new Date(row.dueBy).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  if (row.overdue) return `Late: this was due by ${due} and is not finished. Ask for the deletion again to retry it now.`;
  if (row.doneLate) return `Finished late: it was due by ${due}.`;
  return null;
}

const yearsLabel = (n: number): string => (n === 1 ? 'one year' : n === 4 ? 'four years' : `${n} years`);

/** The prompt's two sentences: what goes, and what stays and for how long. */
export function deletionQuestion(p: RetentionPeriods): string {
  return 'This removes the recordings, transcripts and Milo\'s minutes of every interview with this candidate, their résumé, their contact details and the reasons written when their stage was changed, and turns off their interview link. '
    + `The scorecards and the record of their consent answers stay for ${yearsLabel(p.recordYears)} after each interview, without the contact details.`;
}

/** The profile's name for a candidate whose contact details were taken out (the server's own placeholder). */
export const REDACTED_NAME = 'Name removed';

export type DeletionOutcome = { ok: true; deletion: DeletionView; created: boolean } | { ok: false; error: string };

export async function requestDeletion(candidateId: string): Promise<DeletionOutcome> {
  const r = await writeJson<{ deletion: DeletionView; created: boolean }>(deletionPath(candidateId), 'POST', { confirm: true });
  if (r.ok && r.data) return { ok: true, deletion: r.data.deletion, created: r.data.created };
  return { ok: false, error: r.error ?? 'The deletion could not be confirmed. The Deletions list shows what was done; ask again to finish it.' };
}
