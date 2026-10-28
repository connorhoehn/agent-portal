/**
 * DE-17 parameterised environments: the loader, the lab environment's
 * invariants (ids and account unchanged), a second environment (pv1) that
 * shares no name with lab, and the deploy/destroy account guard.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forbiddenAccounts, loadEnvironment, parseEnvironment, stackId } from '../lib/environment';
import { synthApp } from './helpers/app-assembly';

const INFRA = path.join(__dirname, '..');
const FIXTURES = path.join(INFRA, 'test', 'fixtures', 'environments');
const LAB_ACCOUNT = '647757222309';
const PERSONAL = '264161986065';

const lab = JSON.parse(fs.readFileSync(path.join(INFRA, 'environments', 'lab.json'), 'utf8'));
const forbidden = forbiddenAccounts();
const withLab = (edit: (e: any) => void) => { const e = JSON.parse(JSON.stringify(lab)); edit(e); return e; };

describe('loadEnvironment', () => {
  test('lab.json loads and names the lab account', () => {
    const e = loadEnvironment('lab');
    assert.deepEqual([e.account, e.region, e.prefix, e.stackPrefix], [LAB_ACCOUNT, 'us-east-1', 'orgiq', 'OrgIQ']);
    assert.equal(stackId(e, 'Foundation'), 'OrgIQ-Foundation');
    assert.equal(loadEnvironment().name, 'lab', 'lab is the default');
  });

  test('the personal account is forbidden, from the shared list', () => {
    assert.ok(forbidden.includes(PERSONAL));
    assert.throws(() => parseEnvironment('lab', withLab(e => { e.account = PERSONAL; }), forbidden), /forbidden/);
  });

  test('a bad account, prefix, stack prefix, region, name or key throws', () => {
    const bad = (edit: (e: any) => void, re: RegExp) => assert.throws(() => parseEnvironment('lab', withLab(edit), forbidden), re);
    bad(e => { e.account = '12345'; }, /12-digit/);
    bad(e => { e.prefix = 'Bad_Prefix'; }, /prefix must match/);
    bad(e => { e.prefix = 'x'; }, /prefix must match/);
    bad(e => { e.prefix = 'a'.repeat(16); }, /prefix must match/);
    bad(e => { e.stackPrefix = 'lowercase'; }, /stackPrefix must match/);
    bad(e => { e.region = 'mars-north-1'; }, /region must be one of/);
    bad(e => { e.name = 'other'; }, /file is lab\.json/);
    bad(e => { e.surprise = 1; }, /unknown key "surprise"/);
    bad(e => { e.alertEmail = 'me@example.com'; }, /personal data/);
    bad(e => { e.edge = { mode: 'domain' }; }, /certificateArn/);
    bad(e => { e.edge = { mode: 'cloudfront', portalAliases: ['a.example.com'] }; }, /portalAliases is not supported/);
    assert.throws(() => loadEnvironment('../etc/passwd'), /not a valid environment name/);
    assert.throws(() => loadEnvironment('nope'), /does not exist/);
  });

  test('a checked-in environment file cannot carry a forbidden account', () => {
    for (const file of fs.readdirSync(path.join(INFRA, 'environments')).filter(f => f !== 'forbidden-accounts.json')) {
      const e = JSON.parse(fs.readFileSync(path.join(INFRA, 'environments', file), 'utf8'));
      assert.ok(!forbidden.includes(e.account), file);
    }
  });

  test('the personal account in a fixture directory still throws (the list is always the real one)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envdir-'));
    fs.writeFileSync(path.join(dir, 'oops.json'), JSON.stringify(withLab(e => { e.name = 'oops'; e.account = PERSONAL; })));
    assert.throws(() => loadEnvironment('oops', dir), /forbidden/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const ALL = {
  deployPortal: 'true', deployDevbox: 'true', deployMiddlewareService: 'true', deploySocial: 'true',
  deploySocialMedia: 'true', deploySocialImages: 'true', deployCanary: 'true', deployRuntimes: 'true', enableEval: 'true',
};

describe('the lab environment keeps every stack id and account', () => {
  const app = synthApp(ALL);

  test('ids are unchanged and every stack carries the file\'s explicit account', () => {
    assert.equal(app.stackNames.length, 22);
    for (const name of app.stackNames) {
      assert.match(name, /^OrgIQ-[A-Za-z]+$/);
      assert.equal(app.environments[name], `aws://${LAB_ACCOUNT}/us-east-1`, name);
    }
    for (const name of ['OrgIQ-Foundation', 'OrgIQ-Aurora', 'OrgIQ-AgentCoreRuntime', 'OrgIQ-MiddlewareService',
      'OrgIQ-Portal', 'OrgIQ-Social', 'OrgIQ-SocialMedia', 'OrgIQ-SocialImages', 'OrgIQ-Devbox', 'OrgIQ-PromptCanary']) {
      assert.ok(app.has(name), name);
    }
  });

  test('the resolved environment is stack metadata on Foundation, so cdk diff shows a change', () => {
    assert.deepEqual(app.templates['OrgIQ-Foundation'].Metadata['OrgIQ::Environment'], loadEnvironment('lab'));
  });

  test('names stay literal: no resource moves for lab', () => {
    const all = JSON.stringify(app.templates);
    for (const lit of ['"orgiq-middleware"', '/orgiq/span-projector/cursor', '/orgiq/canary/weight_b',
      'orgiq-span-projector', '/orgiq/memory/orgiq/id', 'agent.id=orgiq-supervisor']) {
      assert.ok(all.includes(lit), `${lit} missing`);
    }
  });

  test('a --context projectPrefix that disagrees with the environment is refused', () => {
    assert.throws(() => synthApp({ projectPrefix: 'other' }), /disagrees with environment "lab"/);
  });
});

describe('a second environment (pv1) shares no name with lab', () => {
  const pv1 = synthApp({ ...ALL, env: 'pv1', envDir: FIXTURES });
  const lab2 = synthApp(ALL);

  test('stack ids are OrgIQPv1-* and mirror lab one for one', () => {
    assert.deepEqual(pv1.stackNames, lab2.stackNames.map(n => n.replace('OrgIQ-', 'OrgIQPv1-')).sort());
    for (const n of pv1.stackNames) assert.equal(pv1.environments[n], `aws://${LAB_ACCOUNT}/us-east-1`);
  });

  test('no literal orgiq name or SSM path is left in any template', () => {
    // `/memory/orgiq/id` carries the TENANT name (orgiq is a tenant, not the prefix).
    const offenders: string[] = [];
    for (const [stack, template] of Object.entries(pv1.templates)) {
      const text = JSON.stringify(template);
      for (const m of text.matchAll(/"orgiq-[^"]*|[^"]{0,30}\/orgiq\/[^"]*/g)) {
        if (m[0].includes('/memory/orgiq/')) continue;
        offenders.push(`${stack}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('prefix-derived names moved: SSM paths, functions, rules, log groups, OTEL names', () => {
    const all = JSON.stringify(pv1.templates);
    for (const lit of ['/pv1/span-projector/cursor', '"pv1-span-projector"', '/pv1/canary/weight_b',
      '/pv1/canary/scores', '/pv1/memory/orgiq/id', 'agent.id=pv1-supervisor', 'pv1-middleware']) {
      assert.ok(all.includes(lit), `${lit} missing`);
    }
  });

  test('the environment file drives the budget', () => {
    const amounts = Object.values<any>(pv1.templates['OrgIQPv1-Observability'].Resources)
      .filter(r => r.Type === 'AWS::Budgets::Budget').map(r => r.Properties.Budget.BudgetLimit.Amount);
    assert.deepEqual(amounts, [50]);
  });
});

describe('cdk.json carries no account state', () => {
  const cdkJson = JSON.parse(fs.readFileSync(path.join(INFRA, 'cdk.json'), 'utf8'));
  test('no documentWorkspace block, no projectPrefix, no 12-digit account', () => {
    assert.equal(cdkJson.context.documentWorkspace, undefined);
    assert.equal(cdkJson.context.projectPrefix, undefined);
    assert.doesNotMatch(JSON.stringify(cdkJson), /\b\d{12}\b/);
  });
});

describe('deploy.sh and destroy.sh read the environment file, not shell defaults', () => {
  for (const script of ['deploy.sh', 'destroy.sh']) {
    test(`${script} has no PREFIX or region defaults and passes env to cdk`, () => {
      const code = fs.readFileSync(path.join(INFRA, 'scripts', script), 'utf8')
        .split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
      assert.doesNotMatch(code, /\$\{PREFIX:-/);
      assert.doesNotMatch(code, /\$\{AWS_DEFAULT_REGION:-/);
      assert.doesNotMatch(code, /\$\{AWS_REGION:-/);
      assert.match(code, /print-environment\.ts/);
      assert.match(code, /--context "env=\$\{ENV_NAME\}"/);
      assert.doesNotMatch(code, /"OrgIQ-[A-Za-z]/, 'a literal stack id would not follow stackPrefix');
    });
  }
});

describe('the account guard refuses before anything is swept', () => {
  function run(script: string, callerAccount: string, extraEnv: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-aws-'));
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'aws'), `#!/bin/bash
echo "$*" >> "${log}"
if [[ "$1 $2" == "sts get-caller-identity" ]]; then echo "${callerAccount}"; exit 0; fi
echo None
`);
    fs.chmodSync(path.join(dir, 'aws'), 0o755);
    const r = spawnSync('/bin/bash', [path.join(INFRA, 'scripts', script)], {
      cwd: INFRA, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ENV: 'lab', ...extraEnv },
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
    fs.rmSync(dir, { recursive: true, force: true });
    return { r, calls };
  }

  for (const script of ['deploy.sh', 'destroy.sh']) {
    for (const account of [PERSONAL, '111111111111']) {
      test(`${script} as ${account}: non-zero, one sts call, no delete or rb`, () => {
        const { r, calls } = run(script, account);
        assert.notEqual(r.status, 0, r.stdout + r.stderr);
        assert.match(r.stderr, new RegExp(`account ${account}`));
        assert.deepEqual(calls, ['sts get-caller-identity --query Account --output text']);
        assert.ok(!calls.some(c => /delete-|\brb\b|\bdelete\b/.test(c)));
      });
    }
  }

  test('a PREFIX that disagrees with the file is an error before any aws call', () => {
    const { r, calls } = run('deploy.sh', LAB_ACCOUNT, { PREFIX: 'other' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PREFIX=other disagrees with environment 'lab'/);
    assert.deepEqual(calls, []);
  });

  test('an unknown environment fails before any aws call', () => {
    const { r, calls } = run('destroy.sh', LAB_ACCOUNT, { ENV: 'nope' });
    assert.notEqual(r.status, 0);
    assert.deepEqual(calls, []);
  });
});
