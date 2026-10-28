// src/routes/__tests__/internal-devbox.test.ts
//
// Unit tests for the internal HMAC-only devbox router (internal-devbox.ts) —
// the computer lab surface platform-api's chat agent loop calls. Covers:
//   1. Envelope rejection: no header, a stale one, and a bad signature → 401
//   2. A browser session alone (no envelope) still 401s — no session fallback
//   3. sessions → task → tail round trip in mock mode: re-framed frame
//      shapes, growing usage across resumed calls, and DONE on the third
//      resumed task, replayed correctly by the tail

import http from 'node:http';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import request, { attachToSharedServer } from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signEnvelope } from '@connorhoehn/service-runtime';
import { internalDevboxRouter } from '../internal-devbox.js';
import { userStewardsInitiative } from '../../lib/initiative-scope.js';
import { _resetFleet, getBox, listBoxes } from '../../lib/devbox-fleet.js';
import { _resetLoopMock } from '../../mock/devbox-agent-loop.js';
import { isValidFileId } from '../../lib/devbox-files.js';

jest.mock('../../lib/initiative-scope.js', () => ({
  ...jest.requireActual('../../lib/initiative-scope.js'),
  userStewardsInitiative: jest.fn(async () => false),
}));
const stewards = userStewardsInitiative as jest.MockedFunction<typeof userStewardsInitiative>;

const SECRET = 'devbox-internal-test-secret';
const originalEnv = { ...process.env };

function app(): express.Express {
  const value = express();
  value.use(express.json());
  value.use('/internal/devbox', internalDevboxRouter);
  return value;
}

/** Same app, but with a browser session attached — for the "cookie alone
 *  cannot call this" test. The router must never look at `req.session`. */
function appWithBrowserSession(): express.Express {
  const value = express();
  value.use(express.json());
  value.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: unknown }).session = {
      sub: 'u-browser', role: 'hr-admin', tenant: 'orgiq', grants: {}, iat: 0,
    };
    next();
  });
  value.use('/internal/devbox', internalDevboxRouter);
  return value;
}

function signed(body: object, serviceId = 'platform-api'): Record<string, string> {
  return { [SERVICE_AUTH_HEADER]: signEnvelope(body, { secret: SECRET, serviceId }) };
}

/** Signs as of 60s ago — past the router's 30s ttl + 5s tolerance. */
function signedStale(body: object, serviceId = 'platform-api'): Record<string, string> {
  const real = Date.now;
  Date.now = () => real() - 60_000;
  try {
    return { [SERVICE_AUTH_HEADER]: signEnvelope(body, { secret: SECRET, serviceId }) };
  } finally {
    Date.now = real;
  }
}

function principal(requestedBy = 'u-loop-owner') {
  return { service: 'platform-api', requestedBy };
}

beforeEach(() => {
  process.env['WORK_GRAPH_SERVICE_AUTH_SECRET'] = SECRET;
  delete process.env['WORK_GRAPH_PLATFORM_SERVICE_ID'];
  delete process.env['SERVICE_AUTH_SECRET'];
  _resetFleet();
  _resetLoopMock();
});

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

// ─── 1 & 2. Envelope rejection, and no session-cookie fallback ─────────────

describe('internal devbox router — envelope', () => {
  it('401s a request with no X-Service-Auth header', async () => {
    const res = await request(app()).get('/internal/devbox/status');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'SERVICE_AUTH_INVALID' });
  });

  it('401s a stale envelope (past the 30s ttl + 5s tolerance)', async () => {
    const res = await request(app()).get('/internal/devbox/status').set(signedStale({}));
    expect(res.status).toBe(401);
  });

  it('401s a bad signature — tampered body after signing', async () => {
    const body = { principal: principal(), label: 'x' };
    const res = await request(app())
      .post('/internal/devbox/sessions')
      .set(signed(body))
      .send({ ...body, label: 'tampered' });
    expect(res.status).toBe(401);
  });

  it('401s a signature from a service not on the allow-list', async () => {
    const res = await request(app()).get('/internal/devbox/status').set(signed({}, 'untrusted-service'));
    expect(res.status).toBe(401);
  });

  it('a browser session cookie alone cannot call this router — no envelope, no access', async () => {
    const res = await request(appWithBrowserSession()).get('/internal/devbox/status');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'SERVICE_AUTH_INVALID' });
  });

  it('rejects a signed body whose declared principal does not match the signing service', async () => {
    const body = { principal: { service: 'someone-else', requestedBy: 'u-1' }, label: 'x' };
    // Signed AS platform-api (passes the envelope check) but the body claims
    // to be a different principal — the extra body-level check must catch it.
    const res = await request(app()).post('/internal/devbox/sessions').set(signed(body)).send(body);
    expect(res.status).toBe(400);
  });
});

describe('internal devbox router — initiative charge', () => {
  it('charges a box to an initiative the requesting user stewards', async () => {
    stewards.mockResolvedValueOnce(true);
    const body = { principal: principal('u-loop-owner'), label: 'x', projectId: ' p-auth-migration ' };
    const res = await request(app()).post('/internal/devbox/sessions').set(signed(body)).send(body);
    expect(res.status).toBe(201);
    expect(stewards).toHaveBeenLastCalledWith('u-loop-owner', 'p-auth-migration');
    expect(getBox(res.body.boxId)?.projectId).toBe('p-auth-migration');
  });

  it('403s a projectId the requesting user does not steward, and registers nothing', async () => {
    stewards.mockResolvedValueOnce(false);
    const body = { principal: principal('u-stranger'), label: 'x', projectId: 'p-auth-migration' };
    const res = await request(app()).post('/internal/devbox/sessions').set(signed(body)).send(body);
    expect(res.status).toBe(403);
    expect(res.body.boxId).toBeUndefined();
    expect(listBoxes()).toHaveLength(0);
  });

  it('asks nothing when no projectId is given', async () => {
    stewards.mockClear();
    const body = { principal: principal(), label: 'x' };
    const res = await request(app()).post('/internal/devbox/sessions').set(signed(body)).send(body);
    expect(res.status).toBe(201);
    expect(stewards).not.toHaveBeenCalled();
  });
});

// ─── 3. sessions → task → tail round trip, mock mode ───────────────────────

describe('internal devbox router — mock loop round trip', () => {
  const originalMock = process.env['MOCK_AGENTCORE'];

  beforeEach(() => {
    process.env['MOCK_AGENTCORE'] = 'true';
  });

  afterEach(() => {
    if (originalMock === undefined) delete process.env['MOCK_AGENTCORE'];
    else process.env['MOCK_AGENTCORE'] = originalMock;
  });

  async function createSession(): Promise<{ sessionId: string; boxId: string }> {
    const body = { principal: principal(), label: 'agent-loop-1' };
    const res = await request(app()).post('/internal/devbox/sessions').set(signed(body)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.sessionId.length).toBeGreaterThanOrEqual(33);
    return res.body as { sessionId: string; boxId: string };
  }

  /** Parses `data: {...}\n\n` frames out of a finite SSE response body. */
  function parseFrames(text: string): Record<string, unknown>[] {
    return text
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data:'))
      .map((chunk) => JSON.parse(chunk.slice('data:'.length).trim()) as Record<string, unknown>);
  }

  async function runTask(sessionId: string, prompt: string, resume: boolean) {
    const body = { principal: principal(), prompt, resume };
    const res = await request(app()).post(`/internal/devbox/${sessionId}/task`).set(signed(body)).send(body);
    expect(res.status).toBe(200);
    return parseFrames(res.text);
  }

  it('re-frames mock stream-json flat, with mock:true on every frame', async () => {
    const { sessionId } = await createSession();
    const frames = await runTask(sessionId, 'Draft the meeting agenda', false);

    const types = frames.map((f) => f['type']);
    expect(types).toEqual(['assistant', 'tool_use', 'tool_result', 'result']);
    expect(frames.every((f) => f['mock'] === true)).toBe(true);

    const toolUse = frames.find((f) => f['type'] === 'tool_use')!;
    const toolResult = frames.find((f) => f['type'] === 'tool_result')!;
    expect(toolResult['tool_use_id']).toBe(toolUse['id']);

    const result = frames.find((f) => f['type'] === 'result')!;
    expect(result['usage']).toMatchObject({
      input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: expect.any(Number),
    });
  });

  it('honours resume: growing cumulative context, DONE only on the 3rd resumed task', async () => {
    const { sessionId } = await createSession();

    const first = await runTask(sessionId, 'Build the deck from the board meeting', false);
    const second = await runTask(sessionId, 'Continue the same task.', true);
    const third = await runTask(sessionId, 'Continue the same task.', true);
    const fourth = await runTask(sessionId, 'Continue the same task.', true);

    const usage = (frames: Record<string, unknown>[]) =>
      (frames.find((f) => f['type'] === 'result')!['usage']) as {
        input_tokens: number; output_tokens: number;
        cache_read_input_tokens: number; cache_creation_input_tokens: number;
      };
    const prompt = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }) =>
      u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;

    const u1 = usage(first);
    const u2 = usage(second);
    const u3 = usage(third);
    const u4 = usage(fourth);

    // Cumulative context (the number a real loop compares against
    // contextBudgetTokens) strictly grows by the resume increment each time.
    expect(prompt(u1)).toBe(42_000);
    expect(prompt(u2)).toBe(77_000);
    expect(prompt(u3)).toBe(112_000);
    expect(prompt(u4)).toBe(147_000);
    // A resumed call's cache-read is exactly the PRIOR cumulative context —
    // the "re-reading the whole conversation so far" story.
    expect(u2.cache_read_input_tokens).toBe(42_000);
    expect(u3.cache_read_input_tokens).toBe(77_000);
    expect(u4.cache_read_input_tokens).toBe(112_000);

    const resultText = (frames: Record<string, unknown>[]) =>
      String((frames.find((f) => f['type'] === 'result')!['result']));

    expect(resultText(first).trim().split('\n').pop()).not.toBe('DONE');
    expect(resultText(second).trim().split('\n').pop()).not.toBe('DONE');
    expect(resultText(third).trim().split('\n').pop()).not.toBe('DONE');
    // The third RESUMED task (the 4th call overall) is the one that finishes.
    expect(resultText(fourth).trim().split('\n').pop()).toBe('DONE');
  });

  it('a fresh (non-resumed) task after a resumed run resets tracking', async () => {
    const { sessionId } = await createSession();
    await runTask(sessionId, 'first', false);
    await runTask(sessionId, 'second', true);
    const resetRun = await runTask(sessionId, 'restart', false);
    const usage = resetRun.find((f) => f['type'] === 'result')!['usage'] as { cache_read_input_tokens: number };
    expect(usage.cache_read_input_tokens).toBe(0);
  });

  /**
   * Reads a finite prefix of a live SSE response over a raw socket — supertest
   * buffers the whole response, which a stream that stays open for a live tail
   * does not produce. Same pattern as local-compute-routes.test.ts's
   * `readStream`, against this file's shared server.
   */
  function readTail(
    testApp: express.Express,
    path: string,
    headers: Record<string, string>,
    until: (buf: string) => boolean,
    timeoutMs = 500,
  ): Promise<string> {
    const { port, headers: appHeaders } = attachToSharedServer(testApp);
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port, path, headers: { ...appHeaders, ...headers } },
        (res) => {
          let buf = '';
          const done = () => { clearTimeout(timer); req.destroy(); resolve(buf); };
          const timer = setTimeout(done, timeoutMs);
          res.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            if (until(buf)) done();
          });
          res.on('error', () => done());
        },
      );
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve('');
        else reject(err);
      });
    });
  }

  it('the tail replays the mock task frames it appended to the fleet log', async () => {
    const { sessionId, boxId } = await createSession();
    await runTask(sessionId, 'Draft the meeting agenda', false);

    const tailHeaders = signed({ boxId });
    const buf = await readTail(
      app(),
      `/internal/devbox/boxes/${boxId}/tail`,
      tailHeaders,
      (b) => b.includes('"type":"result"'),
    );

    expect(buf).toContain('"type":"task_started"');
    expect(buf).toContain('"type":"assistant"');
    expect(buf).toContain('"type":"tool_use"');
    expect(buf).toContain('"type":"tool_result"');
    expect(buf).toContain('"type":"result"');
    expect(buf).toContain('"mock":true');
  });

  it('404s a tail for an unknown boxId even with a valid envelope', async () => {
    const boxId = 'no-such-box';
    const res = await request(app()).get(`/internal/devbox/boxes/${boxId}/tail`).set(signed({ boxId }));
    expect(res.status).toBe(404);
  });
});

// ─── 4. Workspace files (mock mode) ─────────────────────────────────────────

describe('internal devbox router — workspace files (mock)', () => {
  const originalMock = process.env['MOCK_AGENTCORE'];

  beforeEach(() => {
    process.env['MOCK_AGENTCORE'] = 'true';
  });

  afterEach(() => {
    if (originalMock === undefined) delete process.env['MOCK_AGENTCORE'];
    else process.env['MOCK_AGENTCORE'] = originalMock;
  });

  async function createSession(): Promise<{ sessionId: string; boxId: string }> {
    const body = { principal: principal(), label: 'agent-loop-files' };
    const res = await request(app()).post('/internal/devbox/sessions').set(signed(body)).send(body);
    expect(res.status).toBe(201);
    return res.body as { sessionId: string; boxId: string };
  }

  async function runTask(sessionId: string, prompt: string, resume: boolean) {
    const body = { principal: principal(), prompt, resume };
    const res = await request(app()).post(`/internal/devbox/${sessionId}/task`).set(signed(body)).send(body);
    expect(res.status).toBe(200);
  }

  it('401s the files list and the file fetch with no valid envelope', async () => {
    const sessionId = 'orgiq-devbox-test-session-000000000000000';
    const listRes = await request(app()).get(`/internal/devbox/${sessionId}/files`);
    expect(listRes.status).toBe(401);
    const fetchRes = await request(app()).get(`/internal/devbox/${sessionId}/files/notes.md`);
    expect(fetchRes.status).toBe(401);
  });

  it('lists and fetches the real notes.md the mock loop wrote, round trip', async () => {
    const { sessionId } = await createSession();
    await runTask(sessionId, 'Draft the meeting agenda', false);

    const listRes = await request(app())
      .get(`/internal/devbox/${sessionId}/files`)
      .set(signed({ sessionId }));
    expect(listRes.status).toBe(200);
    expect(listRes.body.files).toEqual([
      expect.objectContaining({ id: 'notes.md', name: 'notes.md', sizeBytes: expect.any(Number), updatedAt: expect.any(String) }),
    ]);
    expect(listRes.body.files[0].sizeBytes).toBeGreaterThan(0);

    const fetchRes = await request(app())
      .get(`/internal/devbox/${sessionId}/files/notes.md`)
      .set(signed({ sessionId, fileId: 'notes.md' }));
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.headers['content-type']).toMatch(/text\/markdown/);
    expect(fetchRes.text).toContain(`# Notes — ${sessionId}`);
    expect(fetchRes.text).toContain('Draft the meeting agenda');
  });

  it('appends further iterations to the same notes.md on resume', async () => {
    const { sessionId } = await createSession();
    await runTask(sessionId, 'Draft the meeting agenda', false);
    await runTask(sessionId, 'Continue the same task.', true);

    const fetchRes = await request(app())
      .get(`/internal/devbox/${sessionId}/files/notes.md`)
      .set(signed({ sessionId, fileId: 'notes.md' }));
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.text).toContain('Iteration 1');
    expect(fetchRes.text).toContain('Iteration 2');
  });

  it('404s a listing for a session with no workspace, and a fetch for an unknown file', async () => {
    const { sessionId } = await createSession();

    const listRes = await request(app())
      .get(`/internal/devbox/${sessionId}/files`)
      .set(signed({ sessionId }));
    expect(listRes.status).toBe(200);
    expect(listRes.body.files).toEqual([]);

    const fetchRes = await request(app())
      .get(`/internal/devbox/${sessionId}/files/nope.md`)
      .set(signed({ sessionId, fileId: 'nope.md' }));
    expect(fetchRes.status).toBe(404);
  });

  it('refuses a path-traversal fileId with 400, never touching the filesystem outside the workspace', async () => {
    const { sessionId } = await createSession();
    await runTask(sessionId, 'Draft the meeting agenda', false);

    // Each of these arrives as a single decoded route param (the embedded
    // '/' travels URL-encoded, so Express never splits it into extra path
    // segments) — exactly what a caller trying to climb out of the
    // workspace/temp-dir would send.
    const traversalIds = ['../notes.md', '../../etc/passwd', '..%2Fnotes.md'];
    for (const fileId of traversalIds) {
      const res = await request(app())
        .get(`/internal/devbox/${sessionId}/files/${encodeURIComponent(fileId)}`)
        .set(signed({ sessionId, fileId }));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid fileId/);
    }
  });

  it('isValidFileId rejects bare "." and ".." and any embedded slash', () => {
    expect(isValidFileId('.')).toBe(false);
    expect(isValidFileId('..')).toBe(false);
    expect(isValidFileId('../notes.md')).toBe(false);
    expect(isValidFileId('a/b')).toBe(false);
    expect(isValidFileId('notes.md')).toBe(true);
  });
});

// ─── shell-url and stop: the two box-scoped writes ─────────────────────────

describe('internal devbox router — shell-url and stop (mock)', () => {
  const originalMock = process.env['MOCK_AGENTCORE'];
  beforeEach(() => { process.env['MOCK_AGENTCORE'] = 'true'; });
  afterEach(() => {
    if (originalMock === undefined) delete process.env['MOCK_AGENTCORE'];
    else process.env['MOCK_AGENTCORE'] = originalMock;
  });

  async function createSession(): Promise<{ sessionId: string; boxId: string }> {
    const body = { principal: principal(), label: 'shell-and-stop' };
    const res = await request(app()).post('/internal/devbox/sessions').set(signed(body)).send(body);
    expect(res.status).toBe(201);
    return res.body as { sessionId: string; boxId: string };
  }

  it('mints a mock shell URL for a registered session, honouring a valid shellId', async () => {
    const { sessionId } = await createSession();
    const body = { principal: principal(), shellId: 'loop-shell_1' };
    const res = await request(app()).post(`/internal/devbox/${sessionId}/shell-url`).set(signed(body)).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ url: `mock-shell://${sessionId}?shell=loop-shell_1`, shellId: 'loop-shell_1', mock: true, expiresIn: 900 });
    expect(typeof res.body.maxFrameBytes).toBe('number');
  });

  it('shell-url refuses an unsigned call, a mismatched principal, an unknown session and a bad shellId', async () => {
    const { sessionId } = await createSession();
    const body = { principal: principal() };
    expect((await request(app()).post(`/internal/devbox/${sessionId}/shell-url`).send(body)).status).toBe(401);
    const wrong = { principal: { service: 'someone-else', requestedBy: 'u-x' } };
    expect((await request(app()).post(`/internal/devbox/${sessionId}/shell-url`).set(signed(wrong)).send(wrong)).status).toBe(400);
    const unknown = 'z'.repeat(40);
    const missing = await request(app()).post(`/internal/devbox/${unknown}/shell-url`).set(signed(body)).send(body);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'computer not found' });
    const badShell = { principal: principal(), shellId: '../etc' };
    const bad = await request(app()).post(`/internal/devbox/${sessionId}/shell-url`).set(signed(badShell)).send(badShell);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/invalid shellId/);
    expect((await request(app()).post('/internal/devbox/short/shell-url').set(signed(body)).send(body)).status).toBe(400);
  });

  it('DELETE stops the session and settles the fleet row to stopped', async () => {
    const { sessionId, boxId } = await createSession();
    expect(getBox(boxId)?.status).not.toBe('stopped');
    const body = { principal: principal() };
    const res = await request(app()).delete(`/internal/devbox/${sessionId}`).set(signed(body)).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stopped: true, sessionId });
    expect(getBox(boxId)?.status).toBe('stopped');
  });

  it('DELETE refuses an unsigned call or a principal that disagrees with the signer, and leaves the box running', async () => {
    const { sessionId, boxId } = await createSession();
    const body = { principal: principal() };
    expect((await request(app()).delete(`/internal/devbox/${sessionId}`).send(body)).status).toBe(401);
    expect((await request(appWithBrowserSession()).delete(`/internal/devbox/${sessionId}`).send(body)).status).toBe(401);
    const noPrincipal = {};
    expect((await request(app()).delete(`/internal/devbox/${sessionId}`).set(signed(noPrincipal)).send(noPrincipal)).status).toBe(400);
    expect(getBox(boxId)?.status).not.toBe('stopped');
  });
});
