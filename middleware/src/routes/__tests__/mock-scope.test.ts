// Request-scoped scenarios and ephemeral identity clones (Lane M,
// docs/mock-floor.md § Scopes and clones).
//
// The contracts this file holds:
//   * a scoped scenario never leaks to another session or the global world;
//   * a write under a scope leaves the shared fixture rows untouched;
//   * the generic data states (long-text, many, loading, named empty/error);
//   * a clone's grants equal its persona's;
//   * an epoch bump on a clone revokes neither the persona nor another clone;
//   * a full reset removes every clone and every scope;
//   * every route answers 404 in production.

const mockFlags = { aurora: true, agentcore: true };

jest.mock('../../config.js', () => ({
  config: {
    get mock() {
      return { aurora: mockFlags.aurora, agentcore: mockFlags.agentcore, guardrails: true, cloudwatch: true };
    },
    region: 'us-east-1',
    auth: { sessionSigningSecretArn: '', policyStoreId: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: { userPoolId: '', clientId: '', clientSecret: '', domain: '', callbackUrl: '' },
  },
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { mockControlRouter, setFixtureRegistry, __resetMockControlState, MOCK_SCOPE_COOKIE } from '../mock-control.js';
import { errorHandler } from '../../lib/async-handler.js';
import { createFixtureRegistry, defineFixture, LONG_TEXT_LENGTH, MANY_ROWS } from '../../mock/core/index.js';
import { bumpSessionEpoch, getUser } from '../../providers/identity.js';
import { mintSession, sessionMiddleware, setGrantsResolver, signSession, COOKIE_NAME } from '../../lib/session.js';
import { socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { mirrorCloneDms } from '../../lib/clone-dms.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../../lib/social-chat.js';

interface Row { id: string; name: string; email: string; slug: string }

const registry = createFixtureRegistry();
const people = defineFixture<Row>({
  key: 'test.people',
  registry,
  scenarios: {
    default: () => [
      { id: 'a', name: 'Vera Green', email: 'vera.green@orgiq.example', slug: 'vera-green' },
      { id: 'b', name: 'Theo Chang', email: 'theo.chang@orgiq.example', slug: 'theo-chang' },
      { id: 'c', name: 'Nora DaSilva', email: 'nora.dasilva@orgiq.example', slug: 'nora-dasilva' },
    ],
    empty: () => [],
  },
});
// Declares nothing but `default`: the generic empty/error states are for it.
const notes = defineFixture<{ id: string }>({
  key: 'test.notes',
  registry,
  scenarios: { default: () => [{ id: 'n1' }, { id: 'n2' }] },
});

function app() {
  const a = express();
  a.use(express.json());
  a.use(cookieParser());
  a.use(sessionMiddleware());
  a.use(mockControlRouter);
  a.get('/api/people', (_req, res) => { res.json(people.rows()); });
  a.post('/api/people', (req, res) => {
    people.rows().push({ id: String(req.body.id), name: 'New Person', email: 'new@orgiq.example', slug: 'new' });
    res.status(201).json({ ok: true });
  });
  a.get('/api/notes', (_req, res) => { res.json(notes.rows()); });
  a.get('/api/whoami', (req, res) => { res.json({ sub: req.session?.sub ?? null, invalid: Boolean(req.sessionInvalid) }); });
  a.use(errorHandler);
  return a;
}

async function scope(body: Record<string, unknown>): Promise<string> {
  const res = await request(app()).post('/api/__mock/scope').send(body);
  expect(res.status).toBe(201);
  expect(String(res.headers['set-cookie'])).toContain(`${MOCK_SCOPE_COOKIE}=${res.body.scope.id}`);
  return res.body.scope.id as string;
}

beforeEach(() => {
  __resetMockControlState();
  registry.resetAll('default');
  setFixtureRegistry(registry);
  mockFlags.aurora = true; mockFlags.agentcore = true;
});
afterAll(() => { __resetMockControlState(); });

describe('request-scoped scenarios', () => {
  it('a scoped scenario never leaks to another session or the global world', async () => {
    const empty = await scope({ scenario: 'empty', label: 'auditor A' });
    const other = await scope({ scenario: 'default' });
    expect((await request(app()).get('/api/people').set('x-mock-scope', empty)).body).toEqual([]);
    // The same id as a cookie works too.
    expect((await request(app()).get('/api/people').set('Cookie', `${MOCK_SCOPE_COOKIE}=${empty}`)).body).toEqual([]);
    expect((await request(app()).get('/api/people').set('x-mock-scope', other)).body).toHaveLength(3);
    const global = await request(app()).get('/api/people');
    expect(global.body).toHaveLength(3);
    expect(global.headers['x-mock-scenario']).toBe('default');
    expect(global.headers['x-mock-scope']).toBeUndefined();
    expect(registry.scenario()).toBe('default');
    const scoped = await request(app()).get('/api/people').set('x-mock-scope', empty);
    expect(scoped.headers['x-mock-scenario']).toBe('empty');
    expect(scoped.headers['x-mock-scope']).toBe(empty);
  });

  it('a global switch or pin does not reach into a scope', async () => {
    const id = await scope({ scenario: 'default' });
    expect((await request(app()).post('/api/__mock/scenario').send({ scenario: 'empty', fixture: 'test.people' })).status).toBe(200);
    expect((await request(app()).get('/api/people')).body).toEqual([]);
    expect((await request(app()).get('/api/people').set('x-mock-scope', id)).body).toHaveLength(3);
  });

  it('a write under a scope leaves the shared fixture rows untouched', async () => {
    const id = await scope({ scenario: 'default' });
    expect((await request(app()).post('/api/people').set('x-mock-scope', id).send({ id: 'z' })).status).toBe(201);
    expect((await request(app()).get('/api/people').set('x-mock-scope', id)).body).toHaveLength(4);
    expect((await request(app()).get('/api/people')).body).toHaveLength(3);
    expect(people.rows()).toHaveLength(3);
    // ...and a shared write is not seen by a scope that already copied its rows.
    await request(app()).post('/api/people').send({ id: 'shared' });
    expect((await request(app()).get('/api/people').set('x-mock-scope', id)).body.map((r: Row) => r.id)).not.toContain('shared');
    const report = await request(app()).get(`/api/__mock/scope/${id}`);
    expect(report.body.scope.rows).toEqual({ 'test.people': 4 });
  });

  it('long-text pads human text to 80 characters and leaves identifiers alone', async () => {
    const id = await scope({ scenario: 'long-text' });
    const rows = (await request(app()).get('/api/people').set('x-mock-scope', id)).body as Row[];
    for (const r of rows) {
      expect(r.name).toHaveLength(LONG_TEXT_LENGTH);
      expect(r.email).toHaveLength(LONG_TEXT_LENGTH);
      expect(r.email).toMatch(/^[^@\s]+@orgiq\.example$/);
    }
    expect(rows.map((r) => r.slug)).toEqual(['vera-green', 'theo-chang', 'nora-dasilva']);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('many yields at least 200 rows with unique ids', async () => {
    const id = await scope({ scenario: 'many' });
    const rows = (await request(app()).get('/api/people').set('x-mock-scope', id)).body as Row[];
    expect(rows.length).toBeGreaterThanOrEqual(MANY_ROWS);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('loading holds responses back, bounded', async () => {
    const id = await scope({ scenario: 'loading', delayMs: 120 });
    const started = Date.now();
    const res = await request(app()).get('/api/people').set('x-mock-scope', id);
    expect(res.body).toHaveLength(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    const capped = await request(app()).post('/api/__mock/scope').send({ scenario: 'loading', delayMs: 999_999 });
    expect(capped.body.scope.delayMs).toBe(10_000);
  });

  it('a named fixture gets a generic empty or error even when it declares neither', async () => {
    const empty = await scope({ scenario: 'empty', fixture: 'test.notes' });
    expect((await request(app()).get('/api/notes').set('x-mock-scope', empty)).body).toEqual([]);
    expect((await request(app()).get('/api/people').set('x-mock-scope', empty)).body).toHaveLength(3);
    const broken = await scope({ fixtures: { 'test.notes': 'error' } });
    expect((await request(app()).get('/api/notes').set('x-mock-scope', broken)).status).toBe(500);
    // A whole-world empty keeps the registry's rule: only declared branches.
    const world = await scope({ scenario: 'empty' });
    expect((await request(app()).get('/api/notes').set('x-mock-scope', world)).body).toHaveLength(2);
    expect((await request(app()).get('/api/notes')).body).toHaveLength(2);
  });

  it('refuses what it cannot serve', async () => {
    expect((await request(app()).post('/api/__mock/scope').send({ scenario: 'nope' })).status).toBe(400);
    expect((await request(app()).post('/api/__mock/scope').send({ scenario: 'demo' })).status).toBe(400);
    expect((await request(app()).post('/api/__mock/scope').send({ scenario: 'large', fixture: 'test.notes' })).status).toBe(409);
    expect((await request(app()).post('/api/__mock/scope').send({ scenario: 'empty', fixture: 'nope' })).status).toBe(404);
    // An unknown or deleted scope is refused, never served from the shared world.
    const id = await scope({ scenario: 'empty' });
    expect((await request(app()).delete(`/api/__mock/scope/${id}`)).status).toBe(200);
    const gone = await request(app()).get('/api/people').set('x-mock-scope', id);
    expect(gone.status).toBe(410);
    expect((await request(app()).post('/api/people').set('x-mock-scope', 'ms-forged').send({ id: 'x' })).status).toBe(410);
    expect(people.rows()).toHaveLength(3);
  });

  it('lists every live scope', async () => {
    expect((await request(app()).get('/api/__mock/scope')).body.scopes).toEqual([]);
    const id = await scope({ scenario: 'empty', label: 'listed' });
    const { scopes } = (await request(app()).get('/api/__mock/scope')).body as { scopes: Array<{ id: string; label: string | null }> };
    expect(scopes.map((s) => s.id)).toEqual([id]);
    expect(scopes[0]!.label).toBe('listed');
  });

  it('expires on its TTL', async () => {
    const id = await scope({ scenario: 'empty', ttlMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    expect((await request(app()).get('/api/people').set('x-mock-scope', id)).status).toBe(410);
  });
});

describe('identity clones', () => {
  beforeAll(() => {
    setGrantsResolver(async (id) => {
      const u = await getUser(id);
      return u ? { displayName: u.displayName, grants: u.grants, epoch: u.epoch } : null;
    });
  });

  async function clone(from = 'u-vera'): Promise<string> {
    const res = await request(app()).post('/api/__mock/identity/clone').send({ from, label: 'lane-m' });
    expect(res.status).toBe(201);
    return res.body.clone.id as string;
  }

  /** A cookie old enough that the next request re-checks its epoch and grants. */
  async function cookieFor(userId: string): Promise<string> {
    const user = (await getUser(userId))!;
    const session = mintSession({ id: user.id, displayName: user.displayName, epoch: user.epoch }, user.grants)!;
    session.iat -= 600;
    return `${COOKIE_NAME}=${await signSession(session)}`;
  }

  it("a clone's grants, person link and name equal its persona's", async () => {
    const id = await clone();
    const [persona, copy] = [await getUser('u-vera'), await getUser(id)];
    expect(id).toMatch(/^u-vera-clone-[0-9a-f]{8}$/);
    expect(copy!.grants).toEqual(persona!.grants);
    expect(copy!.personId).toBe(persona!.personId);
    expect(copy!.displayName).toBe(persona!.displayName);
    expect(copy!.epoch).toBe(0);
  });

  it('an epoch bump on a clone revokes neither the persona nor another clone', async () => {
    const [a, b] = [await clone(), await clone()];
    const [cookieA, cookieB, cookieVera] = [await cookieFor(a), await cookieFor(b), await cookieFor('u-vera')];
    const veraEpoch = (await getUser('u-vera'))!.epoch;
    await bumpSessionEpoch(a);
    expect((await getUser(a))!.epoch).toBe(1);
    expect((await getUser(b))!.epoch).toBe(0);
    expect((await getUser('u-vera'))!.epoch).toBe(veraEpoch);
    expect((await request(app()).get('/api/whoami').set('Cookie', cookieA)).body).toEqual({ sub: null, invalid: true });
    expect((await request(app()).get('/api/whoami').set('Cookie', cookieB)).body).toEqual({ sub: b, invalid: false });
    expect((await request(app()).get('/api/whoami').set('Cookie', cookieVera)).body).toEqual({ sub: 'u-vera', invalid: false });
  });

  it('deletes a clone by id, and a second delete or an unknown id is a 404', async () => {
    const id = await clone();
    expect((await request(app()).delete(`/api/__mock/identity/clone/${id}`)).body).toEqual({ deleted: id });
    expect(await getUser(id)).toBeNull();
    expect((await request(app()).get('/api/__mock/identity/clones')).body.clones).toEqual([]);
    expect((await request(app()).delete(`/api/__mock/identity/clone/${id}`)).status).toBe(404);
    expect((await request(app()).delete('/api/__mock/identity/clone/u-nobody')).status).toBe(404);
  });

  it('the clone delete route also removes mirrored DM history without changing the original', async () => {
    const id = await clone('u-lena');
    const chat = createMemorySocialChatBackend(); setSocialChatBackend(chat);
    const original = JSON.stringify(socialChannelMessagesFixture.rows());
    try {
      await mirrorCloneDms(id);
      expect((await chat.conversations.listForUser(id)).length).toBeGreaterThan(0);
      expect((await request(app()).delete(`/api/__mock/identity/clone/${id}`)).status).toBe(200);
      expect(await chat.conversations.listForUser(id)).toEqual([]);
      expect(JSON.stringify(socialChannelMessagesFixture.rows())).toBe(original);
    } finally { setSocialChatBackend(null); }
  });

  it('refuses a clone of a clone, an unknown persona, and runs without MOCK_AURORA', async () => {
    const id = await clone();
    expect((await request(app()).post('/api/__mock/identity/clone').send({ from: id })).status).toBe(400);
    expect((await request(app()).post('/api/__mock/identity/clone').send({ from: 'u-nobody' })).status).toBe(404);
    mockFlags.aurora = false;
    expect((await request(app()).post('/api/__mock/identity/clone').send({ from: 'u-vera' })).status).toBe(409);
  });

  it('a clone survives a global scenario switch', async () => {
    const id = await clone();
    expect((await request(app()).post('/api/__mock/scenario').send({ scenario: 'empty' })).status).toBe(200);
    expect(await getUser(id)).not.toBeNull();
  });

  it('a full reset removes every clone and every scope', async () => {
    const id = await clone();
    const cookie = await cookieFor(id);
    const s = await scope({ scenario: 'empty' });
    const reset = await request(app()).post('/api/__mock/reset').send({});
    expect(reset.status).toBe(200);
    expect(reset.body.clones).toBe(0);
    expect(reset.body.scopes).toBe(0);
    expect(await getUser(id)).toBeNull();
    expect((await request(app()).get('/api/whoami').set('Cookie', cookie)).body).toEqual({ sub: null, invalid: true });
    expect((await request(app()).get('/api/people').set('x-mock-scope', s)).status).toBe(410);
    expect((await request(app()).get('/api/__mock/identity/clones')).body.clones).toEqual([]);
  });
});

describe('gating', () => {
  const routes: Array<[method: 'get' | 'post' | 'delete', path: string]> = [
    ['post', '/api/__mock/scope'], ['get', '/api/__mock/scope'], ['get', '/api/__mock/scope/ms-x'], ['delete', '/api/__mock/scope/ms-x'],
    ['post', '/api/__mock/identity/clone'], ['get', '/api/__mock/identity/clones'], ['delete', '/api/__mock/identity/clone/u-x'],
  ];

  it.each(routes)('%s %s answers 404 in production', async (method, path) => {
    const id = await scope({ scenario: 'empty' });
    const prev = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const res = await request(app())[method](path).send({ scenario: 'empty', from: 'u-vera' });
      expect(res.status).toBe(404);
      // ...and a scope id is inert: the shared world serves the request.
      const scoped = await request(app()).get('/api/people').set('x-mock-scope', id);
      expect(scoped.status).toBe(200);
      expect(scoped.body).toHaveLength(3);
    } finally {
      process.env['NODE_ENV'] = prev;
    }
  });

  it('404s without a mock provider', async () => {
    mockFlags.aurora = false; mockFlags.agentcore = false;
    expect((await request(app()).post('/api/__mock/scope').send({ scenario: 'empty' })).status).toBe(404);
    expect((await request(app()).post('/api/__mock/identity/clone').send({ from: 'u-vera' })).status).toBe(404);
  });
});
