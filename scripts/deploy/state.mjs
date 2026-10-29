// DE-14: the run record. `.scratch/deploy/<env>/state.json` is a RECORD, not
// the authority — the live account decides what is done (orchestrate.mjs
// `planDeploy`); the file only saves time (an input key that still matches)
// and keeps the history. Every write goes to a temp file then a rename, so an
// interrupted run cannot leave a torn file; a torn or foreign file is rejected
// and the probes decide alone.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { REPO_ROOT, PHASE_IDS } from './phases.mjs';

export const STATE_SCHEMA_VERSION = 1;
export const PHASE_STATUSES = new Set(['running', 'done', 'failed']);

export const stateFile = (envName, root = REPO_ROOT) => resolve(root, '.scratch/deploy', envName, 'state.json');
export const lastRunParameter = (prefix) => `/${prefix}/deploy/last-run`;
export const lockParameter = (prefix) => `/${prefix}/deploy/lock`;

/**
 * Validate a parsed state document. Returns `{ ok: true, state }` or
 * `{ ok: false, reason }`; the caller treats a rejected file as absent.
 */
export function validateState(doc, envName) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'not an object' };
  if (doc.schemaVersion !== STATE_SCHEMA_VERSION) return { ok: false, reason: `schemaVersion ${doc.schemaVersion} (want ${STATE_SCHEMA_VERSION})` };
  if (doc.env !== envName) return { ok: false, reason: `env "${doc.env}" is not "${envName}"` };
  if (typeof doc.account !== 'string' || !/^\d{12}$/.test(doc.account)) return { ok: false, reason: 'account missing' };
  if (typeof doc.commit !== 'string' || !/^[a-f0-9]{40}$/.test(doc.commit)) return { ok: false, reason: 'commit is not a full sha' };
  if (!doc.phases || typeof doc.phases !== 'object' || Array.isArray(doc.phases)) return { ok: false, reason: 'phases missing' };
  for (const [id, p] of Object.entries(doc.phases)) {
    if (!PHASE_IDS.includes(id)) return { ok: false, reason: `unknown phase "${id}"` };
    if (!p || typeof p !== 'object' || !PHASE_STATUSES.has(p.status)) return { ok: false, reason: `phase ${id}: bad status` };
    if (p.status === 'done' && typeof p.inputKey !== 'string') return { ok: false, reason: `phase ${id}: done without an inputKey` };
  }
  return { ok: true, state: doc };
}

/** Read and validate; `{ state: null, reason }` when absent or rejected. */
export function readState(file, envName) {
  if (!existsSync(file)) return { state: null, reason: 'no state file' };
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { state: null, reason: `unreadable (${err.message.split('\n')[0]}); the probes decide` };
  }
  const v = validateState(doc, envName);
  return v.ok ? { state: v.state, reason: null } : { state: null, reason: `rejected: ${v.reason}; the probes decide` };
}

/** Atomic: temp file in the same directory, then rename. */
export function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

export function newState({ env, account, commit, runId }) {
  return { schemaVersion: STATE_SCHEMA_VERSION, env: env.name, account, region: env.region, runId, commit, phases: {} };
}

/**
 * The input key: the git tree hash of every path the phase builds (at HEAD,
 * `absent` for a path that is not in the tree) plus the context it passes.
 * The same tree and context on another machine give the same key, so a lost
 * state file re-derives the same plan.
 */
export function inputKey(paths, context, { treeHash = gitTreeHash } = {}) {
  const h = createHash('sha1');
  for (const p of paths) h.update(`${p}=${treeHash(p)}\n`);
  h.update(`context=${JSON.stringify(context ?? {})}`);
  return h.digest('hex').slice(0, 16);
}

export function gitTreeHash(path, root = REPO_ROOT) {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', `HEAD:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'absent';
  }
}

export function gitHead(root = REPO_ROOT) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

/** Paths among `paths` with uncommitted changes (porcelain), for the clean-tree rule. */
export function dirtyPaths(paths, root = REPO_ROOT) {
  if (!paths.length) return [];
  const out = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...paths], { encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(Boolean).map((l) => l.slice(3).trim()))];
}

export const runId = (now = new Date(), commit = '0'.repeat(40)) => `${now.toISOString().replace(/\.\d{3}Z$/, 'Z')}-${commit.slice(0, 8)}`;
