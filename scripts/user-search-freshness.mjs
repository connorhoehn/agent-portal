// The user-search probe's freshness digest (docs/user-search-goal.md judge 2):
// a hash over the content of every file the probe's verdicts depend on. The
// probe records it in docs/user-search-probe-results.json; the judge
// recomputes it — equal means the results describe this tree, whatever has
// been committed since; different means a search, answer, palette or composer
// file changed after the probe ran and the results must be re-probed.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WATCHED = [
  'middleware/src/providers/search.ts',
  'middleware/src/lib/search-index',
  'middleware/src/lib/local-answers',
  'middleware/src/mock/responses.ts',
  'portal/src/pages/search',
  'portal/src/components/collections',
  'portal/src/components/shell/portalCommands.ts',
  'portal/e2e/user-search-catalog.ts',
];

function files(abs) {
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs).flatMap((n) => (n === '__tests__' || n === 'node_modules' ? [] : files(join(abs, n))));
}

/** sha256 (16 hex) over `path\0content` of every watched source file (tests excluded), in path order. */
export function watchedDigest() {
  const h = createHash('sha256');
  for (const f of WATCHED.flatMap((p) => files(resolve(ROOT, p))).sort()) h.update(`${relative(ROOT, f)}\0`).update(readFileSync(f)).update('\0');
  return h.digest('hex').slice(0, 16);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(watchedDigest());
