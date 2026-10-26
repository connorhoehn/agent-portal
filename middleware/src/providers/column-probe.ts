// "Does this cluster have that column yet?" — asked once, cached, per table.
//
// Three features now need this question, and all three need it for the same
// reason: `schema/local_compute_worker_schema.sql` is additive, applied by hand,
// and the middleware is deployed independently of it. A statement that names a
// column the cluster has not got does not degrade — it throws, and it throws on
// the shared push path, so a feature nobody has turned on takes down the queue
// that was working. The rule that follows is the one every caller here obeys:
//
//   Probe before using additive columns. Preserve safe legacy read paths;
//   claims that require fencing must instead refuse to run before migration.
//
// Cached because it is asked on every claim, every heartbeat and every
// completion, and `information_schema` is not free over the Data API. A false
// answer is cached too — deliberately. A cluster does not gain a column while
// the process runs (applying the migration is a deploy step, and the middleware
// restarts around it), and re-probing on every miss would turn one failed read
// into a permanent per-request tax on exactly the cluster already in trouble.
// `_resetColumnProbes()` is the way back for tests and for a process that wants
// to re-ask.

import { exec } from './aurora.js';
import { config } from '../config.js';

/** Cache key is `table:col,col` — a caller asking about a different pair of
 *  columns on the same table gets its own answer rather than inheriting one. */
const cache = new Map<string, boolean>();

/**
 * Whether `table` has every one of `columns`.
 *
 * Answers `true` under MOCK_AURORA: the mock fixtures implement the post-
 * migration shape (they are written against the current schema, not against
 * whatever a given cluster happens to have applied), so an offline dev must see
 * the feature rather than the degraded path. The degraded path is real and is
 * tested by pointing the probe at a table that genuinely lacks the column.
 *
 * A read that fails answers `false`. That is the conservative direction: the
 * caller either preserves a safe legacy path or refuses a capability that
 * requires those columns. Guessing `true` produces a statement that throws.
 */
export async function hasColumns(table: string, columns: readonly string[]): Promise<boolean> {
  if (config.mock.aurora) return true;
  const key = `${table}:${[...columns].sort().join(',')}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    // The RDS Data API has no array parameter, so the column list is expanded
    // into named placeholders — the same shape claimNextJobForWorker uses for
    // its kind allowlist. `table` and the placeholder names are ours; only the
    // values are bound.
    const params = columns.map((c, i) => ({ name: `c${i}`, value: { stringValue: c } }));
    const list = columns.map((_, i) => `:c${i}`).join(', ');
    const rows = await exec(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = :t AND column_name IN (${list})`,
      [{ name: 't', value: { stringValue: table } }, ...params],
    );
    present = Number(rows[0]?.['n'] ?? 0) >= columns.length;
  } catch {
    present = false;
  }
  cache.set(key, present);
  return present;
}

/** Test hook — forget every cached answer. */
export function _resetColumnProbes(): void { cache.clear(); }
