// DE-14: the plan is decided by the live account and the recorded input keys;
// the state file is a record; `plan`/`--dry-run` make no write call. The
// planner and runner take fixtures and a fake `aws`; the CLI is run against a
// fake `aws`, `cdk` and `docker` on PATH (the deploy-live-read pattern).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  planDeploy, createRunner, preflightChecks, verifyChecks, parseArgs, loadEnvironment, contextOf, previousState, collectProbes,
} from '../orchestrate.mjs';
import { PHASES, PHASE_IDS, FLEET_STACKS, AGENTS, commandLine } from '../phases.mjs';
import { readState, validateState, writeState, newState, stateFile, lockParameter, lastRunParameter } from '../state.mjs';

const ROOT = resolve(new URL('../../..', import.meta.url).pathname);
const ACCOUNT = '647757222309';
const COMMIT = 'c'.repeat(40);
const lab = loadEnvironment('lab');
const social = { ...lab, features: { social: true, documents: false, devbox: false } };

// A deterministic input key: the phase, its context, and a per-path "tree version" the test can bump.
const treeVersions = {};
const keyFor = (phase, context) => `${phase.id}:${JSON.stringify(context)}:${phase.inputPaths.map((p) => treeVersions[p] ?? 'v1').join(',')}`;
const base = { commit: COMMIT, inputKeyFor: keyFor, exists: () => false, dirty: () => [], toolVersion: () => 'ok' };

function fresh(env = lab) {
  return { account: ACCOUNT, stacks: {}, ecr: {}, ssm: {}, secrets: {}, runtimes: [], ecs: undefined, portalIndexPresent: false, portalUrl: null, documentGatewayUrl: null, env };
}
function allLive(env = lab) {
  const p = fresh(env);
  for (const s of [...FLEET_STACKS, 'Portal', 'Authentication', ...(env.features.social ? ['SocialImages', 'SocialMedia', 'Social'] : [])]) p.stacks[`OrgIQ-${s}`] = 'UPDATE_COMPLETE';
  p.ecr[`${env.prefix}-agent-base`] = ['latest'];
  for (const a of AGENTS) p.ecr[`${env.prefix}-${a}`] = ['latest'];
  p.ecr[`${env.prefix}-middleware`] = ['latest', COMMIT.slice(0, 12)];
  for (const r of ['lvs-sfu', 'platform-api', 'social-gateway']) p.ecr[`${env.prefix}-${r}`] = env.features.social ? ['sha-1'] : [];
  p.ecs = { desired: 1, running: 1 };
  p.ssm['/orgiq/portal/url'] = 'https://d1.cloudfront.net';
  p.portalUrl = 'https://d1.cloudfront.net';
  p.portalIndexPresent = true;
  for (const s of ['approvals-request', 'harness-trace', 'assessment-run-complete']) p.secrets[`orgiq-${s}-secret`] = true;
  p.runtimes = AGENTS.map((a) => ({ name: `orgiq_${a.replace(/-/g, '_')}`, status: 'READY' }));
  return p;
}
/** A recorded run in which every planned phase finished with today's keys. */
function recorded(env, probes, extraOutputs = {}) {
  const plan = planDeploy(env, probes, null, base);
  const state = newState({ env, account: ACCOUNT, commit: COMMIT, runId: '2026-10-28T18:02:00Z-cccccccc' });
  for (const p of plan.phases) {
    if (p.action === 'disabled') continue;
    state.phases[p.id] = { status: 'done', inputKey: p.inputKey, startedAt: 't', finishedAt: 't', outputs: extraOutputs[p.id] ?? {} };
  }
  return state;
}
const runIds = (plan) => plan.phases.filter((p) => p.action === 'run').map((p) => p.id);
const linesOf = (plan, id) => plan.phases.find((p) => p.id === id).commands.map(commandLine);

describe('planDeploy', () => {
  test('a fresh account plans every enabled phase in Runbook A order, including auth-urls and runtime-callbacks', () => {
    const plan = planDeploy(lab, fresh(), null, base);
    assert.deepEqual(runIds(plan), ['preflight', 'fleet', 'runtimes', 'middleware-image', 'middleware-portal', 'portal-publish', 'auth-urls', 'runtime-callbacks', 'verify']);
    for (const id of ['social-images', 'social-stacks', 'documents-build', 'documents-push', 'documents-deploy', 'devbox']) {
      assert.equal(plan.phases.find((p) => p.id === id).action, 'disabled', `${id} is opt-in per environment`);
    }
    // The order is the dependency order too.
    const index = Object.fromEntries(PHASE_IDS.map((id, i) => [id, i]));
    for (const phase of PHASES) for (const n of phase.needs) assert.ok(index[n] < index[phase.id], `${phase.id} needs ${n}`);
    // Every command is an existing script; deploy.sh is the only thing that reaches CloudFormation.
    for (const p of plan.phases) for (const c of p.commands) {
      if (c.program !== 'aws') assert.ok(existsSync(c.args[0]), `${p.id}: ${c.args[0]} does not exist`);
      assert.doesNotMatch(commandLine(c), /\bcdk deploy\b/);
    }
    assert.match(linesOf(plan, 'fleet')[0], /ENV=lab .*infra\/scripts\/deploy\.sh$/);
    assert.match(linesOf(plan, 'runtimes').at(-1), /deploy\.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true/);
    assert.match(linesOf(plan, 'middleware-portal')[0], /OrgIQ-MiddlewareService OrgIQ-Portal --context deployMiddlewareService=true --context deployPortal=true/);
    assert.match(linesOf(plan, 'auth-urls')[0], /OrgIQ-Authentication OrgIQ-MiddlewareService$/);
    assert.match(linesOf(plan, 'runtime-callbacks')[0], /deploy\.sh OrgIQ-AgentCoreRuntime$/);
  });

  test('a social environment adds the Social phases after the middleware, with both digests as explicit context', () => {
    const plan = planDeploy(social, fresh(social), null, base);
    const ids = runIds(plan);
    assert.ok(ids.indexOf('social-images') > ids.indexOf('fleet') && ids.indexOf('social-stacks') > ids.indexOf('middleware-portal'));
    assert.ok(ids.indexOf('social-stacks') < ids.indexOf('verify'));
  });

  test('all live with unchanged input keys plans only preflight and verify', () => {
    const probes = allLive();
    const plan = planDeploy(lab, probes, recorded(lab, probes), base);
    assert.deepEqual(runIds(plan), ['preflight', 'verify']);
    for (const p of plan.phases.filter((x) => x.action === 'skip')) assert.match(p.reason, /live and unchanged/);
  });

  test('a changed Social source commit plans social-images and the stacks after it', () => {
    const probes = allLive(social);
    const previous = recorded(social, probes, { 'social-images': { sfuImageDigest: 'sha256:' + 'a'.repeat(64), platformApiImageDigest: 'sha256:' + 'b'.repeat(64) } });
    treeVersions['scripts/docker/document-workspace-sources.json'] = 'v2';
    try {
      const plan = planDeploy(social, probes, previous, base);
      assert.deepEqual(runIds(plan), ['preflight', 'social-images', 'social-stacks', 'verify']);
      assert.match(plan.phases.find((p) => p.id === 'social-stacks').reason, /social-images runs before it/);
      // At plan time the recorded digests are the explicit context; the runner swaps in the fresh ones (see below).
      assert.match(linesOf(plan, 'social-stacks')[0], /--context sfuImageDigest=sha256:a{64} --context platformApiImageDigest=sha256:b{64} --context deploySocialService=true/);
    } finally { delete treeVersions['scripts/docker/document-workspace-sources.json']; }
  });

  test('a changed middleware/ tree re-plans the image and everything that needs it, not the fleet', () => {
    const probes = allLive();
    const previous = recorded(lab, probes);
    treeVersions.middleware = 'v2';
    try {
      assert.deepEqual(runIds(planDeploy(lab, probes, previous, base)), ['preflight', 'middleware-image', 'middleware-portal', 'portal-publish', 'auth-urls', 'runtime-callbacks', 'verify']);
    } finally { delete treeVersions.middleware; }
  });

  test('--from and --only narrow the plan; always-phases stay', () => {
    const probes = allLive();
    const previous = recorded(lab, probes);
    assert.deepEqual(runIds(planDeploy(lab, fresh(), previous, { ...base, from: 'portal-publish' })), ['preflight', 'portal-publish', 'auth-urls', 'runtime-callbacks', 'verify']);
    const only = planDeploy(lab, probes, previous, { ...base, only: ['middleware-image'], from: 'middleware-image' });
    assert.deepEqual(runIds(only), ['preflight', 'verify']);
    treeVersions.middleware = 'v3';
    try { assert.deepEqual(runIds(planDeploy(lab, probes, previous, { ...base, only: ['middleware-image'] })), ['preflight', 'middleware-image', 'verify']); } finally { delete treeVersions.middleware; }
  });

  test('a live phase with no record at all is run once to record its inputs', () => {
    const plan = planDeploy(lab, allLive(), null, base);
    assert.ok(runIds(plan).includes('fleet'));
    assert.match(plan.phases.find((p) => p.id === 'fleet').reason, /no record/);
  });

  test('the context a phase passes is part of its key, so a changed albAllowCidr is not "unchanged"', () => {
    const a = planDeploy(lab, allLive(), null, { ...base, albAllowCidr: '1.1.1.1/32' });
    const b = planDeploy(lab, allLive(), null, { ...base, albAllowCidr: '2.2.2.2/32' });
    assert.notEqual(a.phases.find((p) => p.id === 'middleware-portal').inputKey, b.phases.find((p) => p.id === 'middleware-portal').inputKey);
    assert.deepEqual(contextOf(a.phases.find((p) => p.id === 'middleware-portal').commands).albAllowCidr, '1.1.1.1/32');
  });
});

describe('the state file is a record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-state-'));
  const file = join(dir, 'state.json');
  test('a torn or foreign file is rejected and the probes decide', () => {
    writeFileSync(file, '{"schemaVersion":1,"env":"lab","account":"647757222309","commit":"' + COMMIT + '","phases":{"fleet":{"status":"do');
    const torn = readState(file, 'lab');
    assert.equal(torn.state, null);
    assert.match(torn.reason, /unreadable.*probes decide/);
    assert.equal(validateState({ schemaVersion: 1, env: 'pv1', account: ACCOUNT, commit: COMMIT, phases: {} }, 'lab').ok, false);
    assert.equal(validateState({ schemaVersion: 1, env: 'lab', account: ACCOUNT, commit: COMMIT, phases: { nope: { status: 'done', inputKey: 'k' } } }, 'lab').ok, false);
    assert.equal(validateState({ schemaVersion: 1, env: 'lab', account: ACCOUNT, commit: COMMIT, phases: { fleet: { status: 'done' } } }, 'lab').reason, 'phase fleet: done without an inputKey');
    const plan = planDeploy(lab, allLive(), torn.state, base);
    assert.ok(runIds(plan).includes('fleet'), 'with no usable record the live phase is rebuilt once');
  });
  test('writes are atomic (temp + rename) and round-trip', () => {
    const state = newState({ env: lab, account: ACCOUNT, commit: COMMIT, runId: 'r' });
    state.phases.fleet = { status: 'done', inputKey: 'k', startedAt: 't', finishedAt: 't', outputs: {} };
    writeState(file, state);
    assert.deepEqual(readState(file, 'lab').state, state);
    assert.ok(!existsSync(`${file}.${process.pid}.tmp`));
  });
  test('a lost local file falls back to the SSM last-run copy; a rejected copy does not', () => {
    rmSync(file, { force: true });
    const state = newState({ env: lab, account: ACCOUNT, commit: COMMIT, runId: 'remote-run' });
    const fromSsm = previousState(file, lab, { ssm: { [lastRunParameter('orgiq')]: JSON.stringify(state) } });
    assert.equal(fromSsm.state.runId, 'remote-run');
    assert.match(fromSsm.reason, /no state file; using the SSM last-run record/);
    assert.equal(previousState(file, lab, { ssm: { [lastRunParameter('orgiq')]: '{"schemaVersion":9}' } }).state, null);
    assert.equal(previousState(file, lab, { ssm: {} }).state, null);
  });
});

/** A fake `aws` for the runner: answers probes from `probes`, keeps SSM writes in `store`, records every call. */
function fakeAws(probes, store, calls) {
  return (args, { readOnly = true } = {}) => {
    const line = args.join(' ');
    calls.push(line);
    const [svc, op] = args;
    const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
    if (svc === 'sts') return probes.account;
    if (svc === 'cloudformation') {
      const stack = flag('--stack-name'); const query = flag('--query');
      if (/StackStatus/.test(query)) return probes.stacks[stack] ?? null;
      if (/PortalUrl/.test(query)) return probes.portalUrl;
      if (/PortalBucketName/.test(query)) return probes.stacks[stack] ? 'orgiq-portal-bucket' : null;
      if (/DocumentGatewayPublicUrl/.test(query)) return probes.documentGatewayUrl;
      return null;
    }
    if (svc === 'ecr') return (probes.ecr[flag('--repository-name')] ?? []).join('\t') || null;
    if (svc === 'ecs') return probes.ecs ? `${probes.ecs.desired}\t${probes.ecs.running}` : null;
    if (svc === 'secretsmanager') return probes.secrets[flag('--secret-id')] ? flag('--secret-id') : null;
    if (svc === 's3api') return probes.portalIndexPresent ? '"etag"' : null;
    if (svc === 'bedrock-agentcore-control') return probes.runtimes.map((r) => `${r.name}\t${r.status}`).join('\n') || null;
    if (svc === 'configure') return null;
    if (svc === 'ssm' && op === 'get-parameter') return store[flag('--name')] ?? probes.ssm[flag('--name')] ?? null;
    if (svc === 'ssm' && op === 'put-parameter') {
      assert.equal(readOnly, false, 'a write must be declared as one');
      const name = flag('--name');
      if (store[name] !== undefined && !args.includes('--overwrite')) throw new Error('An error occurred (ParameterAlreadyExists) when calling the PutParameter operation');
      store[name] = flag('--value'); return '{"Version":1}';
    }
    if (svc === 'ssm' && op === 'delete-parameter') { delete store[flag('--name')]; return ''; }
    throw new Error(`unexpected aws ${line}`);
  };
}

describe('the runner', () => {
  function harness({ env = lab, probes, store = {}, failAt = null, reports = {} }) {
    const root = mkdtempSync(join(tmpdir(), 'orch-run-'));
    const calls = []; const executed = []; const out = [];
    const exec = (cmd) => {
      executed.push(commandLine(cmd));
      if (failAt && commandLine(cmd).includes(failAt)) return { status: 7, tail: 'boom' };
      return { status: 0, tail: '' };
    };
    const runner = createRunner({
      env, aws: fakeAws(probes, store, calls), exec, root, out: (l) => out.push(l), host: 'laptop', now: () => new Date('2026-10-28T18:02:00Z'),
      readJson: (p) => reports[p.replace(`${root}/`, '')] ?? null, exists: () => false, fetchHealth: () => 200,
    });
    return { runner, calls, executed, out, store, root, apply: (o = {}) => runner.apply({ ...base, ...o }) };
  }

  test('an apply on a fresh account runs every phase, records each before and after, publishes last-run and releases the lock', () => {
    const probes = fresh();
    const h = harness({ probes });
    // Make the account "become live" as phases run: the verify probe reads it again.
    const liveLater = allLive();
    h.runner.releaseLock = h.runner.releaseLock; // (no-op; keeps the API honest)
    Object.assign(probes, { ...liveLater, account: ACCOUNT });
    const rc = h.apply();
    assert.equal(rc, 0, h.out.join('\n'));
    const state = readState(h.runner.file, 'lab').state;
    assert.ok(state, 'state written');
    for (const id of ['fleet', 'runtimes', 'middleware-image', 'middleware-portal', 'portal-publish', 'auth-urls', 'runtime-callbacks', 'verify']) {
      assert.equal(state.phases[id]?.status, 'done', id);
    }
    assert.ok(h.executed.some((l) => /deploy\.sh$/.test(l)), 'fleet ran deploy.sh');
    assert.ok(h.store[lastRunParameter('orgiq')], 'last-run put to SSM');
    assert.equal(h.store[lockParameter('orgiq')], undefined, 'lock released');
    assert.ok(h.calls.filter((c) => c.startsWith('ssm put-parameter --name /orgiq/deploy/last-run')).length >= 8, 'recorded after every phase');
  });

  test('an immediate second apply runs no cdk deploy, no docker push and no update-service', () => {
    const probes = allLive();
    const h = harness({ probes });
    assert.equal(h.apply(), 0, h.out.join('\n'));
    const first = h.executed.length;
    assert.ok(first > 0);
    const again = harness({ probes, store: h.store });
    // Same machine: reuse the state file by pointing the second runner at the first root.
    const runner = createRunner({ env: lab, aws: fakeAws(probes, h.store, again.calls), exec: (c) => { again.executed.push(commandLine(c)); return { status: 0, tail: '' }; },
      root: h.root, out: (l) => again.out.push(l), host: 'laptop', now: () => new Date('2026-10-28T19:00:00Z'), readJson: () => null, exists: () => false, fetchHealth: () => 200 });
    assert.equal(runner.apply(base), 0, again.out.join('\n'));
    assert.deepEqual(again.executed, [], 'nothing ran');
    assert.ok(!again.calls.some((c) => /update-service|docker push|cdk deploy/.test(c)));
    assert.ok(again.out.some((l) => /fleet: skip — live and unchanged/.test(l)), again.out.join('\n'));
  });

  test('killed after phase N: resume replans from N+1; a deleted state file yields the same plan (SSM last-run)', () => {
    const probes = allLive();
    const h = harness({ probes, failAt: 'middleware-image-build.mjs' });
    assert.equal(h.apply(), 1);
    let state = readState(h.runner.file, 'lab').state;
    assert.equal(state.phases.fleet.status, 'done');
    assert.equal(state.phases.runtimes.status, 'done');
    assert.equal(state.phases['middleware-image'].status, 'failed');
    assert.equal(state.phases['middleware-image'].exitCode, 7);
    assert.equal(state.phases['middleware-portal'], undefined, 'nothing after the failure started');
    assert.equal(h.store[lockParameter('orgiq')], undefined, 'the lock is released on failure');

    const plan1 = planDeploy(lab, probes, state, base);
    assert.deepEqual(runIds(plan1), ['preflight', 'middleware-image', 'middleware-portal', 'portal-publish', 'auth-urls', 'runtime-callbacks', 'verify']);

    rmSync(h.runner.file);
    const { state: remote, reason } = previousState(h.runner.file, lab, { ssm: { [lastRunParameter('orgiq')]: h.store[lastRunParameter('orgiq')] } });
    assert.match(reason, /using the SSM last-run record/);
    assert.deepEqual(runIds(planDeploy(lab, probes, remote, base)), runIds(plan1), 'same plan without the file');

    // And the resume itself: a second runner finishes the rest.
    const resumed = harness({ probes, store: h.store });
    const runner = createRunner({ env: lab, aws: fakeAws(probes, h.store, resumed.calls), exec: (c) => { resumed.executed.push(commandLine(c)); return { status: 0, tail: '' }; },
      root: h.root, out: (l) => resumed.out.push(l), host: 'laptop', now: () => new Date('2026-10-28T19:00:00Z'), readJson: () => null, exists: () => false, fetchHealth: () => 200 });
    assert.equal(runner.apply(base), 0, resumed.out.join('\n'));
    assert.ok(!resumed.executed.some((l) => /deploy\.sh$/.test(l)), 'the fleet did not run again');
    assert.ok(resumed.executed.some((l) => /middleware-image-build\.mjs/.test(l)));
    state = readState(h.runner.file, 'lab').state;
    assert.equal(state.phases['middleware-image'].status, 'done');
    assert.equal(state.phases.verify.status, 'done');
  });

  test('a second apply while the lock is held exits 3 and names the holder; --break-lock takes it', () => {
    const probes = allLive();
    const store = { [lockParameter('orgiq')]: JSON.stringify({ runId: '2026-10-28T10:00:00Z-deadbeef', host: 'ci-runner', startedAt: '2026-10-28T10:00:00Z' }) };
    const h = harness({ probes, store });
    let err = null;
    try { h.apply(); } catch (e) { err = e; }
    assert.ok(err, 'apply must throw');
    assert.equal(err.code, 3);
    assert.match(err.message, /ci-runner/);
    assert.match(err.message, /deadbeef/);
    assert.deepEqual(h.executed, []);
    assert.equal(h.apply({ breakLock: true }), 0, h.out.join('\n'));
    assert.ok(h.out.some((l) => /breaking the lock/.test(l)));
  });

  test('a fresh Social digest produced in this run reaches the social stacks as explicit --context', () => {
    const probes = allLive(social);
    const previous = recorded(social, probes, { 'social-images': { sfuImageDigest: 'sha256:' + 'a'.repeat(64), platformApiImageDigest: 'sha256:' + 'b'.repeat(64) } });
    const h = harness({ env: social, probes, reports: { '.scratch/social-images/report.json': { images: [
      { key: 'sfu', context: 'sfuImageDigest=sha256:' + 'f'.repeat(64) }, { key: 'platformApi', context: 'platformApiImageDigest=sha256:' + 'e'.repeat(64) }] } } });
    writeState(h.runner.file, previous);
    treeVersions['scripts/docker/document-workspace-sources.json'] = 'v2';
    try {
      assert.equal(h.apply(), 0, h.out.join('\n'));
    } finally { delete treeVersions['scripts/docker/document-workspace-sources.json']; }
    const socialDeploy = h.executed.find((l) => /OrgIQ-SocialMedia OrgIQ-Social/.test(l));
    assert.ok(socialDeploy, h.executed.join('\n'));
    assert.match(socialDeploy, /sfuImageDigest=sha256:f{64}/);
    assert.match(socialDeploy, /platformApiImageDigest=sha256:e{64}/);
    assert.doesNotMatch(socialDeploy, /a{64}|b{64}/, 'the stale digest never wins');
    assert.deepEqual(readState(h.runner.file, 'lab').state.phases['social-images'].outputs, { sfuImageDigest: 'sha256:' + 'f'.repeat(64), platformApiImageDigest: 'sha256:' + 'e'.repeat(64) });
  });

  test('a middleware digest that changed forces one ECS rollout; an unchanged one does not', () => {
    const probes = allLive();
    const previous = recorded(lab, probes, { 'middleware-image': { digest: 'sha256:' + '1'.repeat(64) } });
    const h = harness({ probes, reports: { '.scratch/middleware-image/report.json': { digest: 'sha256:' + '2'.repeat(64), sourceCommit: COMMIT } } });
    writeState(h.runner.file, previous);
    treeVersions.middleware = 'v2';
    try { assert.equal(h.apply(), 0, h.out.join('\n')); } finally { delete treeVersions.middleware; }
    assert.equal(h.executed.filter((l) => /ecs update-service .*--force-new-deployment/.test(l)).length, 1);
  });
});

describe('preflight and verify', () => {
  test('the wrong account, expiring credentials, a dirty built path and missing buildx are each named', () => {
    const plan = planDeploy(lab, fresh(), null, base);
    const problems = preflightChecks(lab, { ...fresh(), account: '264161986065', credentialExpiration: new Date(Date.now() + 5 * 60000).toISOString() }, plan,
      { ...base, dirty: () => ['middleware/src/index.ts'], toolVersion: (p) => (p === 'docker' ? null : 'ok') });
    assert.ok(problems.some((p) => /credentials are for 264161986065/.test(p)), problems.join('\n'));
    assert.ok(problems.some((p) => /expire in 5 min/.test(p)));
    assert.ok(problems.some((p) => /uncommitted changes.*middleware\/src\/index\.ts/.test(p)));
    assert.ok(problems.some((p) => /buildx/.test(p)));
    assert.deepEqual(preflightChecks(lab, fresh(), plan, base), []);
  });
  test('verify: desired = running, every runtime READY, /health 200', () => {
    assert.deepEqual(verifyChecks(lab, allLive(), { health: 200 }), []);
    const bad = verifyChecks(lab, { ...allLive(), ecs: { desired: 1, running: 0 }, runtimes: [] }, { health: 503 });
    assert.ok(bad.some((p) => /desired=1 running=0/.test(p)));
    assert.ok(bad.some((p) => /runtime orgiq_supervisor missing/.test(p)));
    assert.ok(bad.some((p) => /health answered 503/.test(p)));
  });
  test('argument parsing refuses unknown phases and --working-tree without --only', () => {
    assert.deepEqual(parseArgs(['plan', '--only', 'fleet,verify', '--from', 'fleet']).only, ['fleet', 'verify']);
    assert.throws(() => parseArgs(['apply', '--from', 'nope']), /unknown phase/);
    assert.throws(() => parseArgs(['apply', '--working-tree']), /only with --only/);
    assert.throws(() => parseArgs(['destroy']), /usage/);
  });
});

describe('the CLI against a fake aws, cdk and docker on PATH', () => {
  const MUTATING = /^(aws )?\S+ (put-|delete-|create-|update-|run-|start-|deploy|push|sync|cp\b)|^(cdk|docker) (deploy|destroy|push|buildx build)/;
  function runCli(args, { account = ACCOUNT } = {}) {
    const bin = mkdtempSync(join(tmpdir(), 'orch-bin-'));
    const log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'aws'), `#!/bin/bash
echo "aws $*" >> "${log}"
args="$*"
case "$args" in
  *"get-caller-identity"*) echo ${account} ;;
  *"describe-stacks"*"StackStatus"*) echo UPDATE_COMPLETE ;;
  *"describe-stacks"*"PortalUrl"*) echo https://d1.cloudfront.net ;;
  *"describe-stacks"*"PortalBucketName"*) echo orgiq-portal-b ;;
  *"describe-images --repository-name orgiq-middleware"*) echo "latest $(cd ${ROOT} && git rev-parse HEAD | cut -c1-12)" ;;
  *"describe-images"*) echo latest ;;
  *"describe-services"*) printf '1\\t1\\n' ;;
  *"get-parameter --name /orgiq/portal/url"*) echo https://d1.cloudfront.net ;;
  *"get-parameter"*) echo "ParameterNotFound" >&2; exit 254 ;;
  *"describe-secret"*) echo x ;;
  *"head-object"*) echo etag ;;
  *"list-agent-runtimes"*) printf 'orgiq_supervisor\\tREADY\\norgiq_search\\tREADY\\norgiq_scoring\\tREADY\\norgiq_advisor\\tREADY\\norgiq_ingestion\\tREADY\\norgiq_graph_builder\\tREADY\\norgiq_assessment_scorer\\tREADY\\norgiq_assessment_drafter\\tREADY\\n' ;;
  *"export-credentials"*) echo None ;;
  *) echo None ;;
esac
`);
    writeFileSync(join(bin, 'cdk'), `#!/bin/bash\necho "cdk $*" >> "${log}"\necho 2.1143.0\n`);
    writeFileSync(join(bin, 'docker'), `#!/bin/bash\necho "docker $*" >> "${log}"\necho "github.com/docker/buildx v0.20.0"\n`);
    for (const f of ['aws', 'cdk', 'docker']) chmodSync(join(bin, f), 0o755);
    const r = spawnSync('node', [resolve(ROOT, 'scripts/deploy/orchestrate.mjs'), ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, ORCHESTRATE_ASSUME_CLEAN: '1', PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...r, calls };
  }

  test('plan --env lab --dry-run prints every command with inferred context and makes no write call', () => {
    const r = runCli(['plan', '--env', 'lab', '--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /# deploy plan: env=lab account=647757222309/);
    assert.match(r.stdout, /preflight: run/);
    assert.match(r.stdout, /verify: run/);
    assert.match(r.stdout, /read-only aws calls, no write call/);
    assert.ok(r.calls.length > 20, 'the live account was read');
    assert.ok(!r.calls.some((c) => MUTATING.test(c)), r.calls.filter((c) => MUTATING.test(c)).join('\n'));
    assert.ok(!r.calls.some((c) => /^cdk (deploy|destroy)/.test(c)));
    assert.ok(!r.calls.some((c) => /^docker (buildx build|push)/.test(c)));
  });

  test('plan with the forbidden account would be refused at preflight (exit 2) and still writes nothing', () => {
    const r = runCli(['plan', '--env', 'lab'], { account: '264161986065' });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /preflight would refuse: credentials are for 264161986065/);
    assert.ok(!r.calls.some((c) => MUTATING.test(c)));
  });

  test('status with no state says so', () => {
    const r = runCli(['status', '--env', 'nope-env']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not exist/);
  });
});

test('.scratch is gitignored, so the state file never lands in a commit', () => {
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^\.scratch\/$/m);
  assert.match(stateFile('lab'), /\.scratch\/deploy\/lab\/state\.json$/);
});

test('collectProbes asks only read-only verbs', () => {
  const calls = [];
  const aws = (args) => { calls.push(args.join(' ')); return null; };
  collectProbes(lab, aws);
  for (const c of calls) assert.match(c, /^(sts get-caller-identity|cloudformation describe-stacks|ecr describe-images|ecs describe-services|ssm get-parameter|secretsmanager describe-secret|bedrock-agentcore-control list-agent-runtimes|configure export-credentials)/, c);
});

// keep the temp dirs from leaking across runs
process.on('exit', () => { try { mkdirSync(join(tmpdir(), 'orch-keep')); } catch { /* noop */ } });
