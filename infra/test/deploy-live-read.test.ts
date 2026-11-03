/**
 * deploy.sh's `live_read`: second-phase context is inferred from the live
 * account, and an inference that reads a FAILED query as "nothing live"
 * deploys without deployRuntimes / deployMiddlewareService and deletes them
 * (DE-16). The function is extracted from the real script and run against a
 * fake `aws` on PATH.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = readFileSync(join(__dirname, '..', 'scripts', 'deploy.sh'), 'utf8');
const fn = script.slice(script.indexOf('live_read() {'), script.indexOf('\n}\n', script.indexOf('live_read() {')) + 3);

function run(awsBehaviour: string, call = 'live_read OUT cloudformation describe-stacks --stack-name X') {
  const dir = mkdtempSync(join(tmpdir(), 'live-read-'));
  writeFileSync(join(dir, 'aws'), `#!/bin/bash\n${awsBehaviour}\n`);
  chmodSync(join(dir, 'aws'), 0o755);
  return spawnSync('bash', ['-c', `set -euo pipefail\n${fn}\n${call}\necho "OUT=[$OUT]"`], {
    env: { ...process.env, PATH: `${dir}:${process.env['PATH']}` }, encoding: 'utf8',
  });
}

describe('live_read', () => {
  test('returns what the account says', () => {
    const r = run('echo 8');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /OUT=\[8\]/);
  });

  test('"None" and a missing resource both read as absent', () => {
    assert.match(run('echo None').stdout, /OUT=\[\]/);
    const missing = run('echo "An error occurred (ValidationError): Stack with id X does not exist" >&2; exit 254');
    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /OUT=\[\]/);
    assert.match(run('echo "ParameterNotFound" >&2; exit 254').stdout, /OUT=\[\]/);
  });

  test('an expired session or throttling stops the deploy (75) instead of reading as "not live"', () => {
    for (const err of [
      'An error occurred (ExpiredToken): The security token included in the request is expired',
      'An error occurred (Throttling): Rate exceeded',
      'Could not connect to the endpoint URL',
    ]) {
      const r = run(`echo "${err}" >&2; exit 254`);
      assert.equal(r.status, 75, err);
      assert.doesNotMatch(r.stdout, /OUT=/, 'nothing after the failed read may run');
      assert.match(r.stderr, /Refusing to infer/);
    }
  });

  test('every inference read in deploy.sh goes through live_read, none swallows an error', () => {
    const block = script.slice(script.indexOf('Inferring second-phase context'), script.indexOf('── Running cdk deploy ──'));
    assert.doesNotMatch(block, /2>\/dev\/null \|\| (true|echo)/);
    assert.doesNotMatch(block, /\$\(aws /);
  });
});

test('bash -n accepts deploy.sh', () => {
  execFileSync('bash', ['-n', join(__dirname, '..', 'scripts', 'deploy.sh')]);
});

describe('second-phase inference carries every live choice forward', () => {
  // The block from ctx_given() to the cdk deploy, run against a fake account.
  const block = script.slice(script.indexOf('ctx_given() {'), script.indexOf('echo "── Running cdk deploy ──"'));
  const fakeAws = `
args="$*"
case "$args" in
  *"list-stack-resources --stack-name OrgIQ-AgentCoreRuntime"*"LogicalResourceId"*) printf 'SupervisorRuntime\tSearchRuntime\n' ;;
  *"list-stack-resources --stack-name OrgIQ-AgentCoreRuntime"*) echo 2 ;;
  *"describe-stacks --stack-name OrgIQ-SocialMedia"*"StackStatus"*) echo UPDATE_COMPLETE ;;
  *"describe-stacks --stack-name OrgIQ-SocialMedia"*"TurnPublicIp"*) echo 3.3.3.3 ;;
  *"describe-stacks --stack-name OrgIQ-SocialMedia"*"TurnAllowedCidrs"*) echo 9.179.13.10/32 ;;
  *"describe-stacks --stack-name OrgIQ-Devbox"*"StackStatus"*) echo UPDATE_COMPLETE ;;
  *"describe-stacks --stack-name OrgIQ-Devbox"*"DevboxRuntimeArn"*) echo arn:aws:bedrock-agentcore:us-east-1:647757222309:runtime/orgiq_devbox ;;
  *"describe-stacks --stack-name OrgIQ-Devbox"*"DevboxOrgAccess"*) echo true ;;
  *"describe-stacks --stack-name OrgIQ-Devbox"*"DevboxLabApiBase"*) echo https://d1.cloudfront.net ;;
  *"get-secret-value --secret-id orgiq-lab-callback-secret"*) echo s3cret ;;
  *"describe-stacks"*"StackStatus"*) echo "Stack with id X does not exist" >&2; exit 254 ;;
  *"describe-stacks"*) echo None ;;
  *"ecs describe-services"*) echo None ;;
  *"get-secret-value"*) echo "ResourceNotFoundException" >&2; exit 254 ;;
  *"ssm get-parameter"*) echo "ParameterNotFound" >&2; exit 254 ;;
  *) echo None ;;
esac`;

  test('runtimes, devbox (org access, lab), and TURN with its allowlist are inferred; the secret is never echoed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infer-'));
    writeFileSync(join(dir, 'aws'), `#!/bin/bash\n${fakeAws}\n`);
    chmodSync(join(dir, 'aws'), 0o755);
    const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nREGION=us-east-1 PREFIX=orgiq STACK_PREFIX=OrgIQ- CDK_ARGS=()\n${block}\nprintf '%s\\n' "\${INFERRED[@]}"`], {
      env: { ...process.env, PATH: `${dir}:${process.env['PATH']}` }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    for (const ctx of ['deployRuntimes=true', 'liveRuntimeIds=SupervisorRuntime,SearchRuntime', 'deployDevbox=true', 'devboxOrgAccess=true',
      'labApiBase=https://d1.cloudfront.net', 'labCallbackSecret=s3cret', 'deployTurn=true', 'turnAllowCidr=9.179.13.10/32']) {
      assert.ok(r.stdout.includes(ctx), `missing --context ${ctx}\n${r.stdout}`);
    }
    // The shown list (printed to the operator) masks the secret.
    assert.match(r.stdout, /labCallbackSecret=<from Secrets Manager>/);
    assert.doesNotMatch(r.stdout.split('── Inferring')[1] ?? '', /--context labCallbackSecret=s3cret/);
  });

  // A fresh account part-way through: each producer-live flag appears only once
  // the parameter it guards exists (lib/middleware-service-stack.ts socialLive).
  const inferAgainst = (cases: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'infer-fresh-'));
    writeFileSync(join(dir, 'aws'), `#!/bin/bash
args="$*"
case "$args" in
${cases}
  *"describe-stacks"*"StackStatus"*) echo "Stack with id X does not exist" >&2; exit 254 ;;
  *"ssm get-parameter"*) echo "ParameterNotFound" >&2; exit 254 ;;
  *"get-secret-value"*) echo "ResourceNotFoundException" >&2; exit 254 ;;
  *) echo None ;;
esac
`);
    chmodSync(join(dir, 'aws'), 0o755);
    const r = spawnSync('/bin/bash', ['-c', `set -euo pipefail\nREGION=us-east-1 PREFIX=orgiq STACK_PREFIX=OrgIQ- CDK_ARGS=()\n${block}\nprintf '%s\\n' "\${INFERRED[@]+"\${INFERRED[@]}"}"`], {
      env: { ...process.env, PATH: `${dir}:${process.env['PATH']}` }, encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter((l) => l && l !== '--context');
  };

  test('nothing live: no producer-live flag, no socialPortalOrigin', () => {
    const got = inferAgainst('');
    for (const k of ['socialLive', 'portalPlatformApiUrlLive', 'portalVideoUrlLive', 'socialPortalOrigin', 'portalPublicUrls']) {
      assert.ok(!got.some((c) => c.startsWith(`${k}=`)), `${k} inferred on an empty account: ${got.join(' ')}`);
    }
  });

  test('portal live with its social URLs, Social not yet: the portal flags and socialPortalOrigin, never socialLive', () => {
    const got = inferAgainst(`
  *"describe-stacks --stack-name OrgIQ-Portal"*"PortalUrl"*) echo https://d1.cloudfront.net ;;
  *"get-parameter --name /orgiq/portal/url"*) echo https://d1.cloudfront.net ;;
  *"get-parameter --name /orgiq/portal/platform-api-url"*) echo https://d2.cloudfront.net ;;
  *"get-parameter --name /orgiq/portal/video-url"*) echo https://d3.cloudfront.net ;;
  *"get-parameter --name /orgiq/social/redis-url"*) echo redis://should-not-be-read:6379 ;;`);
    for (const ctx of ['portalPublicUrls=true', 'portalPlatformApiUrlLive=true', 'portalVideoUrlLive=true', 'socialPortalOrigin=https://d1.cloudfront.net']) {
      assert.ok(got.includes(ctx), `missing ${ctx}: ${got.join(' ')}`);
    }
    assert.ok(!got.some((c) => c.startsWith('socialLive=') || c.startsWith('deploySocial=')), 'Social is not live');
  });

  test('portal live without its social distributions: no portal URL flags', () => {
    const got = inferAgainst(`
  *"describe-stacks --stack-name OrgIQ-Portal"*"PortalUrl"*) echo https://d1.cloudfront.net ;;
  *"get-parameter --name /orgiq/portal/url"*) echo https://d1.cloudfront.net ;;`);
    assert.ok(got.includes('portalPublicUrls=true'));
    assert.ok(!got.some((c) => /^portal(PlatformApi|Video)UrlLive=/.test(c)), got.join(' '));
  });

  test('OrgIQ-Social live: socialLive only once its Redis parameter exists', () => {
    const social = `
  *"describe-stacks --stack-name OrgIQ-Social"*"StackStatus"*) echo UPDATE_COMPLETE ;;`;
    assert.ok(!inferAgainst(social).includes('socialLive=true'), 'no parameter, no socialLive');
    const got = inferAgainst(`${social}
  *"get-parameter --name /orgiq/social/redis-url"*) echo redis://cache:6379 ;;`);
    assert.ok(got.includes('deploySocial=true') && got.includes('socialLive=true'), got.join(' '));
    assert.ok(!got.some((c) => c.includes('redis://')), 'the Redis URL itself is never passed as context');
  });
});
