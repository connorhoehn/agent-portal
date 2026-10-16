// Runbook files (R8): the scripts and data a runbook carries, like a skill
// does. A runbook bundle is self-contained — procedure + scripts/ + data/ —
// and needs no repository: it ships to every box as one skill directory
// (skill.ts, library.ts).
//
// Everything here treats file content as UNTRUSTED (a run wrote it):
//   * paths are bundle-relative, under scripts/ or data/, one safe charset,
//     no `..`, no absolute path, no backslash, no dot-segment, no hidden file;
//   * content is UTF-8 text with no NUL byte, capped per file and per bundle,
//     and the whole library is capped too (library.ts);
//   * sha256 and size are always derived here (`fileOf`), never taken from a
//     caller, so a stored hash can never disagree with the bytes.
// Pure: no I/O.
import type { RunbookFile } from './types.js';
import { sha256Hex } from './tokens.js';

export const FILE_LIMITS = {
  /** One file, UTF-8 bytes. */
  file_bytes: 32 * 1024,
  /**
   * Every file of one version together. Kept under the BFF's 100 KB JSON body
   * limit (index.ts express.json) so a proposal carrying a whole bundle still
   * arrives, and far under a 400 KB Dynamo item with the doc riding along.
   */
  bundle_bytes: 80 * 1024,
  files: 24,
  path_chars: 120,
  /** The whole skill library a box receives (library.ts). */
  library_bytes: 8 * 1024 * 1024,
} as const;

export const FILE_ROOTS = ['scripts', 'data'] as const;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export class RunbookFileError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'RunbookFileError';
  }
}

/** Why a bundle path is unacceptable, or null when it is fine. */
export function checkFilePath(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return 'a file needs a path';
  if (path.length > FILE_LIMITS.path_chars) return `path is longer than ${FILE_LIMITS.path_chars} characters`;
  if (path.includes('\0')) return 'path contains a NUL byte';
  if (path.includes('\\')) return 'path uses a backslash; use / between folders';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return `"${path}" is absolute; give a path inside the bundle (scripts/… or data/…)`;
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) return `"${path}" climbs out of the bundle with ..`;
  if (parts.some((p) => p === '' || p === '.')) return `"${path}" has an empty or "." segment`;
  if (!(FILE_ROOTS as readonly string[]).includes(parts[0]!)) return `"${path}" is not under scripts/ or data/`;
  if (parts.length < 2) return `"${path}" names a folder, not a file`;
  const bad = parts.slice(1).find((p) => !SEGMENT.test(p));
  if (bad !== undefined) return `"${path}" has a segment ("${bad}") outside [A-Za-z0-9._-] or starting with "." or "-"`;
  return null;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Build a file from untrusted input: path and content checked, hash and size derived. Throws RunbookFileError. */
export function fileOf(input: { path: unknown; content: unknown; mode?: unknown }): RunbookFile {
  const problems: string[] = [];
  const pathProblem = checkFilePath(input.path);
  if (pathProblem) problems.push(pathProblem);
  if (typeof input.content !== 'string') problems.push(`${String(input.path)}: content must be text`);
  else {
    if (input.content.includes('\0')) problems.push(`${String(input.path)}: content has a NUL byte (binary files are not carried)`);
    const size = byteLength(input.content);
    if (size > FILE_LIMITS.file_bytes) problems.push(`${String(input.path)}: ${size} bytes is over the ${FILE_LIMITS.file_bytes}-byte limit per file`);
  }
  const mode = input.mode === undefined || input.mode === null ? undefined : String(input.mode);
  if (mode !== undefined && mode !== '644' && mode !== '755') problems.push(`${String(input.path)}: mode must be 644 or 755`);
  if (problems.length) throw new RunbookFileError(problems);
  const path = input.path as string;
  const content = input.content as string;
  return {
    path,
    content,
    mode: (mode as RunbookFile['mode'] | undefined) ?? (path.startsWith('scripts/') ? '755' : '644'),
    sha256: sha256Hex(content),
    size: byteLength(content),
  };
}

/** Validate a whole set (count, total, duplicates, each file) and return it sorted by path. Throws RunbookFileError. */
export function filesOf(raw: unknown): RunbookFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new RunbookFileError(['`files` must be a list of { path, content, mode? }']);
  if (raw.length > FILE_LIMITS.files) throw new RunbookFileError([`${raw.length} files is over the limit of ${FILE_LIMITS.files}`]);
  const problems: string[] = [];
  const out: RunbookFile[] = [];
  for (const r of raw) {
    try {
      const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
      out.push(fileOf({ path: o['path'], content: o['content'], mode: o['mode'] }));
    } catch (e) {
      if (e instanceof RunbookFileError) problems.push(...e.problems); else throw e;
    }
  }
  const seen = new Set<string>();
  for (const f of out) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) problems.push(`${f.path} appears twice (paths are compared case-insensitively)`);
    seen.add(key);
  }
  // A file and a folder of the same name cannot both exist on disk.
  for (const f of out) if (out.some((g) => g.path.toLowerCase().startsWith(`${f.path.toLowerCase()}/`))) problems.push(`${f.path} is both a file and a folder`);
  const total = out.reduce((n, f) => n + f.size, 0);
  if (total > FILE_LIMITS.bundle_bytes) problems.push(`the files total ${total} bytes, over the ${FILE_LIMITS.bundle_bytes}-byte limit per runbook`);
  if (problems.length) throw new RunbookFileError(problems);
  return sortFiles(out);
}

export function sortFiles(files: readonly RunbookFile[]): RunbookFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The version's identity once files are part of it: sha256 over the markdown's
 * sha and one line per file (path, mode, sha), sorted. Content-addressed, so the
 * same bundle always has the same sha whichever store wrote it.
 */
export function bundleSha(markdownSha: string, files: readonly RunbookFile[]): string {
  const lines = [`markdown ${markdownSha}`, ...sortFiles(files).map((f) => `file ${f.path} ${f.mode} ${f.sha256}`)];
  return sha256Hex(lines.join('\n') + '\n');
}

/** The file set without content — what a list or a manifest shows. */
export function fileManifest(files: readonly RunbookFile[]): Array<Omit<RunbookFile, 'content'>> {
  return sortFiles(files).map(({ content: _c, ...rest }) => rest);
}
