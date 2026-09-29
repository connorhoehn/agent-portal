import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digestFromMetadata, parseArgs, planSocialImages, socialImageDefinitions, socialSources } from '../social-images-build.mjs';

const infra = (file) => readFileSync(new URL(`../../../infra/lib/${file}`, import.meta.url), 'utf8');
const plan = (extra = {}) => planSocialImages({ account: '647757222309', region: 'us-east-1', contextRoot: '/ctx', stateDir: '/state', ...extra });

test('repo names and digest contexts match the CDK stacks', () => {
  const repos = infra('social-images-stack.ts');
  for (const d of socialImageDefinitions) assert.match(repos, new RegExp(`${d.key}: '${d.repo}'`), `${d.key} → ${d.repo}`);
  assert.match(infra('social-media-stack.ts'), /tryGetContext\('sfuImageDigest'\)/);
  assert.match(infra('social-stack.ts'), /ctx\('platformApiImageDigest'\)/);
});

test('every social source is pinned to a full commit, live-video-streaming included', () => {
  const sources = socialSources();
  assert.deepEqual(Object.keys(sources).sort(), ['live-video-streaming', 'platform-api', 'realtime-examples']);
  for (const s of Object.values(sources)) assert.match(s.commit, /^[a-f0-9]{40}$/);
});

test('builds are ARM64 single-manifest pushes to the account registry, tagged by commit', () => {
  const p = plan();
  assert.equal(p.registry, '647757222309.dkr.ecr.us-east-1.amazonaws.com');
  for (const image of p.images) {
    const a = image.args;
    assert.deepEqual(a.slice(0, 4), ['buildx', 'build', '--platform', 'linux/arm64']);
    assert.ok(a.includes('--provenance=false') && a.includes('--push'));
    assert.ok(a.includes(`${p.registry}/${image.repository}:${image.commit.slice(0, 12)}`));
    assert.equal(a[a.indexOf('--metadata-file') + 1], `/state/${image.key}.metadata.json`);
    assert.equal(a.at(-1), image.context);
  }
  const byKey = Object.fromEntries(p.images.map(i => [i.key, i]));
  assert.equal(byKey.gateway.args[byKey.gateway.args.indexOf('--target') + 1], 'server-runtime');
  // platform-api's Dockerfile COPYs platform-api/…: the context is its parent, holding only that checkout.
  assert.equal(byKey.platformApi.context, resolve('/ctx/platformApi'));
  assert.equal(byKey.platformApi.args[byKey.platformApi.args.indexOf('-f') + 1], resolve('/ctx/platformApi/platform-api/Dockerfile'));
  assert.ok(byKey.sfu.args.includes('id=gh-token,env=GH_TOKEN'));
  assert.ok(!byKey.sfu.args.includes('--ssh'));
});

test('the forbidden personal account and malformed ids are refused; --only filters', () => {
  assert.throws(() => plan({ account: '264161986065' }), /must never be used/);
  assert.throws(() => plan({ account: 'abc' }), /Not an AWS account/);
  assert.deepEqual(plan({ only: ['sfu'] }).images.map(i => i.key), ['sfu']);
  assert.throws(() => parseArgs(['--only', 'nope']), /--only takes/);
  assert.equal(parseArgs(['--dry-run']).dryRun, true);
});

test('the digest comes from buildx metadata in the form the stacks validate', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.equal(digestFromMetadata({ 'containerimage.digest': digest }), digest);
  assert.throws(() => digestFromMetadata({}), /no containerimage.digest/);
});
