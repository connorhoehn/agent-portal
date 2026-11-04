/**
 * DE-4: the pointer model is the alias; the planners never call AWS; the CLI
 * writes nothing without --yes. The CLI is run against a fake `aws` on PATH
 * (the deploy-live-read pattern) that records every verb it is asked for.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  awsArgvFor, lifecycleSql, parsePointer, planBootstrap, planCandidate, planPromote, planRollback,
  pointerNames, pointersFromParameters, serializePointer, POINTER_AGENTS,
} from '../lib/prompt-pointers';

const P = 'orgiq';
const live7 = { promptId: 'PSEARCH', version: '7' };
const cand8 = { promptId: 'PSEARCH', version: '8', weight: 10 };

describe('the pointer parses exactly as prompt_source.py does', () => {
  test('names', () => {
    assert.deepEqual(pointerNames(P, 'search'), { live: '/orgiq/prompts/search/live', candidate: '/orgiq/prompts/search/candidate' });
    assert.throws(() => pointerNames(P, '../x'), /not an agent name/);
  });
  test('well-formed, numeric version coerced, DRAFT normalised', () => {
    assert.deepEqual(parsePointer('{"promptId":"P1","version":"7"}'), { promptId: 'P1', version: '7' });
    assert.deepEqual(parsePointer('{"promptId":"P1","version":7}'), { promptId: 'P1', version: '7' });
    assert.deepEqual(parsePointer('{"promptId":"P1","version":"draft"}'), { promptId: 'P1', version: 'DRAFT' });
    assert.deepEqual(parsePointer(serializePointer(cand8), { candidate: true }), cand8);
  });
  test('anything malformed is null, never guessed', () => {
    for (const raw of ['', 'nope', '[]', '{"version":"7"}', '{"promptId":"P1"}', '{"promptId":"P1","version":"v7"}',
      '{"promptId":"P1","version":"7","weight":250}', '{"promptId":"P1","version":"7","weight":"10"}', '{"promptId":"../x","version":"7"}']) {
      assert.equal(parsePointer(raw, { candidate: true }), null, raw);
    }
  });
  test('get-parameters output → both arms', () => {
    const got = pointersFromParameters(P, 'search', [
      { Name: '/orgiq/prompts/search/live', Value: serializePointer(live7) },
      { Name: '/orgiq/prompts/search/candidate', Value: serializePointer(cand8) },
    ]);
    assert.deepEqual(got, { live: live7, candidate: cand8 });
    assert.deepEqual(pointersFromParameters(P, 'search', []), { live: null, candidate: null });
  });
});

describe('candidate: the gate decides, and one candidate at a time', () => {
  const current = { live: live7, candidate: null };
  test('a passing version becomes the candidate at the starting weight → deployed', () => {
    const plan = planCandidate({ prefix: P, agent: 'search', current, promptId: 'PSEARCH', version: '8', gatePassed: true });
    assert.equal(plan.refused, undefined);
    assert.deepEqual(plan.writes, [{ name: '/orgiq/prompts/search/candidate', value: '{"promptId":"PSEARCH","version":"8","weight":10}' }]);
    assert.deepEqual(plan.transitions, [{ promptId: 'PSEARCH', version: '8', lifecycleStatus: 'deployed' }]);
    assert.deepEqual(plan.deletes, []);
  });
  test('a version that fails the gate is refused and nothing is written', () => {
    const plan = planCandidate({ prefix: P, agent: 'search', current, promptId: 'PSEARCH', version: '8', gatePassed: false });
    assert.match(plan.refused ?? '', /did not pass the offline eval gate/);
    assert.deepEqual(awsArgvFor(plan, 'us-east-1'), []);
  });
  test('DRAFT, the live version, another prompt id, a bad weight, or a candidate already in flight are refused', () => {
    assert.match(planCandidate({ prefix: P, agent: 'search', current, promptId: 'PSEARCH', version: 'DRAFT', gatePassed: true }).refused!, /never deployable/);
    assert.match(planCandidate({ prefix: P, agent: 'search', current, promptId: 'PSEARCH', version: '7', gatePassed: true }).refused!, /already live/);
    assert.match(planCandidate({ prefix: P, agent: 'search', current, promptId: 'POTHER', version: '8', gatePassed: true }).refused!, /one prompt per agent/);
    assert.match(planCandidate({ prefix: P, agent: 'search', current, promptId: 'PSEARCH', version: '8', weight: 0, gatePassed: true }).refused!, /weight/);
    assert.match(planCandidate({ prefix: P, agent: 'search', current: { live: live7, candidate: cand8 }, promptId: 'PSEARCH', version: '9', gatePassed: true }).refused!, /already the candidate/);
  });
});

describe('promote and rollback write the right pointers and lifecycle rows', () => {
  test('promote copies candidate to live, deletes candidate: new → promoted, old → superseded', () => {
    const plan = planPromote({ prefix: P, agent: 'search', current: { live: live7, candidate: cand8 } });
    assert.equal(plan.refused, undefined);
    assert.deepEqual(plan.writes, [{ name: '/orgiq/prompts/search/live', value: '{"promptId":"PSEARCH","version":"8"}' }]);
    assert.deepEqual(plan.deletes, ['/orgiq/prompts/search/candidate']);
    assert.deepEqual(plan.transitions, [
      { promptId: 'PSEARCH', version: '8', lifecycleStatus: 'promoted' },
      { promptId: 'PSEARCH', version: '7', lifecycleStatus: 'superseded' },
    ]);
    const argv = awsArgvFor(plan, 'us-east-1');
    assert.equal(argv.length, 2);
    assert.deepEqual(argv[0].slice(0, 2), ['ssm', 'put-parameter']);
    assert.ok(argv[0].includes('--overwrite'));
    assert.deepEqual(argv[1], ['ssm', 'delete-parameter', '--region', 'us-east-1', '--name', '/orgiq/prompts/search/candidate']);
  });
  test('rollback deletes the candidate only: → rolled_back, live untouched', () => {
    const plan = planRollback({ prefix: P, agent: 'search', current: { live: live7, candidate: cand8 } });
    assert.deepEqual(plan.writes, []);
    assert.deepEqual(plan.deletes, ['/orgiq/prompts/search/candidate']);
    assert.deepEqual(plan.transitions, [{ promptId: 'PSEARCH', version: '8', lifecycleStatus: 'rolled_back' }]);
  });
  test('neither does anything without a candidate', () => {
    assert.match(planPromote({ prefix: P, agent: 'search', current: { live: live7, candidate: null } }).refused!, /no candidate/);
    assert.match(planRollback({ prefix: P, agent: 'search', current: { live: live7, candidate: null } }).refused!, /no candidate/);
  });
  test('the lifecycle row is an upsert constrained to the schema statuses', () => {
    const schema = readFileSync(join(__dirname, '..', '..', 'schema', 'observability_sprint6_prompt_history_schema.sql'), 'utf8');
    for (const t of planPromote({ prefix: P, agent: 'search', current: { live: live7, candidate: cand8 } }).transitions) {
      const { sql, parameters } = lifecycleSql(t);
      assert.match(sql, /observability\.prompt_version_meta/);
      assert.match(sql, /ON CONFLICT \(prompt_id, version\)/);
      assert.ok(schema.includes(`'${t.lifecycleStatus}'`), `${t.lifecycleStatus} is not in the CHECK constraint`);
      assert.equal(parameters.find((p) => p.name === 'status')?.value.stringValue, t.lifecycleStatus);
    }
  });
});

describe('bootstrap changes nothing an agent says on day one', () => {
  test('an agent with a live pointer is untouched; one without gets its DRAFT published and written live', () => {
    const kept = planBootstrap({ prefix: P, agent: 'search', current: { live: live7, candidate: null }, promptId: 'PSEARCH' });
    assert.deepEqual([kept.writes, kept.createVersion], [[], false]);
    const first = planBootstrap({ prefix: P, agent: 'search', current: { live: null, candidate: null }, promptId: 'PSEARCH' });
    assert.equal(first.createVersion, true);
    assert.deepEqual(first.writes, []);
    const done = planBootstrap({ prefix: P, agent: 'search', current: { live: null, candidate: null }, promptId: 'PSEARCH', publishedVersion: '1' });
    assert.deepEqual(done.writes, [{ name: '/orgiq/prompts/search/live', value: '{"promptId":"PSEARCH","version":"1"}' }]);
    assert.deepEqual(done.transitions.map((t) => t.lifecycleStatus), ['published', 'promoted']);
    assert.match(planBootstrap({ prefix: P, agent: 'search', current: { live: null, candidate: null }, promptId: null }).refused!, /no Bedrock prompt/);
  });
  test('the pointer agents are the runtime stack agents', () => {
    const stack = readFileSync(join(__dirname, '..', 'lib', 'agentcore-runtime-stack.ts'), 'utf8');
    for (const a of POINTER_AGENTS) assert.ok(stack.includes(`'${a}'`), a);
    assert.match(stack, /SYSTEM_PROMPT_POINTER: `\/\$\{prefix\}\/prompts\/\$\{agentName\}`/);
  });
});

describe('the CLI against a fake aws', () => {
  const script = join(__dirname, '..', 'scripts', 'prompt-pointers.ts');
  function run(args: string[], awsBody: string) {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-pointers-'));
    const log = join(dir, 'calls.log');
    writeFileSync(join(dir, 'aws'), `#!/bin/bash\necho "$*" >> "${log}"\nargs="$*"\n${awsBody}\n`);
    chmodSync(join(dir, 'aws'), 0o755);
    const r = spawnSync('node', ['--require', 'ts-node/register', script, ...args], {
      cwd: join(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env['PATH']}`, TS_NODE_TRANSPILE_ONLY: '1' },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { ...r, calls };
  }
  const account = `case "$args" in *"get-caller-identity"*) echo 647757222309; exit 0;; esac`;
  const pointers = `case "$args" in *"get-parameters"*"/orgiq/prompts/search/"*) echo '{"Parameters":[{"Name":"/orgiq/prompts/search/live","Value":"{\\"promptId\\":\\"PSEARCH\\",\\"version\\":\\"7\\"}"},{"Name":"/orgiq/prompts/search/candidate","Value":"{\\"promptId\\":\\"PSEARCH\\",\\"version\\":\\"8\\",\\"weight\\":10}"}]}'; exit 0;; *"get-parameters"*) echo '{"Parameters":[]}'; exit 0;; esac`;
  const MUTATING = /put-parameter|delete-parameter|create-prompt-version|execute-statement/;

  test('status reads every agent and writes nothing', () => {
    const r = run(['status'], `${account}\n${pointers}\necho None`);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /search: live=PSEARCH@7 candidate=PSEARCH@8 10%/);
    assert.match(r.stdout, /supervisor: live=\(absent → baked\)/);
    assert.ok(!r.calls.some((c) => MUTATING.test(c)), r.calls.join('\n'));
  });

  test('promote without --yes prints the plan and makes no write call; with --yes it writes live and deletes candidate', () => {
    const dry = run(['promote', '--agent', 'search'], `${account}\n${pointers}\necho None`);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /put \/orgiq\/prompts\/search\/live = \{"promptId":"PSEARCH","version":"8"\}/);
    assert.match(dry.stdout, /dry run: nothing written/);
    assert.ok(!dry.calls.some((c) => MUTATING.test(c)));

    const wet = run(['promote', '--agent', 'search', '--yes'], `${account}\n${pointers}\necho ok`);
    assert.equal(wet.status, 0, wet.stderr);
    assert.ok(wet.calls.some((c) => /ssm put-parameter .*--name \/orgiq\/prompts\/search\/live .*--overwrite/.test(c)), wet.calls.join('\n'));
    assert.ok(wet.calls.some((c) => /ssm delete-parameter .*--name \/orgiq\/prompts\/search\/candidate/.test(c)));
    assert.ok(!wet.calls.some((c) => /execute-statement/.test(c)), 'no Aurora ARNs → the lifecycle SQL is printed, not run');
    assert.match(wet.stdout, /lifecycle not recorded/);
  });

  test('candidate refuses when the gate fails: exit 1 and no write', () => {
    const r = run(['candidate', '--agent', 'supervisor', '--version', '3', '--yes', '--gate-command', 'exit 1'],
      `${account}\n${pointers}\ncase "$args" in *"list-prompts"*) echo PSUP; exit 0;; esac\necho None`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /did not pass the offline eval gate/);
    assert.ok(!r.calls.some((c) => MUTATING.test(c)), r.calls.join('\n'));
  });

  test('the wrong account stops everything before any read of the pointers', () => {
    const r = run(['status'], `case "$args" in *"get-caller-identity"*) echo 264161986065; exit 0;; esac\necho None`);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Nothing was changed/);
    assert.ok(!r.calls.some((c) => /get-parameters/.test(c)));
  });
});

// The CLI applies --query per page of an auto-paginated list-prompts, so the
// text output is one line per page; the 2026-11-03 rebuild's dry run printed
// "publish DRAFT of <id>\nNone".
import { firstPromptId } from '../scripts/prompt-pointers';
describe('firstPromptId reads per-page CLI output', () => {
  test('the first real id wins; None lines are empty pages', () => {
    assert.equal(firstPromptId('JNDBMKTFEU\nNone'), 'JNDBMKTFEU');
    assert.equal(firstPromptId('None\nHVJECMVUUS'), 'HVJECMVUUS');
    assert.equal(firstPromptId('None\nNone'), null);
    assert.equal(firstPromptId(''), null);
  });
});
