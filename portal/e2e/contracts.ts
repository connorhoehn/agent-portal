// Rendered-contract records (docs/journeys.md): what each sweep measured on
// each inventoried route, keyed by the inventory key. A journey log is stale
// when the contract of a route it walked changed since it was sealed — not
// when a source file under it was touched. The sweeps write here at the end
// of a COMPLETE run (a filtered run measures a subset and writes nothing):
//
//   docs/journeys/contracts/cascade.json     layout-cascade.spec.ts
//   docs/journeys/contracts/type-scale.json  type-scale-sweep.spec.ts
//   docs/journeys/contracts/rail.json        scripts/lib/rail-parity-measure.mjs (via the CLI below)
//
// Each file: { measured: { sourceDigest, at }, routes: { <key>: { value, changedAt } } }.
// `value` is categorical (which invariants fail, which off-scale sizes occur,
// MATCH or the rail problems) so a re-measurement of an unchanged page writes
// the same bytes; `changedAt` moves only when `value` does. `sourceDigest` is
// route-inventory.ts's digest of portal/src + the dependency pins, taken at
// the start and the end of the sweep — if the source moved mid-sweep the
// measurement is recorded as mixed, which the freshness rule reads as
// unmeasured.
//
//   node portal/e2e/contracts.ts write <sweep> <records.jsonl> <startDigest>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './route-sources.ts';
import { routeKey, sourceDigest } from './route-inventory.ts';

export const CONTRACT_DIR = path.join(REPO_ROOT, 'docs', 'journeys', 'contracts');
export type Sweep = 'cascade' | 'type-scale' | 'rail';

interface ContractFile { measured: { sourceDigest: string; at: string }; routes: Record<string, { value: unknown; changedAt: string }> }

/** Stable JSON: object keys sorted, so equal values serialise to equal bytes. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export function readContract(sweep: Sweep): ContractFile | null {
  try { return JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, `${sweep}.json`), 'utf8')) as ContractFile; } catch { return null; }
}

/** Record a complete sweep (the whole file is rewritten). `merge` keeps routes this call did not measure. */
export function writeContract(sweep: Sweep, routes: Record<string, unknown>, startDigest: string, merge = false) {
  const now = new Date().toISOString();
  const prev = readContract(sweep);
  const endDigest = sourceDigest();
  const next: ContractFile = {
    measured: { sourceDigest: startDigest === endDigest ? endDigest : `mixed:${startDigest}:${endDigest}`, at: now },
    routes: merge && prev ? { ...prev.routes } : {},
  };
  for (const key of Object.keys(routes).sort()) {
    const value = routes[key];
    const old = prev?.routes[key];
    next.routes[key] = { value, changedAt: old && canonical(old.value) === canonical(value) ? old.changedAt : now };
  }
  next.routes = Object.fromEntries(Object.entries(next.routes).sort(([a], [b]) => a.localeCompare(b)));
  fs.mkdirSync(CONTRACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONTRACT_DIR, `${sweep}.json`), `${JSON.stringify(next, null, 1)}\n`);
  return next.measured;
}

/**
 * A sweep's tests can land in different worker processes — Playwright starts
 * a fresh worker after any failing test, and module state does not survive
 * that — so each test records its part on disk, keyed by the run (the
 * workers' common parent process), and whichever worker finishes last writes
 * the contract once every part is there.
 */
const PARTIALS = path.join(CONTRACT_DIR, '.partial');
const runId = () => String(process.ppid);
export function recordPart(sweep: Sweep, part: string, routes: Record<string, unknown>, startDigest: string) {
  fs.mkdirSync(PARTIALS, { recursive: true });
  fs.writeFileSync(path.join(PARTIALS, `${sweep}.${runId()}.${part.replace(/[^\w-]/g, '_')}.json`), JSON.stringify({ part, startDigest, routes }));
}
/** Write the contract when every expected part of this run is recorded; return whether it was written. */
export function finishParts(sweep: Sweep, parts: readonly string[]): boolean {
  let names: string[] = [];
  try { names = fs.readdirSync(PARTIALS); } catch { return false; }
  const mine = names.filter((n) => n.startsWith(`${sweep}.${runId()}.`));
  const got = mine.map((n) => JSON.parse(fs.readFileSync(path.join(PARTIALS, n), 'utf8')) as { part: string; startDigest: string; routes: Record<string, unknown> });
  if (!parts.every((p) => got.some((g) => g.part === p))) return false;
  const starts = [...new Set(got.map((g) => g.startDigest))];
  writeContract(sweep, Object.assign({}, ...got.map((g) => g.routes)), starts.length === 1 ? starts[0]! : `mixed:${starts.join(':')}`);
  // This run's parts, and any a crashed earlier run left behind.
  for (const n of names.filter((x) => x.startsWith(`${sweep}.`))) fs.rmSync(path.join(PARTIALS, n), { force: true });
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, sweep, file, start] = process.argv.slice(2);
  if (cmd !== 'write' || !sweep || !file || !start) { process.stderr.write('usage: contracts.ts write <cascade|type-scale|rail> <records.jsonl> <startDigest>\n'); process.exit(2); }
  const routes: Record<string, unknown> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line) as { key: string; value: unknown };
    // A subject resolved from a minted fixture id (a library asset) is recorded under its pattern, not the id of the day.
    const k = routeKey(r.key);
    routes[k && k.includes(':') ? k : r.key] = r.value;
  }
  const m = writeContract(sweep as Sweep, routes, start);
  process.stdout.write(`${sweep}: ${Object.keys(routes).length} routes recorded (${m.sourceDigest.startsWith('mixed') ? 'MIXED — the source moved during the measurement' : 'source ' + m.sourceDigest.slice(0, 12)})\n`);
}
