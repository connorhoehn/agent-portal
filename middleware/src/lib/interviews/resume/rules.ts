// The résumé rules (row I1.6), pure functions so each is tested on its own. A résumé is a file from outside
// the building, so every rule takes the stricter reading:
//
//   * a PDF is decided by its first bytes (`%PDF-`), never by the type the client declared or the name it gave;
//   * at most RESUME_MAX_BYTES, enforced by the body parser's limit (routes/interviews/resume.ts) AND checked
//     again here on the buffer; an empty body is refused;
//   * the name shown is cleaned (no path, no control or direction-changing characters, at most 120 characters,
//     ending `.pdf`) and is never used to build the storage key; the key is made from two ids.

import { createHash } from 'node:crypto';

export const RESUME_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_NAME_MAX = 120;
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

export type UploadCheck = { ok: true } | { ok: false; status: 400 | 413 | 415; error: string };

export const isPdfBytes = (bytes: Buffer): boolean => bytes.length >= PDF_MAGIC.length && bytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);

/** What an upload's bytes must be: not empty, within the limit, a PDF by content. */
export function checkResumeBytes(bytes: Buffer): UploadCheck {
  if (bytes.length === 0) return { ok: false, status: 400, error: 'The file is empty. Choose the résumé again.' };
  if (bytes.length > RESUME_MAX_BYTES) return { ok: false, status: 413, error: 'That file is larger than 10 MB. Choose a smaller PDF.' };
  if (!isPdfBytes(bytes)) return { ok: false, status: 415, error: 'Only PDF files can be attached as a résumé.' };
  return { ok: true };
}

// C0 and C1 controls, line and paragraph separators, zero-width and direction-changing characters.
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]', 'g');

/** The name to show for an uploaded file. Never empty; always ends `.pdf`; at most 120 characters. */
export function cleanFileName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  try { name = decodeURIComponent(name); } catch { /* not encoded: keep it as sent */ }
  name = name.replace(UNSAFE_CHARS, '');
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim();
  if (/\.pdf$/i.test(name)) name = name.slice(0, -4);
  name = name.replace(/\.+$/, '').trim().slice(0, RESUME_NAME_MAX - 4).trim();
  return `${name || 'resume'}.pdf`;
}

/** `Content-Disposition: inline` with the cleaned name encoded two ways (RFC 6266): an ASCII fallback and the UTF-8 form. */
export function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^A-Za-z0-9._ -]/g, '_');
  const star = encodeURIComponent(fileName).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename="${ascii}"; filename*=UTF-8''${star}`;
}

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

/** `interviews/resumes/<candidate id>/<file id>.pdf`: made from two ids, never from the file's name. */
export function resumeStorageKey(candidateId: string, fileId: string): string {
  if (!ID_SHAPE.test(candidateId) || !ID_SHAPE.test(fileId)) throw new Error('A résumé key is made only from plain ids.');
  return `interviews/resumes/${candidateId}/${fileId}.pdf`;
}

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
