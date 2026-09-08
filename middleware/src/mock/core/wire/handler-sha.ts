// One hash over everything that shapes a response.
//
// WHY. The snapshot freshness check used to be `find -newer wire.json`: any
// handler source with a newer mtime invalidated the capture. That proxy has a
// hole a real capture fell through. A sweep run at 22:27 recorded responses
// from a server booted at 02:24, BEFORE a route change — the snapshot file's
// mtime was then newer than the source it disagreed with, so the check passed
// while `wire.json` held the pre-change shape. mtime says when the file was
// written; it says nothing about what the process serving those responses was
// running.
//
// So the SERVER hashes its own handler sources at boot and reports that hash;
// the capture records it; the validator recomputes it from disk. A capture
// taken against a stale process carries a stale hash and is caught, however
// new the file is. The comparison is content, not time.
//
// There is exactly ONE implementation of the file set and the digest, used by
// all three callers, because the last time this repo had two hash
// implementations for one question they disagreed and a seal was written that
// nothing could reproduce.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Roots under `middleware/src` that decide what a response contains.
 *
 * `core/wire` and `core/parity` are the harnesses themselves — they read the
 * capture and never change what the server sends — so editing them must not
 * invalidate it. Tests are excluded for the same reason.
 */
const ROOTS = ['routes', 'providers', 'mock', 'lib'];
const SKIP = ['__tests__', '/core/wire/', '/core/parity/'];

/**
 * Normalise the root before it is used as a slice offset.
 *
 * Two callers reach this with the same directory spelled differently — the
 * server via `join(__dirname, '..')` (no trailing slash), the validator via a
 * file URL (with one). A one-character difference in the root shifts every
 * relative path in the digest and the two hashes disagree over identical
 * files, which is the failure this whole module exists to avoid.
 */
function normalizeRoot(dir: string): string {
  return dir.endsWith('/') ? dir.slice(0, -1) : dir;
}

export function handlerSourceFiles(dirIn: string): string[] {
  const srcDir = normalizeRoot(dirIn);
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      const rel = full.slice(srcDir.length);
      if (SKIP.some((s) => rel.includes(s))) continue;
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (name.endsWith('.ts')) out.push(full);
    }
  };
  for (const root of ROOTS) walk(join(srcDir, root));
  const index = join(srcDir, 'index.ts');
  try { statSync(index); out.push(index); } catch { /* not built from source */ }
  return out.sort();
}

/**
 * SHA-256 over the relative path and bytes of every handler source.
 *
 * The path is hashed alongside the content so that deleting one file and
 * adding an identical one under a different name still moves the digest —
 * routing is part of what shapes a response.
 */
export function handlerSha(dirIn: string): string {
  const srcDir = normalizeRoot(dirIn);
  const h = createHash('sha256');
  for (const f of handlerSourceFiles(srcDir)) {
    h.update(f.slice(srcDir.length));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}
