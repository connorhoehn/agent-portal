import assert from 'node:assert/strict';
import test from 'node:test';
import { draftFromParams, obstaclesQuery, repoName, writeRunbookHref } from '../obstaclesModel.ts';

test('the write-a-runbook link carries the obstacle and its scope, and the form reads them back', () => {
  const href = writeRunbookHref({ text: 'The CSRF check failed & blocked the push.', scope: { kind: 'repo', ref: 'org/auth' } });
  const params = new URL(href, 'http://x').searchParams;
  assert.deepEqual(draftFromParams(params), { description: 'The CSRF check failed & blocked the push.', scopeKind: 'repo', scopeRef: 'org/auth' });
});

test('a library URL without new=1 opens no form, and a bad scope kind is ignored', () => {
  assert.equal(draftFromParams(new URLSearchParams('description=x')), null);
  assert.deepEqual(draftFromParams(new URLSearchParams('new=1&scopeKind=org&scopeRef=x')), { scopeRef: 'x' });
});

test('the query lists only the filters that are set; repoName takes the last segment', () => {
  assert.equal(obstaclesQuery({ initiative: '', repo: '', days: '' }), '');
  assert.equal(obstaclesQuery({ initiative: 'p-1', repo: '', days: '7' }), '?initiative=p-1&days=7');
  assert.equal(repoName('org/svc.git'), 'svc');
});
