// Consent records on a candidate's profile and the export of what Milo showed (docs/interviews-tenant-plan.md decisions 4, 5
// and 8; rows I6.1 and I6.2), portal side. The server decides who reads the answers (the recruiter and the admin), who reads only
// that a notice was given (the opening's hiring manager) and who may export (the recruiter); this file only words them.
import { INTERVIEWS_API } from './interviews.ts';

export interface ConsentAnswerView { answer: boolean; at: string }

export interface ConsentRecordItem {
  interviewId: string;
  roundName: string;
  state: string;
  answered: boolean;
  noticeVersion: string | null;
  answeredAt: string | null;
  answers?: { recording: ConsentAnswerView; transcription: ConsentAnswerView; milo: ConsentAnswerView };
  exportable?: boolean;
}

export interface ConsentRecords { reads: 'answers' | 'notice'; items: ConsentRecordItem[] }

export const consentsPath = (candidateId: string): string => `${INTERVIEWS_API}/candidates/${encodeURIComponent(candidateId)}/consents`;
export const exportPath = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/milo-export`;

/** Who sees the section at all: the others get nothing to ask for. */
export const readsConsents = (role: string): boolean => role === 'recruiter' || role === 'admin' || role === 'hiring-manager';

/** "Yes" or "No", as the candidate answered. */
export const yesNo = (answer: boolean): string => (answer ? 'Yes' : 'No');

/** The notice's version names its day: "2026-11-16.1" reads "Notice of 16 Nov 2026". Anything else is shown as it is. */
export function noticeLabel(version: string | null): string {
  if (!version) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\.\d+)?$/.exec(version);
  if (!m) return version;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `Notice of ${day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
}

export const EMPTY_LINE = 'No interview of this candidate has a consent notice to show yet.';

export type ExportOutcome = { ok: true } | { ok: false; error: string };

/** Fetch the export with the session and hand it to the browser as a file. */
export async function downloadExport(interviewId: string): Promise<ExportOutcome> {
  try {
    const res = await fetch(exportPath(interviewId), { credentials: 'include' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: body.error ?? 'The export could not be made. Try again.' };
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `what-milo-showed-${interviewId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return { ok: true };
  } catch {
    return { ok: false, error: 'The export could not be made. Check the connection and try again.' };
  }
}
