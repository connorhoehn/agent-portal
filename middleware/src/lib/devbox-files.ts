// Workspace file listing/reading for `GET /internal/devbox/:sessionId/files`
// and `GET /internal/devbox/:sessionId/files/:fileId` (LOOP-BRIEF.md §7, the
// Computer Lab "Files" tab).
//
// There is no dedicated file API on the deployed devbox runtime —
// `agents/devbox/main.py` exposes only the headless `/task` entrypoint (a
// `claude -p` run) and nothing that lists or streams workspace files. The
// closest thing is the public devbox router's own `/command` exec path, so
// real-mode listing/reading here runs `ls -la` / `cat` through that SAME
// transport (`routes/devbox.ts::execWorkspaceCommand`) rather than inventing
// a new one. This is a genuine fallback, not a first-class file API: the
// transport is text, so a binary file will not round-trip correctly through
// it until the runtime ships a real file surface.
//
// Mock transport (MOCK_AGENTCORE=true): `mock/devbox-agent-loop.ts` writes a
// real `notes.md` to a per-session temp workspace as the mock loop iterates
// — no invented file names. This module lists and reads directly off that
// directory.

import fs from 'node:fs';
import path from 'node:path';
import { execWorkspaceCommand } from '../routes/devbox.js';
import { mockWorkspaceDir } from '../mock/devbox-agent-loop.js';

export interface DevboxFileMeta { id: string; name: string; sizeBytes: number; updatedAt: string }
export interface DevboxFileContent { name: string; contentType: string; data: Buffer }

/**
 * A safe workspace-relative basename: no `/`, no `..`, no leading dot or
 * hyphen. Rejecting anything else is what keeps `:fileId` from climbing out
 * of the workspace — the mock temp dir, or `/mnt/workspace` via the exec
 * transport in real mode.
 */
export function isValidFileId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(id);
}

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
};

function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// ─── Mock transport ─────────────────────────────────────────────────────────

export function listMockFiles(sessionId: string): DevboxFileMeta[] {
  const dir = mockWorkspaceDir(sessionId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(isValidFileId)
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { id: name, name, sizeBytes: stat.size, updatedAt: stat.mtime.toISOString() };
    });
}

export function readMockFile(sessionId: string, fileId: string): DevboxFileContent | null {
  if (!isValidFileId(fileId)) return null;
  const dir = mockWorkspaceDir(sessionId);
  const file = path.join(dir, fileId);
  // Belt-and-suspenders on top of isValidFileId: the resolved path must
  // still live directly inside the session's own directory.
  if (path.dirname(file) !== dir) return null;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { name: fileId, contentType: contentTypeFor(fileId), data: fs.readFileSync(file) };
}

// ─── Real transport (exec-based; see file banner) ──────────────────────────

/** Matches one `ls -la` row for a regular file (`-rwx...`); directories and
 *  the `total N` header are skipped — this lists workspace FILES. */
const LS_LA_FILE_ROW = /^-[rwxst-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\w+\s+\d+\s+[\d:]+\s+(.+)$/;

function parseLsLa(output: string): DevboxFileMeta[] {
  const files: DevboxFileMeta[] = [];
  const listedAt = new Date().toISOString();
  for (const rawLine of output.split('\n')) {
    const m = LS_LA_FILE_ROW.exec(rawLine.trimEnd());
    if (!m) continue;
    const [, size, name] = m;
    if (!name || !isValidFileId(name)) continue;
    // `ls -la`'s timestamp column is locale-formatted and not reliably
    // machine-parseable; `updatedAt` here is "as of this listing", not the
    // file's real mtime. A `stat --format` pass per file would fix that at
    // the cost of one exec each — not worth it for a fallback transport.
    files.push({ id: name, name, sizeBytes: Number(size), updatedAt: listedAt });
  }
  return files;
}

export async function listRealFiles(sessionId: string, arn: string): Promise<DevboxFileMeta[]> {
  const out = await execWorkspaceCommand(sessionId, arn, 'ls -la');
  return parseLsLa(out);
}

const NOT_FOUND_SENTINEL = '__ORGIQ_FILE_NOT_FOUND__';

export async function readRealFile(sessionId: string, arn: string, fileId: string): Promise<DevboxFileContent | null> {
  if (!isValidFileId(fileId)) return null;
  const probe = `if [ -f "${fileId}" ]; then cat -- "${fileId}"; else printf '%s' '${NOT_FOUND_SENTINEL}'; fi`;
  const out = await execWorkspaceCommand(sessionId, arn, probe);
  if (out.trim() === NOT_FOUND_SENTINEL) return null;
  return { name: fileId, contentType: contentTypeFor(fileId), data: Buffer.from(out, 'utf8') };
}
