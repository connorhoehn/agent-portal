// The one impure helper in lib/runbooks: a LintContext read from this tree —
// the mounted routes from the wire snapshot and a repo-path existence check —
// so R-command-real judges commands against what actually exists.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { LintContext } from './lint.js';

/** The repository root: the nearest directory, from the cwd upward, holding middleware/ and a README.md (the hand-over sweep removed CLAUDE.md). */
export function repoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (let k = 0; k < 8; k += 1) {
    if (existsSync(join(dir, 'middleware', 'package.json')) && existsSync(join(dir, 'README.md'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(`no repository root (middleware/ + README.md) above ${start}`);
}

export function repoLintContext(root: string = repoRoot()): LintContext {
  const snapshot = join(root, 'middleware/src/mock/core/wire/snapshots/routes.json');
  const routes = existsSync(snapshot)
    ? (JSON.parse(readFileSync(snapshot, 'utf8')) as { routes: Array<{ method: string; path: string }> }).routes
    : undefined;
  return {
    ...(routes ? { routes } : {}),
    pathExists: (p) => existsSync(join(root, p)),
  };
}
