// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { githubRepoUrl } from '../repoLink.ts';

test('a repo slug becomes a github.com link', () => {
  assert.equal(
    githubRepoUrl('connorhoehnslalom/orgiq-observability'),
    'https://github.com/connorhoehnslalom/orgiq-observability',
  );
});

test('surrounding whitespace and stray slashes are trimmed', () => {
  assert.equal(githubRepoUrl('  owner/repo  '), 'https://github.com/owner/repo');
  assert.equal(githubRepoUrl('/owner/repo/'), 'https://github.com/owner/repo');
});

test('the interior slash is preserved, not percent-encoded', () => {
  assert.ok(!githubRepoUrl('owner/repo')!.includes('%2F'));
});

test('nothing to link returns null', () => {
  assert.equal(githubRepoUrl(null), null);
  assert.equal(githubRepoUrl(undefined), null);
  assert.equal(githubRepoUrl(''), null);
  assert.equal(githubRepoUrl('   '), null);
  assert.equal(githubRepoUrl('///'), null);
});
