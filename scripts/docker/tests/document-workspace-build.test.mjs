import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { archiveCommittedSource, resolveCommittedRepository, defaultImages, sourceManifest } from '../document-workspace-build.mjs';

test('Docker source archives exclude both dirty tracked content and private untracked files', () => {
  const repository = mkdtempSync(resolve(tmpdir(), 'document-source-test-'));
  const output = mkdtempSync(resolve(tmpdir(), 'document-source-archive-'));
  const git = args => execFileSync('git', ['-C', repository, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  try {
    git(['init']); writeFileSync(resolve(repository, 'source.txt'), 'committed source'); git(['add', 'source.txt']);
    git(['-c', 'user.name=Archive Test', '-c', 'user.email=archive@example.test', 'commit', '-m', 'fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    writeFileSync(resolve(repository, 'source.txt'), 'unrelated dirty source');
    writeFileSync(resolve(repository, '.env'), 'DO_NOT_COPY=private-test-value');
    archiveCommittedSource(repository, commit, output);
    assert.equal(readFileSync(resolve(output, 'source.txt'), 'utf8'), 'committed source');
    assert.equal(existsSync(resolve(output, '.env')), false);
    assert.equal(existsSync(resolve(output, '.git')), false);
    assert.throws(() => archiveCommittedSource(repository, 'main', output), /full immutable commit/);
    const cache = resolve(output, 'bare-cache.git');
    const fetched = resolveCommittedRepository({ url: repository, commit }, { sibling: resolve(output, 'missing-sibling'), cache });
    assert.equal(fetched, cache);
    assert.equal(execFileSync('git', ['-C', cache, 'rev-parse', '--is-bare-repository'], { encoding: 'utf8' }).trim(), 'true');
    const freshOutput = resolve(output, 'fresh-checkout-context');
    archiveCommittedSource(fetched, commit, freshOutput);
    assert.equal(readFileSync(resolve(freshOutput, 'source.txt'), 'utf8'), 'committed source');
    assert.equal(existsSync(resolve(freshOutput, '.env')), false);
  } finally { rmSync(repository, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }); }
});
test('default image selection never relies on an earlier codex image or mutable Redis tag', () => {
  const images = defaultImages();
  assert.equal(Object.keys(images).length, 6);
  assert.match(images.REDIS_IMAGE, /^redis@sha256:[a-f0-9]{64}$/);
  for (const [key, value] of Object.entries(images)) if (key !== 'REDIS_IMAGE') assert.match(value, /:document-[a-f0-9]{12}$/);
  for (const source of Object.values(sourceManifest.sources)) assert.match(source.commit, /^[a-f0-9]{40}$/);
});
