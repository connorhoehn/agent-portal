// The skills demo director (R8) — `POST /api/__mock/scenario {"scenario":"runbooks-tools-demo"}`.
//
// WHAT IT IS. A two-minute story about a tool a run built becoming a skill
// every box has (script and copy: mock/runbooks-tools-demo-script.ts):
//
//   1  Vera sends Basil at the refresh loop on Auth Migration; its brief is
//      frozen with the org's skill library as it stands (no CDP harness yet).
//   2  Basil builds the websocket-over-CDP harness and keeps it in
//      `.lab/keep/rb-ws-cdp-debug/` (SKILL.md + scripts/ + data/), written into
//      a scratch workspace exactly as a box would leave it.
//   3  At run end the capture path reads the folder (lib/runbooks/keep.ts, the
//      same reading as `lab keep`) and files a new-skill proposal carrying the
//      files, attributed to the run and its dispatcher.
//   4  Nora, an SME on Auth Migration (the skill's area), opens it — procedure
//      and file diff — and accepts it over HTTP through the real ReviewRunbook
//      gate and steward rule. The library's sha moves.
//   5  Eli sends Dex at duplicate alerts on Observability. Dex's brief records
//      the new library; its box installs every skill (verifying each file's
//      sha and the set's), lists rb-ws-cdp-debug among them, and runs the
//      harness's offline check from the installed folder.
//
// WHAT RUNS. Step 5 executes the installed skill's Verify command — but only
// when the installed bundle is byte-identical to the seeded harness
// (mock/runbook-bundles), so the director never runs content it did not ship.
//
// PACE. RUNBOOKS_DEMO_PACE_MS, else DEMO_PACE_MS, default 10 s a beat; 0 under jest.
// LIFECYCLE. Started by the scenario plane; stopped by any reset or other
// scenario. State: `GET /api/__mock/state` → `runbooksToolsDemo`.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clock } from './core/index.js';
import { freezeBrief } from '../lib/run-brief.js';
import { runbookStore } from '../lib/runbooks/store-select.js';
import {
  bundleSha, filesOf, findSimilar, lintRunbook, loadSkillLibrary, parseSkill, renderRunbook, renderSkill, sha256Hex, skillDescription,
  type RunbookProposal, type SessionBrief, type SkillLibrary,
} from '../lib/runbooks/index.js';
import { readKeepFolder } from '../lib/runbooks/keep.js';
import { repoLintContext } from '../lib/runbooks/repo-context.js';
import { bundleFiles, cdpWebsocketDoc } from './runbook-bundles.js';
import { BEATS, BUILD_RUN, CAST, RAN_OK, REVIEW_NOTE, SKILL_ID, USE_RUN, beatMs, type ToolsDemoRun } from './runbooks-tools-demo-script.js';

export interface ToolsDemoMilestones {
  firstBrief: boolean;
  /** Basil left the harness in .lab/keep. */
  kept: boolean;
  /** The capture path filed it, files included. */
  proposed: boolean;
  /** An SME on the area accepted it. */
  accepted: boolean;
  /** The org library's sha moved. */
  libraryChanged: boolean;
  /** Dex's box (another initiative) installed the library with the new skill in it. */
  installed: boolean;
  /** …listed it, and ran the harness from the installed folder. */
  ranHarness: boolean;
}

export interface RunbooksToolsDemoState {
  phase: 'idle' | 'building' | 'proposing' | 'reviewing' | 'delivering' | 'done' | 'stopped' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  beatMs: number;
  milestones: ToolsDemoMilestones;
  proposalId: string | null;
  proposedFiles: string[];
  libraryBefore: string | null;
  libraryAfter: string | null;
  /** What Dex's box listed in its skills folder. */
  boxSkills: string[];
  /** The harness's last line of output on Dex's box. */
  harnessOutput: string | null;
  first: { runRef: string; initiative: string | null; sha256: string } | null;
  second: { runRef: string; initiative: string | null; sha256: string } | null;
  errors: string[];
}

const NONE: ToolsDemoMilestones = { firstBrief: false, kept: false, proposed: false, accepted: false, libraryChanged: false, installed: false, ranHarness: false };
function fresh(): RunbooksToolsDemoState {
  return {
    phase: 'idle', startedAt: null, finishedAt: null, beatMs: beatMs(), milestones: { ...NONE }, proposalId: null, proposedFiles: [],
    libraryBefore: null, libraryAfter: null, boxSkills: [], harnessOutput: null, first: null, second: null, errors: [],
  };
}

interface Signal { cancelled: boolean; wakers: Set<() => void> }
let state: RunbooksToolsDemoState = fresh();
let current: { signal: Signal; done: Promise<void> } | null = null;
let paceOverride: number | null = null;
const pace = (): number => paceOverride ?? beatMs();

export function getRunbooksToolsDemoState(): RunbooksToolsDemoState { return JSON.parse(JSON.stringify(state)) as RunbooksToolsDemoState; }

export function stopRunbooksToolsDemo(): void {
  if (!current) return;
  current.signal.cancelled = true;
  for (const wake of current.signal.wakers) wake();
  current.signal.wakers.clear();
  current = null;
  if (state.phase !== 'done' && state.phase !== 'failed') state.phase = 'stopped';
  state.finishedAt ??= clock.nowIso();
}

export function resetRunbooksToolsDemo(): void { stopRunbooksToolsDemo(); state = fresh(); }

export function startRunbooksToolsDemo(baseUrl: string, opts: { paceMs?: number } = {}): Promise<void> {
  resetRunbooksToolsDemo();
  if (opts.paceMs !== undefined) paceOverride = opts.paceMs;
  state.beatMs = pace();
  state.phase = 'building';
  state.startedAt = clock.nowIso();
  const signal: Signal = { cancelled: false, wakers: new Set() };
  const done = tell(baseUrl, signal).catch((err: unknown) => {
    if (signal.cancelled) return;
    state.errors.push((err as Error).message);
    state.phase = 'failed';
  }).finally(() => {
    paceOverride = null;
    if (signal.cancelled) return;
    state.finishedAt ??= clock.nowIso();
    if (current?.done === done) current = null;
  });
  current = { signal, done };
  return done;
}

function sleepUntilBeat(beat: number, t0: number, signal: Signal): Promise<void> {
  const ms = Math.max(0, t0 + beat * pace() - performance.now());
  if (ms === 0 || signal.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = (): void => { clearTimeout(t); signal.wakers.delete(wake); resolve(); };
    const t = setTimeout(wake, ms);
    t.unref?.();
    signal.wakers.add(wake);
  });
}

/** Sign in as a cast member and speak HTTP as them (the accept goes through the real gate). */
async function as(base: string, userId: string): Promise<(method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>> {
  const login = await fetch(`${base}/api/session/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }) });
  if (!login.ok) throw new Error(`skills demo: could not sign in as ${userId} (${login.status})`);
  const jar = new Map<string, string>();
  for (const line of login.headers.getSetCookie?.() ?? []) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const v = pair.slice(eq + 1).trim();
    if (v) jar.set(pair.slice(0, eq).trim(), v); else jar.delete(pair.slice(0, eq).trim());
  }
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  };
}

const dispatch = (run: ToolsDemoRun): Promise<SessionBrief> =>
  freezeBrief({ run_ref: run.runRef, box: 'devbox', work_item_id: run.workItemId, dispatched_by: run.by });

/** Basil's workspace: the harness left in .lab/keep/<skill>/ as a box would leave it. */
function keepHarness(ws: string): string {
  const tool = join(ws, '.lab', 'keep', SKILL_ID);
  mkdirSync(tool, { recursive: true });
  writeFileSync(join(tool, 'SKILL.md'), renderSkill(SKILL_ID, cdpWebsocketDoc));
  for (const f of bundleFiles(SKILL_ID)) {
    mkdirSync(dirname(join(tool, f.path)), { recursive: true });
    writeFileSync(join(tool, f.path), f.content, { mode: parseInt(f.mode, 8) });
  }
  return join(ws, '.lab', 'keep');
}

/** Dex's box: install the library, checking every file's sha and the set's, as `lab skills` does. */
function installLibrary(lib: SkillLibrary, dir: string): string[] {
  for (const f of lib.files) {
    if (sha256Hex(f.content) !== f.sha256) throw new Error(`skills demo: ${f.path} does not match its sha256`);
    const dest = join(dir, ...f.path.split('/'));
    if (!dest.startsWith(dir + '/')) throw new Error(`skills demo: ${f.path} leaves the skills folder`);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content, { mode: parseInt(f.mode, 8) });
  }
  return readdirSync(dir).filter((n) => existsSync(join(dir, n, 'SKILL.md'))).sort();
}

function run(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', cmd], { cwd, timeout: 20_000, env: { PATH: process.env['PATH'] ?? '' } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function tell(base: string, signal: Signal): Promise<void> {
  const store = runbookStore();
  const t0 = performance.now();
  const ws = mkdtempSync(join(tmpdir(), 'skills-demo-'));
  try {
    // 1 · Vera sends Basil; the library has no CDP harness yet.
    await sleepUntilBeat(BUILD_RUN.startBeat, t0, signal);
    if (signal.cancelled) return;
    const first = await dispatch(BUILD_RUN);
    if (first.skill_library?.skills.some((k) => k.name === SKILL_ID)) throw new Error(`skills demo: ${SKILL_ID} is already in the library; start from the runbooks-tools-demo world`);
    state.first = { runRef: first.run_ref, initiative: first.initiative_id, sha256: first.sha256 };
    state.libraryBefore = first.skill_library?.sha256 ?? null;
    state.milestones.firstBrief = true;

    // 2 · Basil keeps the harness.
    await sleepUntilBeat(BEATS.keep, t0, signal);
    if (signal.cancelled) return;
    const keepDir = keepHarness(ws);
    state.milestones.kept = true;

    // 3 · Run end: the capture path files it, files included, attributed from the run's brief.
    state.phase = 'proposing';
    await sleepUntilBeat(BEATS.propose, t0, signal);
    if (signal.cancelled) return;
    const [kept] = readKeepFolder(keepDir, { runRef: BUILD_RUN.runRef, sessionId: BUILD_RUN.sessionId });
    if (!kept?.body) throw new Error(`skills demo: the kept folder was not sendable: ${(kept?.problems ?? []).join('; ')}`);
    const parsed = parseSkill(kept.body.skill_md);
    if (!parsed.ok) throw new Error('skills demo: the kept SKILL.md does not parse');
    const files = filesOf(kept.body.files);
    const lib0 = await loadSkillLibrary(store);
    const others = lib0.skills.map((k) => ({ name: k.name, description: k.description }));
    const proposal: RunbookProposal = {
      id: `prop-${randomUUID().slice(0, 12)}`,
      kind: 'new', runbook_id: null, base_version: null, proposed: parsed.doc, proposed_files: files, proposed_id: SKILL_ID,
      rationale: kept.body.rationale,
      source: { kind: 'run', run_ref: BUILD_RUN.runRef, session_id: BUILD_RUN.sessionId, work_item_id: BUILD_RUN.workItemId, dispatched_by: BUILD_RUN.by, lab_experience_ids: [] },
      lint: lintRunbook(parsed.doc, { ...repoLintContext(), files, skill: { name: SKILL_ID, others } }),
      similar: findSimilar(parsed.doc, { kind: 'org', ref: null }, []),
      status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: clock.nowIso(),
    };
    if (proposal.lint.some((f) => f.severity === 'error')) throw new Error(`skills demo: the kept harness has lint errors: ${proposal.lint.map((f) => f.rule).join(', ')}`);
    await store.putProposal(proposal);
    state.proposalId = proposal.id;
    state.proposedFiles = files.map((f) => f.path);
    state.milestones.proposed = true;

    // 4 · Nora (an SME on Auth Migration, the skill's area) reads it and accepts it.
    state.phase = 'reviewing';
    const nora = await as(base, CAST.nora.user);
    await sleepUntilBeat(BEATS.open, t0, signal);
    if (signal.cancelled) return;
    const seen = await nora('GET', `/api/runbooks/proposals/${proposal.id}`);
    if (seen.status !== 200) throw new Error(`skills demo: ${CAST.nora.name} could not open the proposal (${seen.status})`);
    await sleepUntilBeat(BEATS.accept, t0, signal);
    if (signal.cancelled) return;
    // She read the scripts it carries (the page shows each in full), and says so by path and sha256.
    const scriptsRead = (seen.body['scripts_to_read'] ?? []) as Array<{ path: string; sha256: string }>;
    const accepted = await nora('POST', `/api/runbooks/proposals/${proposal.id}/accept`, { note: REVIEW_NOTE, scripts_read: scriptsRead });
    if (accepted.status !== 201) throw new Error(`skills demo: accepting the skill answered ${accepted.status}: ${String(accepted.body['error'] ?? '')}`);
    state.milestones.accepted = true;

    // 5 · Eli sends Dex at Observability work; the box installs the new library and runs the harness.
    state.phase = 'delivering';
    await sleepUntilBeat(USE_RUN.startBeat, t0, signal);
    if (signal.cancelled) return;
    const second = await dispatch(USE_RUN);
    state.second = { runRef: second.run_ref, initiative: second.initiative_id, sha256: second.sha256 };
    state.libraryAfter = second.skill_library?.sha256 ?? null;
    state.milestones.libraryChanged = !!state.libraryAfter && state.libraryAfter !== state.libraryBefore;
    const lib = await loadSkillLibrary(store);
    if (lib.sha256 !== state.libraryAfter) throw new Error('skills demo: the library moved between the brief and the box');
    const skillsDir = join(ws, 'dex-home', '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    state.boxSkills = installLibrary(lib, skillsDir);
    state.milestones.installed = state.boxSkills.includes(SKILL_ID);
    const installed = lib.skills.find((k) => k.name === SKILL_ID);
    const shipped = bundleSha(sha256Hex(renderRunbook(cdpWebsocketDoc)), bundleFiles(SKILL_ID));
    // Run only what this demo shipped: the accepted bundle must be the seeded harness, byte for byte.
    if (!installed || installed.sha256 !== shipped) throw new Error('skills demo: the installed harness is not the one the demo shipped; not running it');
    if (installed.description !== skillDescription(cdpWebsocketDoc)) throw new Error('skills demo: the installed skill describes itself differently');
    const out = await run(cdpWebsocketDoc.verify[0]!.command!.text, join(skillsDir, SKILL_ID));
    state.harnessOutput = out.trim().split('\n').pop() ?? '';
    state.milestones.ranHarness = state.harnessOutput === RAN_OK;
    if (!state.milestones.ranHarness) throw new Error(`skills demo: the harness printed ${state.harnessOutput}`);
    state.phase = 'done';
    state.finishedAt = clock.nowIso();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}
