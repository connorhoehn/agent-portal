// The user-search probe's results file, written safely by parallel workers
// (docs/user-search-goal.md, judge 2).
//
// The probe shards by walker (a `tenant:role` group, each its own clone in its
// own mock scope), so several Playwright workers save into docs/user-search-
// probe-results.json at once. `mergeGroups` is the one writer: it holds a lock
// directory, re-reads the file, replaces ONLY the groups this call names and
// writes the file back, so a worker never overwrites another worker's groups.
//
// Freshness stays honest under partial runs (USER_SEARCH_ONLY=access): every
// persona entry records the `watchedDigest` of the tree it was probed on, and
// the file's top-level `watchedDigest` — the one the judge compares with the
// tree — is the digest the WHOLE catalog agrees on, or null when any catalog
// persona was probed on another tree (or never). Re-probing one tenant after a
// watched file changed therefore leaves the file stale until every tenant has
// been re-probed; re-probing one tenant on an unchanged tree keeps it fresh.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCK_WAIT_MS = 60_000;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` holding the results file's lock (a `<out>.lock` directory; a lock older than a minute is stale). */
export function withResultsLock(out, fn) {
  const lock = `${out}.lock`;
  mkdirSync(dirname(out), { recursive: true });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > 60_000) { rmSync(lock, { recursive: true, force: true }); continue; } } catch { /* released meanwhile */ }
      if (Date.now() > until) throw new Error(`could not take ${lock} in ${LOCK_WAIT_MS / 1000}s`);
      sleep(50);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

/** Keep parallel workers under one runner; serialize reading and publishing its PID. */
export function takeProbeRunLock(file, owner = process.ppid) {
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new Error('probe runner PID must be positive');
  return withResultsLock(file, () => {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8'));
      if (pid === owner) return;
      if (Number.isSafeInteger(pid) && pid > 0) {
        let alive = true;
        try { process.kill(pid, 0); } catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else if (error.code !== 'EPERM') throw error;
        }
        if (alive) throw new Error(`another user-search probe is running (pid ${pid}); one probe run at a time`);
      }
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, String(owner));
    renameSync(tmp, file);
  });
}

/**
 * Fold `groups` into the results file. `run` is { generatedAt, gitHead, watchedDigest, baseURL };
 * `groups` is { 'tenant:role': { persona: <entry>, probes: [...] } }; `catalogKeys` every group in the
 * catalog; `intents` the serialised catalog. Returns the file's top-level watchedDigest.
 */
export function mergeGroups(out, run, groups, catalogKeys, intents) {
  return withResultsLock(out, () => {
    const prior = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
    const ran = new Set(Object.keys(groups));
    const keep = (prior?.probes ?? []).filter((p) => !ran.has(`${p.tenant}:${p.role}`));
    const personas = { ...(prior?.personas ?? {}) };
    for (const [key, g] of Object.entries(groups)) personas[key] = { ...g.persona, watchedDigest: run.watchedDigest, probedAt: run.generatedAt };
    // A persona entry written before per-persona digests was probed on the file's old top-level digest.
    const legacy = prior?.watchedDigest ?? null;
    const digestOf = (k) => (personas[k] ? (personas[k].watchedDigest ?? legacy) : null);
    const digests = new Set(catalogKeys.map(digestOf));
    const agreed = digests.size === 1 && !digests.has(null) ? [...digests][0] : null;
    const thisRun = { generatedAt: run.generatedAt, gitHead: run.gitHead, watchedDigest: run.watchedDigest, personas: [...ran] };
    const runs = [...(prior?.runs ?? []).filter((r) => !(r.generatedAt === run.generatedAt && r.pid === run.pid)), { ...thisRun, ...(run.pid ? { pid: run.pid } : {}) }];
    const merged = {
      generatedAt: run.generatedAt, baseURL: run.baseURL, gitHead: run.gitHead,
      watchedDigest: agreed, runs, personas, intents,
      probes: [...keep, ...Object.values(groups).flatMap((g) => g.probes)],
    };
    const tmp = `${out}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 1) + '\n');
    renameSync(tmp, out);
    return agreed;
  });
}
