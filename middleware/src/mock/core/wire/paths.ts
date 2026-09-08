// Where things are on disk, resolved the same way from jest (CJS) and from
// `npx tsx` (ESM). `__dirname` exists in only one of those and `import.meta` in
// only the other, so neither is used: we walk up from the working directory
// until we find the middleware package, which is how both runners are invoked
// (`cd middleware && npm test`, `cd middleware && npx tsx ...`).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PKG_NAME = '@orgiq/middleware';

function isMiddlewareRoot(dir: string): boolean {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    return (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }).name === PKG_NAME;
  } catch {
    return false;
  }
}

let cached: string | null = null;

/** Absolute path of `middleware/`. Throws with instructions rather than guessing. */
export function middlewareRoot(): string {
  if (cached) return cached;
  let dir = resolve(process.cwd());
  for (;;) {
    if (isMiddlewareRoot(dir)) return (cached = dir);
    // Also accept being run from the repo root.
    if (isMiddlewareRoot(join(dir, 'middleware'))) return (cached = join(dir, 'middleware'));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    `wire: could not find the ${PKG_NAME} package from cwd ${process.cwd()}. ` +
      `Run this from the middleware directory (cd middleware && ...).`,
  );
}

/** Absolute path of the repo root — the parent of `middleware/`. */
export function repoRoot(): string {
  return dirname(middlewareRoot());
}

/** Where the committed snapshots live. */
export function snapshotDir(): string {
  return join(middlewareRoot(), 'src/mock/core/wire/snapshots');
}

export const ROUTES_SNAPSHOT = 'routes.json';
export const WIRE_SNAPSHOT = 'wire.json';
/** The write replay's snapshot — a separate file so a stale one is visible. */
export const WRITES_SNAPSHOT = 'writes.json';
