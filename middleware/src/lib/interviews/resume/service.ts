// What the résumé routes and the deletion row (I6.3) call: store, read and remove a candidate's résumé.
// The stores are chosen once per process and injectable for tests (the setters), as store-select.ts does.
//
// Order of a replace, so a failure never leaves a row whose file is missing: the new bytes are put first,
// then the row is swapped (and the candidate pointed at it), then the old bytes are removed. A failed
// put changes nothing; a failed old-bytes removal is logged without the name or the contents and leaves
// one orphan object that no row points to.

import { randomUUID } from 'node:crypto';
import { MemoryResumeBytes, createResumeBytes, type ResumeBytesStore } from './bytes-store.js';
import { createResumeRows, type ResumeRowStore } from './row-store.js';
import { checkResumeBytes, cleanFileName, resumeStorageKey, sha256Hex, type UploadCheck } from './rules.js';
import { RESUME_CONTENT_TYPE, type ResumeRecord } from './types.js';
import { interviewsNow } from '../clock.js';

let rows: ResumeRowStore | null = null;
let bytes: ResumeBytesStore | null = null;
export const resumeRows = (): ResumeRowStore => (rows ??= createResumeRows());
export const resumeBytes = (): ResumeBytesStore => (bytes ??= createResumeBytes());
/** POST /api/__mock/reset: a seeded file a walk removed (row I6.3) is back, as its row is. Only the memory store has anything to reset. */
export function resetMockResumeBytes(): void {
  if (bytes instanceof MemoryResumeBytes) bytes.reset();
}
export function setResumeStores(next: { rows?: ResumeRowStore | null; bytes?: ResumeBytesStore | null }): void {
  if (next.rows !== undefined) rows = next.rows;
  if (next.bytes !== undefined) bytes = next.bytes;
}

export interface ResumeUpload { candidateId: string; bytes: Buffer; rawName: unknown; uploadedBy: string }

export async function storeResume(input: ResumeUpload): Promise<{ ok: true; resume: ResumeRecord } | Extract<UploadCheck, { ok: false }>> {
  const checked = checkResumeBytes(input.bytes);
  if (!checked.ok) return checked;
  const id = `rf-${randomUUID()}`;
  const row: ResumeRecord = {
    id, candidateId: input.candidateId, fileName: cleanFileName(input.rawName), sizeBytes: input.bytes.length, contentType: RESUME_CONTENT_TYPE,
    sha256: sha256Hex(input.bytes), uploadedBy: input.uploadedBy, uploadedAt: interviewsNow().toISOString(),
    storageKey: resumeStorageKey(input.candidateId, id),
  };
  await resumeBytes().put(row.storageKey, input.bytes);
  let previous: ResumeRecord | null;
  try {
    previous = await resumeRows().replace(row);
  } catch (err) {
    await resumeBytes().remove(row.storageKey).catch(() => undefined);
    throw err;
  }
  if (previous) await dropBytes(previous.storageKey);
  return { ok: true, resume: row };
}

/** The current résumé's row and bytes, or null when there is none (or its bytes are gone). */
export async function readResume(candidateId: string): Promise<{ resume: ResumeRecord; bytes: Buffer } | null> {
  const resume = await resumeRows().get(candidateId);
  if (!resume) return null;
  const held = await resumeBytes().get(resume.storageKey);
  return held ? { resume, bytes: held } : null;
}

/**
 * Remove a candidate's résumé: the bytes first (a failure throws and leaves the row, so a retry finds it), then the row and the
 * pointer. True when there was one. Exported for the deletion row (I6.3).
 */
export async function removeResumeFor(candidateId: string): Promise<boolean> {
  const current = await resumeRows().get(candidateId);
  if (!current) { await resumeRows().remove(candidateId); return false; }
  await resumeBytes().remove(current.storageKey);
  await resumeRows().remove(candidateId);
  return true;
}

async function dropBytes(key: string): Promise<void> {
  try { await resumeBytes().remove(key); } catch { console.warn('[interviews] a résumé object could not be removed; no row points to it'); }
}
