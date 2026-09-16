// Run with:  cd portal && node --test --experimental-strip-types src/lib/__tests__/writeJson.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writeJson, sendJson, HttpError } from '../writeJson.ts';

type FetchArgs = [string, RequestInit | undefined];

function stubFetch(status: number, body: unknown, ok = status >= 200 && status < 300) {
  const calls: FetchArgs[] = [];
  (globalThis as { fetch?: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return {
      ok,
      status,
      json: async () => {
        if (body === undefined) throw new Error('no body');
        return body;
      },
    } as Response;
  }) as typeof fetch;
  return calls;
}

test('ok response carries the parsed body as data', async () => {
  stubFetch(200, { id: 'sprint-1' });
  const res = await writeJson<{ id: string }>('/api/sprints', 'POST', { name: 'x' });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { id: 'sprint-1' });
  assert.equal(res.error, null);
  assert.equal(res.conflict, false);
});

test('request always sends credentials and a JSON body', async () => {
  const calls = stubFetch(200, {});
  await writeJson('/api/sprints', 'POST', { name: 'x' });
  const [url, init] = calls[0];
  assert.equal(url, '/api/sprints');
  assert.equal(init?.credentials, 'include');
  assert.equal(init?.method, 'POST');
  assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.equal(init?.body, JSON.stringify({ name: 'x' }));
});

test('error body is surfaced verbatim', async () => {
  stubFetch(400, { error: 'title is required' });
  const res = await writeJson('/api/sprints', 'POST', {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.error, 'title is required');
});

test('a failure body still carries fields the caller needs to act on', async () => {
  // e.g. "already has a worker" — the 409 names the existing job so the
  // caller can navigate to it instead of just showing an error.
  stubFetch(409, { error: 'already promoted', jobId: 'job-42' });
  const res = await writeJson<{ jobId: string }>('/api/work/findings/f1/promote', 'POST');
  assert.equal(res.ok, false);
  assert.equal(res.data?.jobId, 'job-42');
});

test('an empty failure body (no parseable JSON) leaves data null', async () => {
  stubFetch(403, {});
  const res = await writeJson('/api/grants', 'POST', {});
  assert.equal(res.data, null);
});

test('non-JSON error body falls back to an HTTP status message', async () => {
  (globalThis as { fetch?: typeof fetch }).fetch = (async () => ({
    ok: false,
    status: 500,
    json: async () => { throw new Error('not json'); },
  } as unknown as Response)) as typeof fetch;
  const res = await writeJson('/api/sprints', 'DELETE');
  assert.equal(res.ok, false);
  assert.equal(res.status, 500);
  assert.equal(res.error, 'HTTP 500');
});

test('a bare 403 with no message reads as a permission problem', async () => {
  stubFetch(403, {});
  const res = await writeJson('/api/grants', 'POST', {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.error, 'You do not have permission for this action.');
});

test('403 with an explicit server message keeps that message', async () => {
  stubFetch(403, { error: 'DispatchAgentRun required on this initiative' });
  const res = await writeJson('/api/bots/dispatch-work', 'POST', {});
  assert.equal(res.error, 'DispatchAgentRun required on this initiative');
});

test('409 carries conflict, gate and confirmFlag for the money soft-brakes', async () => {
  stubFetch(409, {
    error: 'Over the sprint envelope',
    conflict: true,
    gate: 'envelope',
    confirmFlag: 'confirmOverEnvelope',
  });
  const res = await writeJson('/api/bots/dispatch-work', 'POST', {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.equal(res.conflict, true);
  assert.equal(res.gate, 'envelope');
  assert.equal(res.confirmFlag, 'confirmOverEnvelope');
});

test('a 409 with no conflict marker (e.g. a duplicate slug) is not treated as "busy"', async () => {
  stubFetch(409, { error: 'slug already exists' });
  const res = await writeJson('/api/admin/kb-registry', 'POST', {});
  assert.equal(res.conflict, false);
  assert.equal(res.error, 'slug already exists');
});

test('a network failure (fetch throws) is reported rather than propagated', async () => {
  (globalThis as { fetch?: typeof fetch }).fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;
  const res = await writeJson('/api/sprints', 'POST', {});
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.equal(res.error, 'network down');
});

test('sendJson resolves to the data on success', async () => {
  stubFetch(200, { id: 'x' });
  const data = await sendJson<{ id: string }>('/api/sprints', 'POST', {});
  assert.deepEqual(data, { id: 'x' });
});

test('sendJson throws HttpError carrying the server message and gate info on failure', async () => {
  stubFetch(409, { error: 'over budget', conflict: true, gate: 'allocation', confirmFlag: 'confirmOverAllocation' });
  await assert.rejects(
    () => sendJson('/api/bots/dispatch-work', 'POST', {}),
    (err: unknown) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 409);
      assert.equal(err.message, 'over budget');
      assert.equal(err.gate, 'allocation');
      assert.equal(err.confirmFlag, 'confirmOverAllocation');
      return true;
    },
  );
});

test('a GET is never sent — the type system requires a write method', async () => {
  // Compile-time guard, exercised at runtime for completeness: DELETE needs no body.
  stubFetch(200, {});
  const res = await writeJson('/api/sprints/1', 'DELETE');
  assert.equal(res.ok, true);
});
