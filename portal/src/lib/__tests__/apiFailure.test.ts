import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiFailure, responseFailure } from '../apiFailure.ts';

test('only a 401 carrying the BFF provenance code is a session invalidation', () => {
  assert.equal(apiFailure(401, 'Unauthorized', { error: 'Session retired', code: 'SESSION_INVALID' }).kind, 'session-invalid');
  assert.equal(apiFailure(401, 'Unauthorized', { error: 'Gateway rejected its token' }).kind, 'http');
  assert.equal(apiFailure(403, 'Forbidden', { code: 'SESSION_INVALID' }).kind, 'forbidden');
  assert.equal(apiFailure(503, 'Unavailable', { code: 'SESSION_INVALID' }).kind, 'http');
});

test('a typed failure preserves server detail without consuming a shared Response', async () => {
  const response = new Response(JSON.stringify({ code: 'SESSION_INVALID', error: 'Sign in again' }), { status: 401, statusText: 'Unauthorized' });
  assert.deepEqual(await responseFailure(response), { kind: 'session-invalid', status: 401, code: 'SESSION_INVALID', message: '401 Unauthorized — Sign in again' });
  assert.equal((await response.json()).error, 'Sign in again');
});

test('a non-JSON upstream error remains a plain HTTP failure', async () => {
  const failure = await responseFailure(new Response('<h1>Unauthorized</h1>', { status: 401, statusText: 'Unauthorized' }));
  assert.deepEqual(failure, { kind: 'http', status: 401, code: null, message: '401 Unauthorized' });
});
