// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactUrlCredentials } from '../redactCredentials.ts';

// The case this function exists for: git echoes the authed clone URL back in
// `fatal: unable to access`, and that line is what the clone flow throws into a
// toast when the failure isn't an access or network error.
test('redacts the token from a git "unable to access" fatal', () => {
  const out = redactUrlCredentials(
    "fatal: unable to access 'https://x-access-token:ghp_AbC123secret@github.com/acme/repo.git/': SSL certificate problem",
  );
  assert.ok(!out.includes('ghp_AbC123secret'), 'token must not survive');
  assert.match(out, /x-access-token:\*\*\*@github\.com/);
  // The rest of the message has to stay readable — it is why the user is
  // looking at the error at all.
  assert.match(out, /SSL certificate problem/);
});

test('redacts every occurrence, not just the first', () => {
  const out = redactUrlCredentials(
    'https://u1:s1@github.com/a.git and https://u2:s2@github.com/b.git',
  );
  assert.ok(!out.includes('s1'));
  assert.ok(!out.includes('s2'));
});

test('leaves text with no credentialed URL untouched', () => {
  for (const s of [
    'fatal: repository not found',
    'https://github.com/acme/repo.git',
    'Cloning into /mnt/workspace/repo...',
    'user@host:~$ echo hi',
    '',
  ]) {
    assert.equal(redactUrlCredentials(s), s);
  }
});

// Guards the bound that keeps the pattern from eating the remainder of a line:
// userinfo cannot contain whitespace, so an `@` later in prose is not a match.
test('does not swallow the line when an @ appears later in prose', () => {
  const s = 'cloned https://github.com/acme/repo.git — ask ops@example.com if it fails';
  assert.equal(redactUrlCredentials(s), s);
});

test('handles schemes other than https', () => {
  const out = redactUrlCredentials('git+ssh://bot:hunter2@example.com/x.git');
  assert.ok(!out.includes('hunter2'));
  assert.match(out, /git\+ssh:\/\/bot:\*\*\*@/);
});
