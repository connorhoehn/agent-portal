// The Runbooks demo director — `POST /api/__mock/scenario {"scenario":"runbooks-demo"}`.
//
// WHAT IT IS. A three-minute story about a runbook getting better because a
// run found a gap in it (script and copy: mock/runbooks-demo-script.ts):
//
//   1  Nora DaSilva sends Basil, an agent, at "Tenant-by-tenant cutover runbook
//      with rollback". The run's session brief is frozen with the SSO runbook
//      at v1 (lib/run-brief.ts freezeBrief — the step the dispatcher takes).
//   2  Basil hits redirect_mismatch, which the runbook lists as a symptom but
//      not a step, and files an edit: a new step before the callback is set.
//      Library → Proposals shows it, with the diff against v1.
//   3  Vera Green, who owns the runbook, opens the edit and accepts it with a
//      note — over HTTP as Vera, through the real `ReviewRunbook` gate, the
//      real stale-base check and the real store.
//   4  Nora sends Cleo at the refresh-loop bug. Cleo's box is given the org's
//      skill library with the SSO skill at v2, new step included (R8: procedures
//      reach a box only as skills; the brief records the library). The director
//      checks that, and says so in its state.
//
// WHAT IT WRITES, AND HOW. Briefs go through freezeBrief, the proposal through
// the store with the same lint and attribution the route gives a run's proposal
// (a box's signed envelope is the one thing an in-process director cannot
// present), and the decision through the real accept route.
//
// PACE. Every wait is a number of beats (RUNBOOKS_DEMO_PACE_MS, else
// DEMO_PACE_MS, default 10 s → ~2¾ minutes; 0 under jest).
//
// LIFECYCLE. Started by the scenario plane after it switches to
// `runbooks-demo`; stopped by any reset or other scenario. State:
// `GET /api/__mock/state` → `runbooksDemo`.
import { randomUUID } from 'node:crypto';
import { clock } from './core/index.js';
import { freezeBrief } from '../lib/run-brief.js';
import { runbookStore } from '../lib/runbooks/store-select.js';
import { findSimilar, lintRunbook, loadSkillLibrary, type RunbookProposal, type SessionBrief } from '../lib/runbooks/index.js';
import { repoLintContext } from '../lib/runbooks/repo-context.js';
import {
  ADDED_STEP_DO, BEATS, CAST, FIRST_RUN, RATIONALE, REVIEW_NOTE, RUNBOOK_ID, SECOND_RUN, beatMs, proposedDoc, type DemoRun,
} from './runbooks-demo-script.js';

export interface RunbooksDemoMilestones {
  /** The first run's brief is frozen with the runbook at its starting version. */
  firstBrief: boolean;
  /** The run filed its edit. */
  proposed: boolean;
  /** The owner accepted it. */
  accepted: boolean;
  /** The second run's brief is frozen. */
  secondBrief: boolean;
  /** …and it carries the accepted version, new step included. */
  secondBriefCarriesAccepted: boolean;
}

export interface BriefFacts { runRef: string; sha256: string; runbookVersion: number | null }

export interface RunbooksDemoState {
  phase: 'idle' | 'briefing' | 'proposing' | 'reviewing' | 'rebriefing' | 'done' | 'stopped' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  beatMs: number;
  milestones: RunbooksDemoMilestones;
  proposalId: string | null;
  /** The runbook version the review accepted. */
  acceptedVersion: number | null;
  first: BriefFacts | null;
  second: BriefFacts | null;
  errors: string[];
}

const NO_MILESTONES: RunbooksDemoMilestones = {
  firstBrief: false, proposed: false, accepted: false, secondBrief: false, secondBriefCarriesAccepted: false,
};

function freshState(): RunbooksDemoState {
  return {
    phase: 'idle', startedAt: null, finishedAt: null, beatMs: beatMs(),
    milestones: { ...NO_MILESTONES }, proposalId: null, acceptedVersion: null, first: null, second: null, errors: [],
  };
}

interface Signal { cancelled: boolean; wakers: Set<() => void> }
let state: RunbooksDemoState = freshState();
let current: { signal: Signal; done: Promise<void> } | null = null;

export function getRunbooksDemoState(): RunbooksDemoState {
  return JSON.parse(JSON.stringify(state)) as RunbooksDemoState;
}

export function stopRunbooksDemo(): void {
  if (!current) return;
  current.signal.cancelled = true;
  for (const wake of current.signal.wakers) wake();
  current.signal.wakers.clear();
  current = null;
  if (state.phase !== 'done' && state.phase !== 'failed') state.phase = 'stopped';
  state.finishedAt ??= clock.nowIso();
}

export function resetRunbooksDemo(): void {
  stopRunbooksDemo();
  state = freshState();
}

/** Start the story against the server at `baseUrl` (this process). Tests await the promise; the plane does not. */
export function startRunbooksDemo(baseUrl: string, opts: { paceMs?: number } = {}): Promise<void> {
  resetRunbooksDemo();
  if (opts.paceMs !== undefined) paceOverride = opts.paceMs;
  state.beatMs = pace();
  state.phase = 'briefing';
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

let paceOverride: number | null = null;
const pace = (): number => paceOverride ?? beatMs();

function sleepUntilBeat(beat: number, startedAt: number, signal: Signal): Promise<void> {
  const ms = Math.max(0, startedAt + beat * pace() - performance.now());
  if (ms === 0 || signal.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const wake = (): void => { clearTimeout(t); signal.wakers.delete(wake); resolve(); };
    const t = setTimeout(wake, ms);
    t.unref?.();
    signal.wakers.add(wake);
  });
}

// ─── HTTP, as Vera ──────────────────────────────────────────────────────────

class Client {
  private cookie = '';
  constructor(private readonly base: string) {}

  async login(userId: string): Promise<void> {
    const res = await fetch(`${this.base}/api/session/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId }),
    });
    if (!res.ok) throw new Error(`runbooks demo: could not sign in as ${userId} (${res.status})`);
    // The login clears any old cookie and then sets the new one: the last non-empty value per name wins.
    const jar = new Map<string, string>();
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) jar.set(name, value); else jar.delete(name);
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (!this.cookie) throw new Error('runbooks demo: the login answered without a session cookie');
  }

  async send(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: this.cookie },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed };
  }
}

// ─── The story ──────────────────────────────────────────────────────────────

/** R8: which version of the SSO skill the run's box was given (the library its brief recorded), and that skill's text. */
async function sso(brief: SessionBrief): Promise<{ version: number | null; text: string }> {
  const version = brief.skill_library?.skills.find((k) => k.name === RUNBOOK_ID)?.version ?? null;
  const lib = await loadSkillLibrary(runbookStore());
  const skill = lib.files.find((f) => f.path === `${RUNBOOK_ID}/SKILL.md`);
  return { version, text: skill?.content ?? '' };
}

async function dispatch(run: DemoRun): Promise<SessionBrief> {
  return freezeBrief({
    run_ref: run.runRef, box: 'devbox', work_item_id: run.workItemId, dispatched_by: CAST.nora.person,
  });
}

async function tell(baseUrl: string, signal: Signal): Promise<void> {
  const store = runbookStore();
  const t0 = performance.now();

  // 1 · Nora sends Basil; the brief it is handed carries v1.
  await sleepUntilBeat(FIRST_RUN.startBeat, t0, signal);
  if (signal.cancelled) return;
  const first = await dispatch(FIRST_RUN);
  const firstSso = await sso(first);
  if (firstSso.version === null) throw new Error(`runbooks demo: ${FIRST_RUN.agent}'s brief does not carry ${RUNBOOK_ID}`);
  state.first = { runRef: first.run_ref, sha256: first.sha256, runbookVersion: firstSso.version };
  state.milestones.firstBrief = true;

  // 2 · Basil files the edit.
  state.phase = 'proposing';
  await sleepUntilBeat(BEATS.propose, t0, signal);
  if (signal.cancelled) return;
  const target = await store.getRunbook(RUNBOOK_ID);
  if (!target) throw new Error(`runbooks demo: ${RUNBOOK_ID} is not in the store`);
  const proposed = proposedDoc();
  const proposal: RunbookProposal = {
    id: `prop-${randomUUID().slice(0, 12)}`,
    kind: 'edit', runbook_id: RUNBOOK_ID, base_version: target.current_version, proposed, rationale: RATIONALE,
    source: {
      kind: 'run', run_ref: FIRST_RUN.runRef, session_id: FIRST_RUN.sessionId, work_item_id: FIRST_RUN.workItemId,
      dispatched_by: CAST.nora.person, lab_experience_ids: [],
    },
    lint: lintRunbook(proposed, repoLintContext()),
    similar: findSimilar(proposed, target.scope, []),
    status: 'open', decided_by: null, decided_at: null, note: null, merged_into: null, created_at: clock.nowIso(),
  };
  await store.putProposal(proposal);
  state.proposalId = proposal.id;
  state.milestones.proposed = true;

  // 3 · Vera reads it, then accepts it.
  state.phase = 'reviewing';
  const vera = new Client(baseUrl);
  await vera.login(CAST.vera.user);
  await sleepUntilBeat(BEATS.open, t0, signal);
  if (signal.cancelled) return;
  const seen = await vera.send('GET', `/api/runbooks/proposals/${proposal.id}`);
  if (seen.status !== 200) throw new Error(`runbooks demo: ${CAST.vera.name} could not open the proposal (${seen.status})`);
  await sleepUntilBeat(BEATS.accept, t0, signal);
  if (signal.cancelled) return;
  const accepted = await vera.send('POST', `/api/runbooks/proposals/${proposal.id}/accept`, {
    note: REVIEW_NOTE, expected_version: target.current_version,
  });
  if (accepted.status !== 200) {
    throw new Error(`runbooks demo: accepting the edit answered ${accepted.status}: ${String(accepted.body['error'] ?? '')}`);
  }
  const version = accepted.body['version'] as { version?: number } | null;
  state.acceptedVersion = version?.version ?? null;
  state.milestones.accepted = true;

  // 4 · Nora sends Cleo; its brief carries the accepted version.
  state.phase = 'rebriefing';
  await sleepUntilBeat(SECOND_RUN.startBeat, t0, signal);
  if (signal.cancelled) return;
  const second = await dispatch(SECOND_RUN);
  const secondSso = await sso(second);
  state.second = { runRef: second.run_ref, sha256: second.sha256, runbookVersion: secondSso.version };
  state.milestones.secondBrief = true;
  state.milestones.secondBriefCarriesAccepted = secondSso.version !== null
    && secondSso.version === state.acceptedVersion && secondSso.text.includes(ADDED_STEP_DO);
  if (!state.milestones.secondBriefCarriesAccepted) {
    throw new Error(`runbooks demo: ${SECOND_RUN.agent}'s brief carries ${RUNBOOK_ID} v${secondSso.version ?? '?'}, not the accepted v${state.acceptedVersion ?? '?'}`);
  }
  state.phase = 'done';
  state.finishedAt = clock.nowIso();
}
