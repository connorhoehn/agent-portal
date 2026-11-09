// scripts/portal-publish.mjs lives one level up (it is not a Docker build);
// it is tested here so `node --test scripts/docker/tests/*.test.mjs` covers it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOCAL_OVERRIDES, buildEnv, leakedEndpoints, oacStatement, parseArgs, planPublish, policyAdmitsDistribution,
  publishTargets, repairedPolicy, scanBundle,
} from '../../portal-publish.mjs';

const ARN = 'arn:aws:cloudfront::123456789012:distribution/E2EXAMPLE';
const BUCKET = 'orgiq-portal-123456789012-us-east-1';

test('the build blanks every local override, beating portal/.env.local', () => {
  const env = buildEnv({ VITE_GATEWAY_URL: 'http://localhost:3001', PATH: '/bin' });
  for (const k of LOCAL_OVERRIDES) assert.equal(env[k], '', `${k} not blanked`);
  assert.equal(env.PATH, '/bin');
  // …and they are exactly the three useRealtimeEndpoints treats as overrides.
  const hook = readFileSync(new URL('../../../portal/src/lib/useRealtimeEndpoints.ts', import.meta.url), 'utf8');
  for (const k of LOCAL_OVERRIDES) assert.match(hook, new RegExp(`env\\.${k}`));
});

test('a baked localhost endpoint is caught; a URL inside help text is not', () => {
  assert.deepEqual(leakedEndpoints('const u="http://localhost:3001";'), ['http://localhost:3001']);
  assert.deepEqual(leakedEndpoints("x='ws://127.0.0.1:18080/'"), ['ws://127.0.0.1:18080/']);
  assert.deepEqual(leakedEndpoints('requests.post("http://localhost:3001/api/observability/approvals/request")'), []);
  const files = { 'a.js': 'g="http://localhost:8080"', 'b.css': 'u="http://localhost:1"', 'c.js': 'ok' };
  assert.deepEqual(scanBundle(Object.keys(files), (f) => files[f]), ['a.js: http://localhost:8080']);
});

test('names come from the stack outputs, and a missing one is named', () => {
  const outputs = [
    { OutputKey: 'PortalBucketName', OutputValue: BUCKET },
    { OutputKey: 'PortalDistributionId', OutputValue: 'E2EXAMPLE' },
    { OutputKey: 'PortalDistributionArn', OutputValue: ARN },
    { OutputKey: 'PortalUrl', OutputValue: 'https://d111.cloudfront.net' },
  ];
  assert.equal(publishTargets(outputs).bucket, BUCKET);
  assert.throws(() => publishTargets(outputs.slice(1)), /bucket/);
  // The output keys are the ones OrgIQ-Portal declares.
  const stack = readFileSync(new URL('../../../infra/lib/portal-stack.ts', import.meta.url), 'utf8');
  for (const o of outputs) assert.match(stack, new RegExp(`CfnOutput\\(this, '${o.OutputKey}'`));
});

test('hashed assets are immutable, the rest no-cache, and the invalidation covers everything', () => {
  const [assets, rest, inval] = planPublish({ bucket: BUCKET, distributionId: 'E2EXAMPLE', region: 'us-east-1' });
  assert.ok(assets.includes('public,max-age=31536000,immutable') && !assets.includes('--delete'));
  assert.ok(rest.includes('no-cache') && rest.includes('--delete') && rest.includes('assets/*'));
  assert.deepEqual(inval.slice(-2), ['--paths', '/*']);
  assert.equal(planPublish({ bucket: BUCKET, distributionId: 'E', region: 'us-east-1', invalidate: false }).length, 2);
});

test('the OAC statement check, and its repair', () => {
  const live = { Version: '2012-10-17', Statement: [oacStatement(BUCKET, ARN)] };
  assert.ok(policyAdmitsDistribution(live, ARN));
  assert.ok(!policyAdmitsDistribution(live, `${ARN}OTHER`));
  assert.ok(!policyAdmitsDistribution(null, ARN));
  const other = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: '*' }] };
  const fixed = repairedPolicy(other, BUCKET, ARN);
  assert.equal(fixed.Statement.length, 2, 'existing statements are kept');
  assert.ok(policyAdmitsDistribution(fixed, ARN));
  assert.equal(repairedPolicy(live, BUCKET, ARN), live);
});

test('argument parsing', () => {
  const o = parseArgs(['--dry-run', '--skip-build', '--repair-bucket-policy', '--no-invalidate', '--stack', 'X']);
  assert.deepEqual([o.dryRun, o.skipBuild, o.repairPolicy, o.invalidate, o.stack], [true, true, true, false, 'X']);
  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});
