// The microVM runner's dispatcher half (docs/microvm-runner-design.md §3, §6,
// §7, §9, §10, §11, and the dispatcher-side lines of §15).
//
// AgentCore, GitHub, the user directory and the brief are fakes; the ledger,
// the spend holds, the credential audit and the session rows are the REAL
// providers on their offline (MOCK_AURORA) stores, so "the hold settled" and
// "every mint wrote a row" are read back from the tables, not from a spy.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } } }));

import { TextEncoder } from 'node:util';
import { recordSpend, mockStoredEntries } from '../../providers/spend-ledger.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { credentialIssues } from '../../mock/credential-issues.js';
import { microvmSessions } from '../../mock/microvm-sessions.js';
import { agentProjectRuns } from '../../mock/agent-project-runs.js';
import { startRun, finishRun } from '../../providers/agent-projects.js';
import { recordCredentialIssue, listCredentialIssues } from '../../providers/credential-issues.js';
import {
  insertMicrovmSession, updateMicrovmSession, latestSessionForJob, countLiveSessionsForActor, listLiveSessions, pushedHeadForJob,
} from '../../providers/microvm-sessions.js';
import { mintAuditedRepoToken, _setRepoTokenProvider, LocalFakeTokenProvider } from '../repo-token-provider.js';
import { presignS3 } from '../microvm-invoke.js';
import { microvmConfig, loadMicrovmParameters, _resetMicrovmParameters } from '../microvm-config.js';
import { microvmSessionId, MIN_SESSION_ID_LENGTH, microvmBranch } from '../microvm-ids.js';
import {
  judgeMicrovmJob, runMicrovmAttempt, microvmDispatchPass, sweepMicrovmOverruns, tokenCostFromEnd,
  microvmHoldExpiresInMs, startMicrovmRunner, _resetMicrovmStart, _resetLearnedWorkspaceRoots, workspaceRootFor,
  fitsRuntimeLifetime, BOOT_ALLOWANCE_MS, HELD_BACK_MEMORY_MAX, _heldBackMemorySize,
  type MicrovmDeps,
} from '../microvm-dispatcher.js';
import type { ClaimedAgentJob, AgentJob } from '../../providers/agent-jobs.js';
import type { SpendHold } from '../../providers/spend-holds.js';
import type { DevboxProfile } from '../devbox-profile.js';
import type { AgentProject } from '../../providers/agent-projects.js';

const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orgiq_microvm-abc';
const AP_ID = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';
const LIB_SHA = 'a'.repeat(64);
const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const CLAUDE_SID = '0b6f9a2e-1c3d-4e5f-8a7b-9c0d1e2f3a4b';
const USER_TOKEN = 'ghu_THE_ACTORS_OWN_TOKEN_never_in_a_payload';
const PROMPT = 'Refactor the token refresh path so it retries once on a 401 from the identity provider.';
const ENV = {
  MICROVM_RUNTIME_ARN: ARN, MICROVM_RUNS_BUCKET: 'orgiq-microvm-runs-111122223333-us-east-1',
  MICROVM_COMPUTE_USD_PER_SECOND: '0.001', LAB_CALLBACK_SECRET: 'fleet-secret-value', PROJECT_PREFIX: 'orgiq',
};

const PROFILE: DevboxProfile = {
  id: 'restricted', version: 1, models: ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'us.anthropic.claude-sonnet-5'],
  task_timeout_s: 840, idle_minutes: 5, max_lifetime_minutes: 60, network_class: 'egress-allowlist', org_access: 'none',
  created_by: 'seed', reason: '', created_at: '',
};
const PROJECT: AgentProject = {
  id: AP_ID, repoFullName: 'acme/widgets', orgProjectId: 'p-auth', orgProjectName: 'Auth', owners: [],
  defaultBranch: 'main', connectionName: null, sessionId: null, workspacePath: '/mnt/workspace', clonedAt: null, createdAt: '',
};

function job(over: Partial<ClaimedAgentJob> = {}): ClaimedAgentJob {
  return {
    id: 'job-6c1d2e3f-4a5b-4c6d-8e7f-001122334455', kind: 'devbox:task', title: 'Retry token refresh once',
    payload: { prompt: PROMPT, initiativeId: 'p-auth', requiresReview: true }, status: 'claimed', priority: 100,
    boxId: null, sessionId: null, attempts: 1, maxAttempts: 2, result: null, error: null, createdBy: 'u-nora',
    createdAt: '', claimedAt: '', startedAt: null, finishedAt: null, botId: null, botName: null, botTrigger: null,
    runner: 'microvm', actorSub: 'u-nora', resumeOfJobId: null, claimToken: 'clm_private', ...over,
  };
}

// ─── A fake AgentCore: records every invoke payload, answers by op ────────────

interface Invoke { sessionId: string; arn: string; payload: Record<string, unknown> }

function sse(events: Array<Record<string, unknown>>): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  return (async function* () { for (const ev of events) yield enc.encode(`data: ${JSON.stringify(ev)}\n`); })();
}

const RESULT = {
  type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: 'Retry added.', session_id: CLAUDE_SID,
  total_cost_usd: 0.12, usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000 },
};
const END = {
  type: 'devbox_end', exit_code: 0, fresh_tokens: 1500, timed_out: false, killed_reason: null, stderr: '',
  usage: { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 0, cacheReadTokens: 2000 },
  head_sha: HEAD, claude_session_id: CLAUDE_SID, duration_ms: 4000, transcript_uploaded: true, reported_cost_usd: 0.12,
};
const TASK_EVENTS: Array<Record<string, unknown>> = [
  { type: 'devbox_start', model: PROFILE.models[0] },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/refresh.ts' } }] } },
  RESULT, END,
];

type Answer = unknown | ((payload: Record<string, unknown>, nth: number) => unknown);

function fakeAgentCore(answers: Partial<Record<'boot' | 'task' | 'push', Answer>> = {}) {
  const seen: Record<string, number> = {};
  const invokes: Invoke[] = [];
  const client = {
    send: jest.fn(async (cmd: { input: { runtimeSessionId: string; agentRuntimeArn: string; payload: Uint8Array } }) => {
      const payload = JSON.parse(Buffer.from(cmd.input.payload).toString('utf8')) as Record<string, unknown>;
      invokes.push({ sessionId: cmd.input.runtimeSessionId, arn: cmd.input.agentRuntimeArn, payload });
      const op = payload['op'] as 'boot' | 'task' | 'push';
      seen[op] = (seen[op] ?? 0) + 1;
      const given = answers[op];
      const answer = (typeof given === 'function' ? (given as (p: Record<string, unknown>, n: number) => unknown)(payload, seen[op]!) : given) ?? (op === 'boot'
        ? { ok: true, head_sha: BASE, library_sha_ok: true, booted_at: '2026-11-07T00:00:00Z' }
        : op === 'push' ? { ok: true, head_sha: HEAD, pushed: true } : TASK_EVENTS);
      return { response: sse(Array.isArray(answer) ? answer as Array<Record<string, unknown>> : [answer as Record<string, unknown>]) };
    }),
  };
  return { client, invokes };
}

// ─── The deps: fakes outside, real offline stores inside ──────────────────────

interface Harness { deps: MicrovmDeps; order: string[]; invokes: Invoke[]; client: ReturnType<typeof fakeAgentCore>['client']; tokens: LocalFakeTokenProvider; calls: Record<string, jest.Mock> }

function harness(over: Partial<MicrovmDeps> = {}, answers: Parameters<typeof fakeAgentCore>[0] = {}, env: Record<string, string> = ENV): Harness {
  const order: string[] = [];
  const { client, invokes } = fakeAgentCore(answers);
  let t = Date.parse('2026-11-07T10:00:00Z');
  const tokens = new LocalFakeTokenProvider(() => t);
  _setRepoTokenProvider(tokens);
  const calls: Record<string, jest.Mock> = {
    unclaim: jest.fn(async () => true),
    completeJob: jest.fn(async () => true),
    markRunning: jest.fn(async () => true),
    stopSession: jest.fn(async (_arn: string, sid: string) => { order.push(`stop:${sid}`); }),
    openPullRequest: jest.fn(async () => { order.push('pr'); return { url: 'https://github.com/acme/widgets/pull/7', number: 7 }; }),
    reserveSpend: jest.fn(async (i: { initiativeId: string | null; source: string; sourceId?: string | null; forecast: { costUsdP75: number } }) => {
      const hold: SpendHold = {
        id: '9d1c2b3a-0000-4000-8000-000000000001', initiativeId: i.initiativeId, grantId: null, actorId: 'u-nora',
        source: i.source as SpendHold['source'], sourceId: i.sourceId ?? null, amountUsd: i.forecast.costUsdP75, basis: 'p75',
        essential: false, status: 'held', expiresAt: new Date(t + 35 * 60_000).toISOString(), createdBy: 'u-nora',
        createdAt: new Date(t).toISOString(), closedAt: null,
      };
      spendHolds.rows().push(hold);
      return { kind: 'held', holdId: hold.id, initiativeId: i.initiativeId, grantId: null, amountUsd: hold.amountUsd };
    }),
    releaseHold: jest.fn(async () => undefined),
    emitMetric: jest.fn(),
    log: jest.fn(),
    readUserToken: jest.fn(async () => { order.push('user-token'); return USER_TOKEN; }),
  };
  const deps: MicrovmDeps = {
    config: () => microvmConfig({ ...env }),
    now: () => (t += 1500),
    staleMinutes: 30,
    claimNext: jest.fn(async () => null),
    unclaim: calls.unclaim!,
    stampPlacement: jest.fn(async () => true),
    markRunning: calls.markRunning!,
    completeJob: calls.completeJob!,
    getJobFacts: jest.fn(async () => null),
    maintainAttempt: jest.fn(async () => {
      const c = new AbortController();
      return { signal: c.signal, assertLive: () => c.signal.throwIfAborted(), run: <T,>(w: () => Promise<T>) => w(), stop: () => c.abort() };
    }),
    getUser: jest.fn(async (sub: string) => ({ id: sub, grants: { orgiq: ['sme'] } })),
    stewardsInitiative: jest.fn(async () => true),
    profileFor: jest.fn(async () => PROFILE),
    listCodebases: jest.fn(async () => [PROJECT]),
    repoCredentialAvailable: jest.fn(async () => true),
    githubGrant: jest.fn(async (sub: string) => ({
      user_sub: sub, tenant: 'orgiq', github_login: 'nora-gh', github_user_id: 42,
      noreply_email: '42+nora-gh@users.noreply.github.com',
      secret_arn: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:orgiq/github-user/u-nora-AbCdEf',
      scopes: ['repo'], granted_at: '', refreshed_at: null, revoked_at: null,
    })),
    readUserToken: calls.readUserToken!,
    fleetPaused: jest.fn(async () => false),
    saturatedInitiatives: jest.fn(async () => []),
    releaseRunSlots: jest.fn(async () => undefined),
    insertSession: (row) => insertMicrovmSession(row),
    updateSession: (id, p) => updateMicrovmSession(id, p),
    latestSessionForJob: (id) => latestSessionForJob(id),
    pushedHeadForJob: (id, before) => pushedHeadForJob(id, before),
    startProjectRun: (i) => startRun({ ...i, runner: 'microvm' }),
    finishProjectRun: (id, o) => finishRun(id, o),
    countLiveSessions: (sub) => countLiveSessionsForActor(sub),
    listLiveSessions: () => listLiveSessions(),
    computeSecondsP75: jest.fn(async () => null),
    reserveSpend: calls.reserveSpend as unknown as MicrovmDeps['reserveSpend'],
    forecastP75ForModel: jest.fn(async () => ({ costUsdP75: 0.5, costUsdP25: 0.2, confidence: 'prior' as const })),
    meterForHold: jest.fn(async () => null),
    releaseHold: calls.releaseHold!,
    recordSpend: (i) => recordSpend(i),
    estimateCost: () => 0.11,
    freezeBrief: jest.fn(async (j) => ({
      brief: { id: `brief-${j.id}`, run_ref: j.id, sha256: 'b'.repeat(64), skill_library: { sha256: LIB_SHA, dir: '~/.claude/skills', skills: [] } } as never,
      run: { run_ref: j.id, run_token: `runtok-${j.id}`, brief_id: `brief-${j.id}`, brief_sha: 'b'.repeat(64), work_item_id: null, initiative_id: 'p-auth', repo: null },
    })),
    mintRepoToken: (r, p, c) => mintAuditedRepoToken(r, p, c),
    recordCredentialIssue: (i) => recordCredentialIssue(i),
    presign: (i) => presignS3({ ...i, credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' } }),
    client: () => client as never,
    stopSession: calls.stopSession as unknown as MicrovmDeps['stopSession'],
    registerBox: jest.fn(),
    appendEvent: jest.fn(),
    removeBox: jest.fn(),
    openPullRequest: calls.openPullRequest as unknown as MicrovmDeps['openPullRequest'],
    emitMetric: calls.emitMetric!,
    emitJob: jest.fn(),
    log: calls.log!,
    ...over,
  };
  client.send.mockImplementation(((orig) => async (cmd: never) => {
    const p = JSON.parse(Buffer.from((cmd as { input: { payload: Uint8Array } }).input.payload).toString('utf8')) as { op: string };
    order.push(`invoke:${p.op}`);
    return orig(cmd);
  })(client.send.getMockImplementation()!) as never);
  return { deps, order, invokes, client, tokens, calls };
}

async function judgeAndRun(h: Harness, j: ClaimedAgentJob = job()): Promise<void> {
  const v = await judgeMicrovmJob(j, h.deps, { saturated: [] });
  if (!v.ok) throw new Error(`held back: ${v.reason}`);
  await runMicrovmAttempt(j, v.plan, h.deps);
}

beforeEach(() => {
  spendHolds.reset(); spendEntries.reset(); credentialIssues.reset(); microvmSessions.reset(); agentProjectRuns.reset();
  _resetLearnedWorkspaceRoots(); _resetMicrovmParameters(); _resetMicrovmStart();
});
afterAll(() => _setRepoTokenProvider(null));

// ─── Session ids (§2, §15 line 1) ─────────────────────────────────────────────

describe('derived session ids', () => {
  const parts = { tenant: 'orgiq', agentProjectId: AP_ID, jobId: 'job-6c1d2e3f-4a5b', attempt: 1 };

  it('differ for two actors on one project and job, and are at least 33 characters', () => {
    const a = microvmSessionId({ ...parts, actorSub: 'u-nora' });
    const b = microvmSessionId({ ...parts, actorSub: 'u-omar' });
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(MIN_SESSION_ID_LENGTH);
    expect(a).toMatch(/^mvm1-[0-9a-f]{16}-3f2a9c1e-7b4-job-6c1d2e3f-1$/);
  });

  it('give the same actor\'s next attempt a fresh session', () => {
    expect(microvmSessionId({ ...parts, actorSub: 'u-nora', attempt: 2 })).not.toBe(microvmSessionId({ ...parts, actorSub: 'u-nora' }));
  });

  it('refuse to mint an id under 33 characters or without an actor', () => {
    expect(() => microvmSessionId({ tenant: 'orgiq', actorSub: 'u', agentProjectId: 'a', jobId: 'j', attempt: 1 })).toThrow(/33/);
    expect(() => microvmSessionId({ ...parts, actorSub: '' })).toThrow(/actor/);
  });

  it('branch under orgiq/<sub8>/<job8>', () => {
    expect(microvmBranch('orgiq', 'u-nora', 'job-6c1d2e3f-4a5b')).toBe('orgiq/unora/6c1d2e3f');
  });
});

// ─── §10: the checks, each a named held_back ─────────────────────────────────

describe('preflight (§10)', () => {
  it('fails closed with no runtime ARN: every microvm job waits as no-microvm-runtime, nothing is invoked', async () => {
    const { MICROVM_RUNTIME_ARN: _drop, ...noArn } = ENV;
    const h = harness({}, {}, noArn);
    const claims = [job({ id: 'job-a1' }), job({ id: 'job-b2', actorSub: null })];
    (h.deps.claimNext as jest.Mock).mockImplementation(async () => claims.shift() ?? null);
    const out = await microvmDispatchPass(h.deps);
    expect(out).toEqual({ claimed: 2, started: 0, heldBack: 2 });
    expect(h.calls.unclaim).toHaveBeenCalledWith('job-a1', 'clm_private');
    expect(h.calls.unclaim).toHaveBeenCalledWith('job-b2', 'clm_private');
    expect(h.calls.emitMetric).toHaveBeenCalledWith('microvm-held-back', expect.objectContaining({ reason: 'no-microvm-runtime' }));
    expect(h.client.send).not.toHaveBeenCalled();
    expect(h.calls.reserveSpend).not.toHaveBeenCalled();
  });

  it.each([
    ['no-actor', { actorSub: null }],
    ['payload-resume', { payload: { prompt: 'x', initiativeId: 'p-auth', resume: true } }],
    ['payload-box', { payload: { prompt: 'x', initiativeId: 'p-auth', boxId: 'box-1' } }],
    ['bot-owned-job', { botId: 'bot-1' }],
    ['not-microvm-task', { runner: 'fleet' as const }],
  ])('holds back %s', async (reason, over) => {
    const v = await judgeMicrovmJob(job(over as Partial<ClaimedAgentJob>), harness().deps, { saturated: [] });
    expect(v).toEqual({ ok: false, reason });
  });

  it('names each failing check', async () => {
    const cases: Array<[string, Partial<MicrovmDeps>]> = [
      ['actor-unknown', { getUser: async () => null }],
      ['actor-not-in-tenant', { getUser: async (sub) => ({ id: sub, grants: { social: ['member'] } }) }],
      ['actor-not-on-initiative', { stewardsInitiative: async () => false }],
      ['profile-not-egress-allowlist', { profileFor: async () => ({ ...PROFILE, network_class: 'public' }) }],
      ['no-codebase', { listCodebases: async () => [] }],
      ['ambiguous-codebase', { listCodebases: async () => [PROJECT, { ...PROJECT, id: 'other', repoFullName: 'acme/other' }] }],
      ['no-repo-credential', { repoCredentialAvailable: async () => false }],
      ['no-github-identity', { githubGrant: async () => null }],
      ['fleet-paused', { fleetPaused: async () => true }],
      ['actor-session-limit', { countLiveSessions: async () => 2 }],
    ];
    for (const [reason, over] of cases) {
      expect([reason, await judgeMicrovmJob(job(), harness(over).deps, { saturated: [] })]).toEqual([reason, { ok: false, reason }]);
    }
    expect(await judgeMicrovmJob(job({ payload: { prompt: 'x', initiativeId: 'p-auth', model: 'us.anthropic.claude-opus-4-8' } }), harness().deps, { saturated: [] }))
      .toEqual({ ok: false, reason: 'model-not-allowed' });
    expect(await judgeMicrovmJob(job(), harness().deps, { saturated: ['p-auth'] })).toEqual({ ok: false, reason: 'initiative-saturated' });
  });

  it('holds back a cross-actor resume_of_job_id as resume-cross-actor before reserveSpend is called', async () => {
    const original: AgentJob = { ...job({ id: 'job-orig-0001', actorSub: 'u-omar', status: 'awaiting_review' }), finishedAt: new Date().toISOString() };
    const h = harness({ getJobFacts: jest.fn(async () => original) });
    const claims = [job({ resumeOfJobId: 'job-orig-0001' })];
    (h.deps.claimNext as jest.Mock).mockImplementation(async () => claims.shift() ?? null);
    await microvmDispatchPass(h.deps);
    expect(h.calls.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'held_back', reason: 'resume-cross-actor' }));
    expect(h.calls.reserveSpend).not.toHaveBeenCalled();
    expect(h.client.send).not.toHaveBeenCalled();
    expect(h.calls.unclaim).toHaveBeenCalledTimes(1);
  });

  it('a reserveSpend that is not held makes zero InvokeAgentRuntime calls and hands the attempt back', async () => {
    const h = harness({
      reserveSpend: jest.fn(async () => ({ kind: 'confirm', gate: 'allocation', confirmFlag: 'confirmOverAllocation', reason: 'allocation exhausted', confidence: 'prior' })) as never,
    });
    const claims = [job()];
    (h.deps.claimNext as jest.Mock).mockImplementation(async () => claims.shift() ?? null);
    await microvmDispatchPass(h.deps);
    for (let i = 0; i < 50 && !h.calls.unclaim.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(h.calls.unclaim).toHaveBeenCalledWith(job().id, 'clm_private');
    expect(h.client.send).not.toHaveBeenCalled();
    expect(h.calls.markRunning).not.toHaveBeenCalled();
    expect(h.calls.emitMetric).toHaveBeenCalledWith('microvm-held-back', expect.objectContaining({ reason: 'spend-confirm' }));
  });

  it('holds the p75 tokens plus the compute term, keyed <job>:<attempt>, source microvm', async () => {
    const h = harness({ computeSecondsP75: jest.fn(async () => 600) });
    await judgeAndRun(h);
    expect(h.calls.reserveSpend).toHaveBeenCalledWith(expect.objectContaining({
      source: 'microvm', sourceId: `${job().id}:1`, initiativeId: 'p-auth', actorId: 'u-nora',
      forecast: expect.objectContaining({ costUsdP75: 1.1, costUsdP25: 0.8 }),
      expiresInMs: 35 * 60_000,
    }));
  });

  it('never starts without a frozen brief: the hold is released and the job held back', async () => {
    const h = harness({ freezeBrief: jest.fn(async () => null) });
    await judgeAndRun(h);
    expect(h.calls.releaseHold).toHaveBeenCalledWith('9d1c2b3a-0000-4000-8000-000000000001');
    expect(h.calls.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'held_back', reason: 'brief-unfrozen' }));
    expect(h.client.send).not.toHaveBeenCalled();
  });
});

// ─── §3: the sequence, §6: settlement ────────────────────────────────────────

describe('one attempt, end to end', () => {
  it('boots, runs, pushes with the installation token, opens the PR with the user token, then stops the session', async () => {
    const h = harness();
    await judgeAndRun(h);
    const sid = h.invokes[0]!.sessionId;
    expect(sid).toBe(microvmSessionId({ tenant: 'orgiq', actorSub: 'u-nora', agentProjectId: AP_ID, jobId: job().id, attempt: 1 }));
    expect(h.invokes.map((i) => i.payload['op'])).toEqual(['boot', 'task', 'push']);
    expect(new Set(h.invokes.map((i) => i.sessionId))).toEqual(new Set([sid]));
    expect(h.invokes.every((i) => i.arn === ARN && i.payload['runner'] === 'microvm')).toBe(true);
    expect(h.order).toEqual(['invoke:boot', 'invoke:task', 'invoke:push', 'user-token', 'pr', `stop:${sid}`]);

    // The boot payload, field for field against main.py's contract.
    const boot = h.invokes[0]!.payload;
    const read = h.tokens.minted.find((m) => m.perms.contents === 'read')!;
    expect(boot).toMatchObject({
      repo: { full_name: 'acme/widgets', clone_url: 'https://github.com/acme/widgets.git' }, ref: 'main',
      target: '/tmp/devbox-workspace/repo', token: read.token, run_ref: job().id, run_token: `runtok-${job().id}`,
      callback_secret: 'fleet-secret-value', library_sha: LIB_SHA, brief_ref: `brief-${job().id}`,
      lab_api_base: 'https://lab.orgiq.internal', author: { name: 'nora-gh', email: '42+nora-gh@users.noreply.github.com' },
    });
    const task = h.invokes[1]!.payload;
    expect(task).toMatchObject({ prompt: PROMPT, model: PROFILE.models[0], timeout_s: 840, resume_session_id: null, resume_transcript_get_url: null });
    expect(String(task['transcript_put_url'])).toMatch(/^https:\/\/orgiq-microvm-runs-111122223333-us-east-1\.s3\.us-east-1\.amazonaws\.com\/runs\//);
    expect(String(task['transcript_put_url'])).toMatch(/X-Amz-Expires=900/);
    expect(String(task['transcript_put_url'])).toMatch(/X-Amz-SignedHeaders=content-type%3Bhost/);

    // Push with the installation write token; PR with the user token; the
    // user token never in any payload a microVM received.
    const write = h.tokens.minted.find((m) => m.perms.contents === 'write')!;
    expect(write.perms).toEqual({ contents: 'write', pull_requests: 'write' });
    expect(h.invokes[2]!.payload).toEqual({
      op: 'push', runner: 'microvm', branch: 'orgiq/unora/6c1d2e3f', token: write.token,
      author: { name: 'nora-gh', email: '42+nora-gh@users.noreply.github.com' }, expected_head: null,
    });
    expect(h.calls.openPullRequest).toHaveBeenCalledWith(USER_TOKEN, expect.objectContaining({ owner: 'acme', repo: 'widgets', head: 'orgiq/unora/6c1d2e3f', base: 'main' }));
    expect(JSON.stringify(h.invokes)).not.toContain(USER_TOKEN);
    expect(h.calls.stopSession).toHaveBeenCalledWith(ARN, sid);

    // The job: awaiting review with the PR.
    expect(h.calls.completeJob).toHaveBeenCalledWith(job().id, expect.objectContaining({
      claimToken: 'clm_private', status: 'awaiting_review',
      result: expect.objectContaining({ prUrl: 'https://github.com/acme/widgets/pull/7', branch: 'orgiq/unora/6c1d2e3f', headSha: HEAD, sessionId: sid }),
    }));
    expect(h.calls.emitMetric).toHaveBeenCalledWith('microvm-pr-opened', expect.anything());
    expect(h.calls.emitMetric).toHaveBeenCalledWith('microvm-boot-seconds', expect.objectContaining({ seconds: expect.any(Number) }));

    // The session row, at its last status.
    const row = (await latestSessionForJob(job().id))!;
    expect(row).toMatchObject({
      session_id: sid, status: 'stopped', stop_reason: 'completed', base_sha: BASE, head_sha: HEAD, pr_url: 'https://github.com/acme/widgets/pull/7',
      claude_session_id: CLAUDE_SID, transcript_s3_key: `runs/${job().id}/1/transcript.ndjson`, exit_code: 0, fresh_tokens: 1500,
      brief_sha: 'b'.repeat(64), library_sha: LIB_SHA, profile_id: 'restricted', network_class: 'egress-allowlist',
    });
  });

  it('devbox_end with tokens writes ONE ledger row keyed <job>:<attempt> with compute seconds, and settles the hold', async () => {
    const h = harness();
    await judgeAndRun(h);
    const rows = mockStoredEntries().filter((e) => e.source === 'microvm');
    expect(rows).toHaveLength(1);
    const e = rows[0]!;
    expect(e.sourceId).toBe(`${job().id}:1`);
    expect(e.costBasis).toBe('reported');
    expect(e.computeSeconds).toBeGreaterThan(0);
    expect(e.computeUsd).toBeCloseTo(e.computeSeconds! * 0.001, 4);
    expect(e.costUsd).toBeCloseTo(0.12 + e.computeUsd!, 4);
    expect(e.sessionId).toBe(h.invokes[0]!.sessionId);
    expect(e.inputTokens).toBe(1000);
    expect(spendHolds.rows().find((x) => x.sourceId === `${job().id}:1`)!.status).toBe('settled');
  });

  it('a session with no result and no devbox_end settles unknown, never 0, and leaves the hold to expire', async () => {
    const h = harness({}, { task: [{ type: 'devbox_start', model: PROFILE.models[0] }] });
    await judgeAndRun(h);
    const e = mockStoredEntries().find((x) => x.source === 'microvm')!;
    expect(e.costUsd).toBeNull();
    expect(e.costBasis).toBe('unknown');
    expect(e.computeSeconds).toBeGreaterThan(0);
    expect(spendHolds.rows()[0]!.status).toBe('held');
    expect(h.calls.completeJob).toHaveBeenCalledWith(job().id, expect.objectContaining({ status: 'failed', error: 'the task ended without devbox_end' }));
    expect(h.calls.openPullRequest).not.toHaveBeenCalled();
    expect(h.calls.stopSession).toHaveBeenCalledWith(ARN, h.invokes[0]!.sessionId);
  });

  it('a boot {ok:false, error:"library-mismatch"} fails the job before task', async () => {
    const h = harness({}, { boot: { ok: false, error: 'library-mismatch', detail: 'library aaaa is not the brief\'s bbbb' } });
    await judgeAndRun(h);
    expect(h.invokes.map((i) => i.payload['op'])).toEqual(['boot']);
    expect(h.calls.completeJob).toHaveBeenCalledWith(job().id, expect.objectContaining({ status: 'failed', error: 'boot failed: library-mismatch' }));
    expect(h.calls.stopSession).toHaveBeenCalledTimes(1);
    expect((await latestSessionForJob(job().id))!.status).toBe('failed');
    // Billed from boot, so compute is recorded; tokens were never spent but no devbox_end came: unknown.
    expect(mockStoredEntries().find((x) => x.source === 'microvm')).toMatchObject({ costBasis: 'unknown', costUsd: null });
  });

  it('every mint writes a credential_issues row with run_ref = the job and the session id', async () => {
    const h = harness();
    await judgeAndRun(h);
    const sid = h.invokes[0]!.sessionId;
    const rows = await listCredentialIssues({ runRef: job().id });
    // read + write (installation tokens) + run-token + presign (the PUT) + repo-user (the PR token read).
    expect(rows.map((r) => r.kind).sort()).toEqual(['presign', 'repo-install', 'repo-install', 'repo-user', 'run-token']);
    expect(rows.every((r) => r.run_ref === job().id && r.session_id === sid && r.caller_sub === 'u-nora')).toBe(true);
    expect(rows.filter((r) => r.kind === 'repo-install').map((r) => r.permissions)).toEqual(expect.arrayContaining([
      { contents: 'read' }, { contents: 'write', pull_requests: 'write' },
    ]));
    expect(JSON.stringify(rows)).not.toMatch(/orgiq-local-|ghu_|runtok-|X-Amz-Signature/);
  });

  it('a resume reconstitutes from the original: its branch, its transcript (presigned GET) and its claude session', async () => {
    const original: AgentJob = { ...job({ id: 'job-orig-0001', status: 'failed' }), finishedAt: new Date().toISOString() };
    microvmSessions.rows().push({
      session_id: 'mvm1-0000000000000000-3f2a9c1e-7b4-job-orig-000-1', job_id: 'job-orig-0001', attempt: 1, actor_sub: 'u-nora', tenant: 'orgiq',
      agent_project_id: AP_ID, initiative_id: 'p-auth', runtime_arn: ARN, profile_id: 'restricted', profile_version: 1,
      network_class: 'egress-allowlist', status: 'failed', hold_id: null, brief_sha: null, library_sha: LIB_SHA,
      claude_session_id: CLAUDE_SID, base_sha: BASE, head_sha: HEAD, branch: 'orgiq/unora/origorig', pr_url: null,
      transcript_s3_key: 'runs/job-orig-0001/1/transcript.ndjson', exit_code: 1, fresh_tokens: 10, cost_usd: null,
      cost_basis: 'unknown', compute_seconds: 30, compute_usd: 0.03, stop_reason: 'failed', task_timeout_s: 840,
      created_at: new Date().toISOString(), booted_at: null, started_at: null, ended_at: null, stopped_at: new Date().toISOString(),
    });
    const h = harness({ getJobFacts: jest.fn(async () => original) });
    await judgeAndRun(h, job({ resumeOfJobId: 'job-orig-0001' }));
    expect(h.deps.freezeBrief).toHaveBeenCalledWith(expect.objectContaining({ id: 'job-orig-0001' }));
    expect(h.invokes[0]!.payload).toMatchObject({ ref: 'orgiq/unora/origorig' });
    expect(h.invokes[1]!.payload).toMatchObject({ resume_session_id: CLAUDE_SID });
    expect(String(h.invokes[1]!.payload['resume_transcript_get_url'])).toMatch(/\/runs\/job-orig-0001\/1\/transcript\.ndjson\?/);
    // A resume cloned the branch, so it leases on the head its boot saw.
    expect(h.invokes[2]!.payload).toMatchObject({ op: 'push', branch: 'orgiq/unora/origorig', expected_head: BASE });
    expect((await listCredentialIssues({ runRef: job().id })).filter((r) => r.kind === 'presign')).toHaveLength(2);
  });

  it('registers a transient box owned by the actor for the tail, and removes it on stop', async () => {
    const h = harness();
    await judgeAndRun(h);
    const sid = h.invokes[0]!.sessionId;
    expect(h.deps.registerBox).toHaveBeenCalledWith(expect.objectContaining({ id: `mvm:${sid}`, sessionId: sid, ownerId: 'u-nora', projectId: 'p-auth' }));
    expect(h.deps.appendEvent).toHaveBeenCalledWith(`mvm:${sid}`, expect.objectContaining({ type: 'devbox_end' }));
    expect(h.deps.removeBox).toHaveBeenCalledWith(`mvm:${sid}`);
  });

  it('logs ids, shas and reasons per step — never the prompt, a token or a presigned URL', async () => {
    const h = harness();
    await judgeAndRun(h);
    const lines = JSON.stringify(h.calls.log.mock.calls);
    expect(lines).toContain('"step":"boot"');
    expect(lines).toContain(h.invokes[0]!.sessionId);
    expect(lines).not.toContain(PROMPT.slice(0, 40));
    for (const m of h.tokens.minted) expect(lines).not.toContain(m.token);
    expect(lines).not.toMatch(/X-Amz-|ghu_|runtok-|fleet-secret-value/);
  });

  it('a task refusal fails the job without a push or a PR', async () => {
    const h = harness({}, { task: { agent: 'devbox', error: 'model not allowlisted' } });
    await judgeAndRun(h);
    expect(h.invokes.map((i) => i.payload['op'])).toEqual(['boot', 'task']);
    expect(h.calls.completeJob).toHaveBeenCalledWith(job().id, expect.objectContaining({ status: 'failed', error: 'task refused: model not allowlisted' }));
    expect(h.calls.stopSession).toHaveBeenCalledTimes(1);
    // Nothing was pushed, so the row carries no lease for the next attempt.
    expect((await latestSessionForJob(job().id))!.head_sha).toBeNull();
  });

  it('a failed run that left a commit still pushes its branch (for a resume) but opens no PR', async () => {
    const h = harness({}, { task: [{ ...RESULT, subtype: 'error_max_turns', is_error: true }, { ...END, exit_code: 1 }] });
    await judgeAndRun(h);
    expect(h.invokes.map((i) => i.payload['op'])).toEqual(['boot', 'task', 'push']);
    expect(h.calls.openPullRequest).not.toHaveBeenCalled();
    expect(h.calls.completeJob).toHaveBeenCalledWith(job().id, expect.objectContaining({ status: 'failed' }));
  });
});

// ─── The gaps §16 listed, closed ──────────────────────────────────────────────

describe('push lease (expected_head)', () => {
  it('attempt 2 of a job whose attempt 1 pushed leases on the head attempt 1 recorded', async () => {
    await judgeAndRun(harness());
    expect((await latestSessionForJob(job().id))!.head_sha).toBe(HEAD);
    const NEXT = '3'.repeat(40);
    const h2 = harness({}, { push: { ok: true, head_sha: NEXT, pushed: true } });
    await judgeAndRun(h2, job({ attempts: 2 }));
    expect(h2.invokes[2]!.payload).toMatchObject({ op: 'push', branch: 'orgiq/unora/6c1d2e3f', expected_head: HEAD });
    expect((await latestSessionForJob(job().id))!).toMatchObject({ attempt: 2, head_sha: NEXT });
  });

  it('a commit that never left the box is no lease: attempt 2 still sends null', async () => {
    // Attempt 1 commits but its push is rejected.
    const h1 = harness({}, { push: { ok: false, error: 'push-rejected', detail: 'git push exited 1' } });
    await judgeAndRun(h1);
    expect(h1.calls.completeJob).toHaveBeenCalledWith(job().id, expect.objectContaining({ status: 'failed', error: 'push failed: push-rejected' }));
    expect((await latestSessionForJob(job().id))!.head_sha).toBeNull();
    const h2 = harness();
    await judgeAndRun(h2, job({ attempts: 2 }));
    expect(h2.invokes[2]!.payload['expected_head']).toBeNull();
  });
});

describe('the runtime\'s maxLifetime (sweep 4 M3)', () => {
  it('holds back a profile whose task plus the boot allowance exceeds MICROVM_MAX_LIFETIME_S, before any money is held', async () => {
    const long: DevboxProfile = { ...PROFILE, task_timeout_s: 3300 };
    const h = harness({ profileFor: jest.fn(async () => long) });
    expect(await judgeMicrovmJob(job(), h.deps, { saturated: [] })).toEqual({ ok: false, reason: 'profile-exceeds-runtime-lifetime' });
    const claims = [job()];
    (h.deps.claimNext as jest.Mock).mockImplementation(async () => claims.shift() ?? null);
    await microvmDispatchPass(h.deps);
    expect(h.calls.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'held_back', reason: 'profile-exceeds-runtime-lifetime' }));
    expect(h.calls.reserveSpend).not.toHaveBeenCalled();
    expect(h.client.send).not.toHaveBeenCalled();
  });

  it('a runtime deployed for the long profile (MICROVM_MAX_LIFETIME_S=7200) takes it; the default 3600 takes the default profile', async () => {
    const long: DevboxProfile = { ...PROFILE, task_timeout_s: 3300 };
    const wide = harness({ profileFor: jest.fn(async () => long) }, {}, { ...ENV, MICROVM_MAX_LIFETIME_S: '7200' });
    expect((await judgeMicrovmJob(job(), wide.deps, { saturated: [] })).ok).toBe(true);
    expect(microvmConfig({}).maxLifetimeS).toBe(3600);
    expect((await judgeMicrovmJob(job(), harness().deps, { saturated: [] })).ok).toBe(true);
  });

  it('the boundary: task + boot allowance equal to the lifetime fits, one second more does not', () => {
    const edge = 3600 - BOOT_ALLOWANCE_MS / 1000;
    expect(fitsRuntimeLifetime(edge, 3600)).toBe(true);
    expect(fitsRuntimeLifetime(edge + 1, 3600)).toBe(false);
  });
});

describe('the read token is minted only once the claim is proven (sweep 4 Low 8)', () => {
  it('a heartbeat that cannot prove the claim mints nothing and records no credential', async () => {
    const h = harness({ maintainAttempt: jest.fn(async () => { throw new Error('lost'); }) });
    await judgeAndRun(h);
    expect(h.tokens.minted).toHaveLength(0);
    expect(await listCredentialIssues({ runRef: job().id })).toEqual([]);
    expect(h.calls.markRunning).not.toHaveBeenCalled();
    expect(h.client.send).not.toHaveBeenCalled();
  });

  it('a failed mint stops the heartbeat and hands the still-claimed job back as repo-token-unavailable', async () => {
    const stop = jest.fn();
    const h = harness({
      maintainAttempt: jest.fn(async () => ({ signal: new AbortController().signal, assertLive: () => undefined, run: <T,>(w: () => Promise<T>) => w(), stop })),
      mintRepoToken: jest.fn(async () => { throw new Error('github down'); }),
    });
    await judgeAndRun(h);
    expect(stop).toHaveBeenCalled();
    expect(h.calls.unclaim).toHaveBeenCalledWith(job().id, 'clm_private');
    expect(h.calls.markRunning).not.toHaveBeenCalled();
    expect(h.calls.log).toHaveBeenCalledWith(expect.objectContaining({ event: 'held_back', reason: 'repo-token-unavailable' }));
  });
});

describe('held-back memory (sweep 4 Low 9)', () => {
  it('is bounded, and a job that runs to completion is forgotten', async () => {
    const h = harness({ profileFor: jest.fn(async () => null) });
    const claims = Array.from({ length: HELD_BACK_MEMORY_MAX + 50 }, (_, i) => job({ id: `job-held-${i}` }));
    (h.deps.claimNext as jest.Mock).mockImplementation(async () => claims.shift() ?? null);
    while (claims.length) await microvmDispatchPass({ ...h.deps, config: () => ({ ...microvmConfig({ ...ENV }), batch: 200 }) });
    expect(_heldBackMemorySize()).toBe(HELD_BACK_MEMORY_MAX);

    const before = _heldBackMemorySize();
    const ran = harness();
    const v = await judgeMicrovmJob(job({ id: 'job-held-1049' }), ran.deps, { saturated: [] });
    if (!v.ok) throw new Error(v.reason);
    await runMicrovmAttempt(job({ id: 'job-held-1049' }), v.plan, ran.deps);
    expect(_heldBackMemorySize()).toBe(before - 1);
  });
});

describe('hold TTL (§6)', () => {
  it('covers the task, the boot allowance and the grace, never under the default', () => {
    expect(microvmHoldExpiresInMs(30, 840)).toBe(35 * 60_000);
    expect(microvmHoldExpiresInMs(30, 3300)).toBe(3300_000 + 10 * 60_000 + 5 * 60_000);
    expect(microvmHoldExpiresInMs(30, 0)).toBe(35 * 60_000);
  });

  it('a profile at the 3,300 s cap gets a hold that outlives its task, on reserveSpend and the meter', async () => {
    // On a runtime deployed for it (microvmTaskTimeoutSeconds=3300 → maxLifetime 7200).
    const h = harness({ profileFor: jest.fn(async () => ({ ...PROFILE, task_timeout_s: 3300 })) }, {}, { ...ENV, MICROVM_MAX_LIFETIME_S: '7200' });
    await judgeAndRun(h);
    const held = (h.calls.reserveSpend.mock.calls[0]![0] as { expiresInMs: number }).expiresInMs;
    expect(held).toBeGreaterThan(3300_000 + 10 * 60_000);
    expect(held).toBe(70 * 60_000);
    expect(h.deps.meterForHold).toHaveBeenCalledWith(expect.objectContaining({ expiresInMs: held }));
  });
});

describe('runtime ARN and runs bucket from SSM', () => {
  const NOARN = { LAB_CALLBACK_SECRET: 'fleet-secret-value', PROJECT_PREFIX: 'orgiq', MICROVM_COMPUTE_USD_PER_SECOND: '0' };

  it('reads /orgiq/microvm/* once when the env is unset, and the config uses them', async () => {
    const read = jest.fn(async (name: string) => ({
      '/orgiq/microvm/runtime-arn': ARN, '/orgiq/microvm/endpoint-arn': `${ARN}/runtime-endpoint/DEFAULT`, '/orgiq/microvm/runs-bucket': 'runs-from-ssm',
    } as Record<string, string>)[name] ?? null);
    await loadMicrovmParameters(read, NOARN, () => undefined);
    await loadMicrovmParameters(read, NOARN, () => undefined);
    expect(read.mock.calls.map((c) => c[0]).sort()).toEqual(['/orgiq/microvm/endpoint-arn', '/orgiq/microvm/runs-bucket', '/orgiq/microvm/runtime-arn']);
    expect(microvmConfig(NOARN)).toMatchObject({ runtimeArn: ARN, runsBucket: 'runs-from-ssm', endpointArn: `${ARN}/runtime-endpoint/DEFAULT` });
    // The env still wins over the cache.
    expect(microvmConfig({ ...NOARN, MICROVM_RUNTIME_ARN: 'arn:env' }).runtimeArn).toBe('arn:env');
    const v = await judgeMicrovmJob(job(), harness({}, {}, NOARN).deps, { saturated: [] });
    expect(v.ok).toBe(true);
  });

  it('reads nothing when the env names both, or offline', async () => {
    const read = jest.fn(async () => 'x');
    await loadMicrovmParameters(read, ENV, () => undefined);
    _resetMicrovmParameters();
    await loadMicrovmParameters(read, { ...NOARN, MOCK_AGENTCORE: 'true' }, () => undefined);
    expect(read).not.toHaveBeenCalled();
  });

  it('with neither the env nor the parameter (or an SSM error) every job still waits as no-microvm-runtime', async () => {
    await loadMicrovmParameters(jest.fn(async (name: string) => { if (name.endsWith('runs-bucket')) throw Object.assign(new Error('x'), { name: 'AccessDeniedException' }); return null; }), NOARN, () => undefined);
    expect(microvmConfig(NOARN)).toMatchObject({ runtimeArn: null, runsBucket: null });
    expect(await judgeMicrovmJob(job(), harness({}, {}, NOARN).deps, { saturated: [] })).toEqual({ ok: false, reason: 'no-microvm-runtime' });
  });
});

describe('lab_api_base', () => {
  it('prefers MICROVM_LAB_API_BASE and says once at start-up which source it used', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const env = { ...ENV, MICROVM_LAB_API_BASE: 'https://lab.orgiq.internal:8443' };
    await startMicrovmRunner({ env, read: async () => null, log: (l) => lines.push(l) });
    await startMicrovmRunner({ env, read: async () => null, log: (l) => lines.push(l) });
    const config = lines.filter((l) => l['event'] === 'config');
    expect(config).toHaveLength(1);
    expect(config[0]).toMatchObject({ labApiBase: 'https://lab.orgiq.internal:8443', labApiBaseSource: 'env MICROVM_LAB_API_BASE', runtimeArnSource: 'env' });
    const h = harness({}, {}, env);
    await judgeAndRun(h);
    expect(h.invokes[0]!.payload['lab_api_base']).toBe('https://lab.orgiq.internal:8443');

    _resetMicrovmStart();
    lines.length = 0;
    await startMicrovmRunner({ env: ENV, read: async () => null, log: (l) => lines.push(l) });
    expect(lines.find((l) => l['event'] === 'config')).toMatchObject({ labApiBase: 'https://lab.orgiq.internal', labApiBaseSource: 'default lab.<PROJECT_PREFIX>.internal' });
  });
});

describe('agent_project_runs', () => {
  it('a microVM session writes one run row: its session id, runner microvm, the agent project, finished with the token cost', async () => {
    const h = harness();
    await judgeAndRun(h);
    const sid = h.invokes[0]!.sessionId;
    const rows = agentProjectRuns.rows().filter((r) => r.sessionId === sid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runner: 'microvm', projectId: AP_ID, model: PROFILE.models[0], status: 'done', costUsd: 0.12 });
  });

  it('a failed boot still finishes its row as failed', async () => {
    const h = harness({}, { boot: { ok: false, error: 'clone-failed', detail: 'git clone exited 128' } });
    await judgeAndRun(h);
    const row = agentProjectRuns.rows().find((r) => r.sessionId === h.invokes[0]!.sessionId)!;
    expect(row).toMatchObject({ runner: 'microvm', status: 'failed', error: 'boot failed: clone-failed', costUsd: null });
  });
});

describe('workspace root', () => {
  it('uses the env root before the first boot, then the root the box reported', async () => {
    const h1 = harness({}, { boot: { ok: true, head_sha: BASE, library_sha_ok: true, booted_at: '', workspace_root: '/var/devbox/ws' } });
    await judgeAndRun(h1);
    expect(h1.invokes[0]!.payload['target']).toBe('/tmp/devbox-workspace/repo');
    expect(workspaceRootFor(ARN, '/tmp/devbox-workspace')).toBe('/var/devbox/ws');
    const h2 = harness();
    await judgeAndRun(h2, job({ id: 'job-7d1d2e3f-4a5b-4c6d-8e7f-001122334466' }));
    expect(h2.invokes[0]!.payload['target']).toBe('/var/devbox/ws/repo');
  });

  it('a bad-target boot that names its root is retried once on the same session with a target under it', async () => {
    const h = harness({}, {
      boot: (p: Record<string, unknown>) => (String(p['target']).startsWith('/srv/ws/')
        ? { ok: true, head_sha: BASE, library_sha_ok: true, booted_at: '', workspace_root: '/srv/ws' }
        : { ok: false, error: 'bad-target', detail: 'target must be strictly under the workspace', workspace_root: '/srv/ws' }),
    });
    await judgeAndRun(h);
    expect(h.invokes.map((i) => [i.payload['op'], i.payload['target'] ?? null])).toEqual([
      ['boot', '/tmp/devbox-workspace/repo'], ['boot', '/srv/ws/repo'], ['task', null], ['push', null],
    ]);
    expect(new Set(h.invokes.map((i) => i.sessionId)).size).toBe(1);
    expect(h.calls.completeJob).toHaveBeenCalledWith(job().id, expect.objectContaining({ status: 'awaiting_review' }));
  });

  it('ignores a reported root that is not a clean absolute path, and never retries twice', async () => {
    for (const [i, bad] of ['relative', '/', '/a/../etc', '/a/\nb', 42].entries()) {
      _resetLearnedWorkspaceRoots();
      const h = harness({}, { boot: { ok: false, error: 'bad-target', detail: '', workspace_root: bad } });
      await judgeAndRun(h, job({ id: `job-${i}badroot-0000-0000-000000000000` }));
      expect([bad, h.invokes.filter((x) => x.payload['op'] === 'boot').length]).toEqual([bad, 1]);
      expect(workspaceRootFor(ARN, 'fallback')).toBe('fallback');
    }
  });
});

describe('settlement helpers (§6)', () => {
  it('prices from devbox_end: reported, else estimated from usage, else unknown', () => {
    expect(tokenCostFromEnd(null, 'm', () => 1)).toMatchObject({ costUsd: null, costBasis: 'unknown' });
    expect(tokenCostFromEnd({ ...END, reported_cost_usd: null }, 'm', () => 0.05)).toMatchObject({ costUsd: 0.05, costBasis: 'estimated' });
    expect(tokenCostFromEnd({ ...END, reported_cost_usd: null, usage: null }, 'm', () => 0.05)).toMatchObject({ costUsd: null, costBasis: 'unknown' });
    expect(tokenCostFromEnd(END, 'm', () => 0.05)).toMatchObject({ costUsd: 0.12, costBasis: 'reported', estimatedCostUsd: 0.05 });
  });
});

// ─── §7: the overrun sweep ────────────────────────────────────────────────────

describe('the overrun sweep (§7)', () => {
  it('stops a live session past task_timeout_s + grace and records stop_reason overrun; leaves a fresh one', async () => {
    const h = harness();
    const now = Date.parse('2026-11-07T12:00:00Z');
    const row = (sid: string, startedMinAgo: number) => ({
      session_id: sid, job_id: 'job-x', attempt: 1, actor_sub: 'u-nora', tenant: 'orgiq', agent_project_id: AP_ID, initiative_id: 'p-auth',
      runtime_arn: ARN, profile_id: 'restricted', profile_version: 1, network_class: 'egress-allowlist', status: 'running' as const,
      hold_id: null, brief_sha: null, library_sha: null, claude_session_id: null, base_sha: null, head_sha: null, branch: null, pr_url: null,
      transcript_s3_key: null, exit_code: null, fresh_tokens: null, cost_usd: null, cost_basis: null, compute_seconds: null, compute_usd: null,
      stop_reason: null, task_timeout_s: 840, created_at: new Date(now - startedMinAgo * 60_000).toISOString(), booted_at: null,
      started_at: new Date(now - startedMinAgo * 60_000).toISOString(), ended_at: null, stopped_at: null,
    });
    microvmSessions.rows().push(row('mvm1-old-session-aaaaaaaaaaaaaaaaaaaaaaaa-1', 20), row('mvm1-new-session-bbbbbbbbbbbbbbbbbbbbbbbb-1', 10));
    const stopped = await sweepMicrovmOverruns({ ...h.deps, now: () => now });
    expect(stopped).toEqual(['mvm1-old-session-aaaaaaaaaaaaaaaaaaaaaaaa-1']);
    expect(h.calls.stopSession).toHaveBeenCalledWith(ARN, 'mvm1-old-session-aaaaaaaaaaaaaaaaaaaaaaaa-1');
    expect(microvmSessions.rows().find((r) => r.session_id.startsWith('mvm1-old'))).toMatchObject({ status: 'stopped', stop_reason: 'overrun' });
    expect(microvmSessions.rows().find((r) => r.session_id.startsWith('mvm1-new'))!.status).toBe('running');
    expect(h.deps.removeBox).toHaveBeenCalledWith('mvm:mvm1-old-session-aaaaaaaaaaaaaaaaaaaaaaaa-1');
  });
});
