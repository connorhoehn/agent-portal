import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs, planMiddlewareImage } from '../middleware-image-build.mjs';

const COMMIT = 'a'.repeat(40);
const plan = (extra = {}) => planMiddlewareImage({
  account: '647757222309', region: 'us-east-1', commit: COMMIT, context: '/ctx/middleware',
  librariesDir: '/repo/.docker-libraries', metadataFile: '/state/metadata.json', ...extra,
});

test('an ARM64 single-manifest push of the production stage, to the repo the stack pulls', () => {
  const p = plan();
  assert.deepEqual(p.args.slice(0, 4), ['buildx', 'build', '--platform', 'linux/arm64']);
  assert.ok(p.args.includes('--provenance=false') && p.args.includes('--sbom=false') && p.args.includes('--push'));
  assert.equal(p.args[p.args.indexOf('--target') + 1], 'production');
  // The stack pulls `:latest` (middleware-service-stack.ts fromEcrRepository(repo, 'latest')).
  assert.ok(p.args.includes('647757222309.dkr.ecr.us-east-1.amazonaws.com/orgiq-middleware:latest'));
  assert.ok(p.args.includes(`647757222309.dkr.ecr.us-east-1.amazonaws.com/orgiq-middleware:${COMMIT.slice(0, 12)}`));
  assert.equal(p.args.at(-1), '/ctx/middleware');
  const stack = readFileSync(new URL('../../../infra/lib/middleware-service-stack.ts', import.meta.url), 'utf8');
  assert.match(stack, /repositoryName: `\$\{prefix\}-middleware`/);
  assert.match(stack, /fromEcrRepository\(repo, 'latest'\)/);
});

test('libraries come from the locked commits prepare-libraries exports, as the Dockerfile expects', () => {
  const p = plan();
  assert.equal(p.args[p.args.indexOf('--build-context') + 1], 'locked_libraries=/repo/.docker-libraries');
  const dockerfile = readFileSync(new URL('../../../middleware/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY --from=locked_libraries/);
  assert.match(dockerfile, /AS production/);
});

test('refuses the forbidden personal account and anything that is not a full commit', () => {
  assert.throws(() => plan({ account: '264161986065' }), /never be used/);
  assert.throws(() => plan({ commit: 'abc123' }), /full commit/);
  assert.throws(() => plan({ account: 'nope' }), /Not an AWS account/);
});

test('the rollout it prints is the one the ALB-only runbook uses', () => {
  const p = plan();
  assert.match(p.rollout, /update-service .*--cluster orgiq-middleware --service orgiq-middleware --force-new-deployment/);
  assert.match(p.verify, /desiredCount,runningCount/);
});

test('argument parsing', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--working-tree', '--region', 'us-west-2']).region, 'us-west-2');
  assert.equal(parseArgs(['--working-tree']).workingTree, true);
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/);
});
