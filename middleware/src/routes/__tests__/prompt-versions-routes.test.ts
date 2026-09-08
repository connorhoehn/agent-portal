// Prompt versions — /api/observability/prompt-versions (routes/prompt-versions.ts).
// The lookup table behind every prompt-version chip in observability.
//
// What is pinned:
//   * the auth floor: registering is ManageCanary, both reads are open,
//   * IDEMPOTENCE. The runner calls POST once per agent per run, so the same
//     content must keep answering the same `promptVersion` and must not
//     overwrite the canonical text (`ON CONFLICT DO NOTHING`),
//   * the short-SHA COLLISION branch — two different prompts hashing to the
//     same short version would make one chip render the other's text, which
//     is the one failure this registry must never have. It answers 409 with
//     both hashes rather than silently returning the wrong row,
//   * the mock branch on all three routes. `exec()` reaches the RDS Data API
//     whatever `config.mock.aurora` says, so without it the registry 500'd
//     offline — and a prompt registered offline has to be readable back
//     offline, or the POST succeeds and the GET after it 404s,
//   * the wire shape (`{versions}` / `{version}`) and its null notes.

const mockFlag = { aurora: false };
const gateActions: string[] = [];

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', get mock() { return { aurora: mockFlag.aurora }; } },
}));
jest.mock('../../lib/authz.js', () => ({
  requireAction: (action: string) => {
    gateActions.push(action);
    return (_req: unknown, _res: unknown, next: () => void) => next();
  },
}));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { promptVersionsRouter } from '../prompt-versions.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const strOf = (call: number, name: string): unknown =>
  paramsOf(call).find((p) => p.name === name)?.value['stringValue'];

const BASE = '/api/observability/prompt-versions';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, promptVersionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  execMock.mockReset();
  mockFlag.aurora = false;
});

describe('auth floor', () => {
  it('gates registration on ManageCanary and leaves both reads open', () => {
    expect(gateActions).toEqual(['ManageCanary']);
  });
});

describe('POST /', () => {
  it('400s without an agentId or content', async () => {
    const app = buildApp();
    expect((await request(app).post(BASE).send({ content: 'x' })).status).toBe(400);
    const noContent = await request(app).post(BASE).send({ agentId: 'orgiq-search' });
    expect(noContent.status).toBe(400);
    expect(noContent.body.error).toMatch(/content is required/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('registers with ON CONFLICT DO NOTHING so the canonical text is never overwritten', async () => {
    execMock.mockResolvedValue([]);
    const res = await request(buildApp()).post(BASE)
      .send({ agentId: '  orgiq-search  ', content: 'Answer the question.' });
    expect(res.status).toBe(201);
    expect(typeof res.body.promptVersion).toBe('string');
    expect(res.body.promptVersion.length).toBeGreaterThan(0);
    expect(sqlOf(0)).toMatch(/ON CONFLICT \(prompt_version\) DO NOTHING/);
    expect(strOf(0, 'agent_id')).toBe('orgiq-search');
    expect(strOf(0, 'content')).toBe('Answer the question.');
    // The short version and the full sha are both stored — the second is what
    // makes a collision detectable at all.
    expect(strOf(0, 'prompt_version')).toBe(res.body.promptVersion);
    expect(String(strOf(0, 'content_sha256'))).toHaveLength(64);
  });

  it('is IDEMPOTENT — the same content answers the same version, different content does not', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    const a = await request(app).post(BASE).send({ agentId: 'a', content: 'same text' });
    const b = await request(app).post(BASE).send({ agentId: 'a', content: 'same text' });
    const c = await request(app).post(BASE).send({ agentId: 'a', content: 'other text' });
    expect(b.body.promptVersion).toBe(a.body.promptVersion);
    expect(c.body.promptVersion).not.toBe(a.body.promptVersion);
  });

  it('409s a short-SHA COLLISION rather than letting a chip render the wrong prompt', async () => {
    execMock
      .mockResolvedValueOnce([]) // the insert
      .mockResolvedValueOnce([{ content_sha256: 'f'.repeat(64) }]); // a different full sha
    const res = await request(buildApp()).post(BASE)
      .send({ agentId: 'a', content: 'Answer the question.' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('prompt_version short-SHA collision');
    expect(res.body.storedSha256).toBe('f'.repeat(64));
    expect(res.body.attemptedSha256).not.toBe(res.body.storedSha256);
    // Both hashes are reported so the caller can rotate to a longer prefix.
    expect(String(res.body.attemptedSha256)).toHaveLength(64);
  });

  it('accepts the row when the stored full sha agrees', async () => {
    execMock.mockResolvedValue([]);
    const first = await request(buildApp()).post(BASE).send({ agentId: 'a', content: 'x' });
    const sha = strOf(0, 'content_sha256');
    execMock.mockReset();
    execMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ content_sha256: sha }]);
    const again = await request(buildApp()).post(BASE).send({ agentId: 'a', content: 'x' });
    expect(again.status).toBe(201);
    expect(again.body.promptVersion).toBe(first.body.promptVersion);
  });

  it('registers into the in-memory registry offline, without touching the Data API', async () => {
    mockFlag.aurora = true;
    const res = await request(buildApp()).post(BASE).send({ agentId: 'orgiq-search', content: 'offline text' });
    expect(res.status).toBe(201);
    expect(res.body.promptVersion).toBeTruthy();
    expect(execMock).not.toHaveBeenCalled();

    // …and it reads back offline. A POST that succeeded followed by a 404 is
    // the failure this branch exists to prevent.
    const back = await request(buildApp())
      .get(`/api/observability/prompt-versions/${res.body.promptVersion}`);
    expect(back.status).toBe(200);
    expect(back.body.version.content).toBe('offline text');
    expect(back.body.version.agentId).toBe('orgiq-search');
  });
});

describe('GET /', () => {
  it('maps the registry rows and bounds the listing at 200', async () => {
    execMock.mockResolvedValue([{
      prompt_version: 'ab12cd', agent_id: 'orgiq-search', content: 'Answer.',
      content_sha256: 'a'.repeat(64), registered_at: '2026-08-20T09:00:00Z', notes: 'tightened',
    }, {
      prompt_version: 'ef34gh', agent_id: 'orgiq-advisor', content: 'Advise.',
      content_sha256: 'b'.repeat(64), registered_at: '2026-08-19T09:00:00Z', notes: null,
    }]);
    const res = await request(buildApp()).get(BASE);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['versions']);
    expect(res.body.versions[0]).toEqual({
      promptVersion: 'ab12cd', agentId: 'orgiq-search', content: 'Answer.',
      contentSha256: 'a'.repeat(64), registeredAt: '2026-08-20T09:00:00Z', notes: 'tightened',
    });
    expect(res.body.versions[1].notes).toBeNull();
    expect(sqlOf(0)).toMatch(/ORDER BY registered_at DESC/);
    expect(sqlOf(0)).toMatch(/LIMIT 200/);
  });

  it('serves the in-memory registry offline instead of 500ing on the Data API', async () => {
    mockFlag.aurora = true;
    const res = await request(buildApp()).get(BASE);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.versions)).toBe(true);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('GET /:promptVersion', () => {
  it('binds the version as a parameter and returns the canonical text', async () => {
    execMock.mockResolvedValue([{
      prompt_version: 'ab12cd', agent_id: 'orgiq-search', content: 'Answer.',
      content_sha256: 'a'.repeat(64), registered_at: '2026-08-20T09:00:00Z', notes: null,
    }]);
    const res = await request(buildApp()).get('/api/observability/prompt-versions/ab12cd');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['version']);
    expect(res.body.version.content).toBe('Answer.');
    expect(sqlOf(0)).toMatch(/WHERE prompt_version = :pv/);
    expect(strOf(0, 'pv')).toBe('ab12cd');
  });

  it('404s an unregistered version, on both the real and the mock path', async () => {
    execMock.mockResolvedValue([]);
    const real = await request(buildApp()).get('/api/observability/prompt-versions/nosuch');
    expect(real.status).toBe(404);
    expect(real.body.error).toBe('prompt_version not found');

    mockFlag.aurora = true;
    const offline = await request(buildApp()).get('/api/observability/prompt-versions/nosuch');
    expect(offline.status).toBe(404);
    expect(offline.body.error).toBe('prompt_version not found');
  });
});
