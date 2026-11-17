// The résumé on a candidate's profile, portal side (docs/interviews-tenant-plan.md row I1.6): the pure helpers
// (size as a person reads it, the X-File-Name encoding, the pre-check before an upload) and the three calls the
// profile makes. The server checks everything again (middleware lib/interviews/resume/rules.ts) and its sentence
// is shown as it comes.

import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';

/** The same limit as the server's RESUME_MAX_BYTES. */
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;

export interface ResumeRecord {
  id: string;
  candidateId: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  uploadedBy: { id: string; name: string } | null;
  uploadedAt: string;
}

export const resumePath = (candidateId: string): string => `${INTERVIEWS_API}/candidates/${encodeURIComponent(candidateId)}/resume`;
export const resumeFilePath = (candidateId: string): string => `${resumePath(candidateId)}/file`;

/** A size as a person reads it: "812 KB", "1.4 MB". */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** The `X-File-Name` header value: the name percent-encoded, so any letters travel as plain ASCII. */
export const fileNameHeader = (name: string): string => encodeURIComponent(name);

/** What can be said before sending: not a PDF, empty, too large. `null` means send it. */
export function precheck(file: { name: string; type: string; size: number }): string | null {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return 'Only PDF files can be attached as a résumé.';
  if (file.size === 0) return 'The file is empty. Choose the résumé again.';
  if (file.size > RESUME_MAX_BYTES) return `That file is larger than ${sizeLabel(RESUME_MAX_BYTES)}. Choose a smaller PDF.`;
  return null;
}

export type ResumeOutcome = { ok: true } | { ok: false; error: string };

/** Upload (or replace) the résumé: the file is the raw body. */
export async function uploadResume(candidateId: string, file: File): Promise<ResumeOutcome> {
  const problem = precheck(file);
  if (problem) return { ok: false, error: problem };
  try {
    const res = await fetch(resumePath(candidateId), {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/pdf', 'X-File-Name': fileNameHeader(file.name) },
      body: file,
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? (res.status === 403 ? 'You do not have permission to change this résumé.' : 'The résumé could not be saved. Try again.') };
  } catch {
    return { ok: false, error: 'The résumé could not be sent. Check the connection and try again.' };
  }
}

export async function removeResume(candidateId: string): Promise<ResumeOutcome> {
  const r = await writeJson<unknown>(resumePath(candidateId), 'DELETE');
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? 'The résumé could not be removed. Try again.' };
}
