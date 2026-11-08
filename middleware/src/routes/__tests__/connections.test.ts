// /api/connections and its /github/* sub-routes under MOCK_AGENTCORE.
//
// Before this: every GitHub-backed route 500'd with a bare "Internal server
// error" (borrowApiKey's thrown message never reached the response, because
// only /:name/check catches it) and /:name/check itself 502'd honestly but
// uselessly — offline, nothing behind this router worked at all.
//
// What's pinned here: /check and every /github/* route now answer from the
// fixture floor (mock/github.ts) for a github-kind connection, and a global
// fetch spy proves none of them ever reach out. A non-github kind (jira,
// confluence) has no reader built yet, mocked or otherwise, so /check for one
// of those is pinned to KEEP failing with the original vault message — that
// honesty (no reader exists, not "the reader is stubbed") is the thing this
// suite must not quietly erase.

const mockConfig = {
  region: 'us-east-1',
  mock: { aurora: false, agentcore: true, guardrails: false, cloudwatch: false },
};
jest.mock('../../config.js', () => ({ config: mockConfig }));

import express from 'express';
import request from '../../test-support/http.js';
import { connectionsRouter } from '../connections.js';
import { errorHandler } from '../../lib/async-handler.js';
import { connectedSourceRows } from '../../mock/connected-sources.js';
import { fixtureRegistry } from '../../mock/core/index.js';

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/api/connections', connectionsRouter);
  a.use(errorHandler);
  return a;
}

const GITHUB = 'orgiq-github-connorhoehn';
const JIRA = 'orgiq-jira-platform';

describe('/api/connections under MOCK_AGENTCORE', () => {
  let fetchSpy: jest.Mock;

  beforeEach(() => {
    mockConfig.mock.agentcore = true;
    connectedSourceRows.reset();
    fetchSpy = jest.fn(async () => {
      throw new Error('a mock-mode request tried to reach the network');
    });
    (globalThis as unknown as { fetch: unknown }).fetch = fetchSpy;
  });

  it('GET /:name/check answers true offline for the seeded github connection', async () => {
    const res = await request(app()).get(`/api/connections/${GITHUB}/check`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, identity: { login: 'connorhoehn', name: expect.any(String) as unknown as string, scopes: expect.any(Array) as unknown as string[] } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET /:name/check still 502s honestly for a kind with no reader (jira) — nothing was mocked there', async () => {
    const res = await request(app()).get(`/api/connections/${JIRA}/check`);
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/no credential vault in mock mode/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET /:name/github/orgs lists the fixture org', async () => {
    const res = await request(app()).get(`/api/connections/${GITHUB}/github/orgs`);
    expect(res.status).toBe(200);
    expect(res.body.orgs).toEqual([{ login: 'connorhoehnslalom', description: expect.any(String) as unknown as string }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET /:name/github/repos lists the seeded repo_full_name rows', async () => {
    const res = await request(app()).get(`/api/connections/${GITHUB}/github/repos`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.repos)).toBe(true);
    expect(res.body.repos.length).toBeGreaterThan(0);
    expect(res.body.repos.map((r: { fullName: string }) => r.fullName)).toContain('connorhoehn/orgiq-observability');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET /:name/github/repos respects ?limit', async () => {
    const res = await request(app()).get(`/api/connections/${GITHUB}/github/repos?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body.repos.length).toBe(2);
  });

  it('GET /:name/github/signal returns contributors for a repo the fixture covers', async () => {
    const res = await request(app())
      .get(`/api/connections/${GITHUB}/github/signal`)
      .query({ repo: 'connorhoehn/orgiq-observability' });
    expect(res.status).toBe(200);
    expect(res.body.repo).toBe('connorhoehn/orgiq-observability');
    expect(res.body.signals.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('GET /:name/github/signal returns [] — not an error — for a repo with no sampled rows', async () => {
    const res = await request(app())
      .get(`/api/connections/${GITHUB}/github/signal`)
      .query({ repo: 'connorhoehn/orgiq-mobile-app' });
    expect(res.status).toBe(200);
    expect(res.body.signals).toEqual([]);
  });

  it('GET /:name/github/signal still validates repo shape before touching the connector', async () => {
    const res = await request(app())
      .get(`/api/connections/${GITHUB}/github/signal`)
      .query({ repo: 'not-owner-slash-name' });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST / for kind github verifies against the fixture identity, with no "problem" field', async () => {
    const res = await request(app())
      .post('/api/connections')
      .send({ kind: 'github', label: 'a new label', apiKey: 'whatever' });
    expect(res.status).toBe(201);
    expect(res.body.verified).toEqual({ login: 'connorhoehn', name: expect.any(String) as unknown as string, scopes: expect.any(Array) as unknown as string[] });
    expect(res.body.problem).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The list and the revoke — the two routes the fixture suite above never
// exercised. Both matter for the rule this router's header states: a secret
// travels in ONE direction. The list is the only place a credential is
// described over HTTP, so it is the place a leak would show up.
describe('/api/connections — list and revoke', () => {
  beforeEach(() => {
    mockConfig.mock.agentcore = true;
    connectedSourceRows.reset();
  });

  it('GET / describes each source WITHOUT ever returning a secret', async () => {
    const res = await request(app()).get('/api/connections');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['sources']);
    // The wire shape the Ingest panel renders: name, kind, authType, createdAt
    // — and nothing that could be a credential, redacted or otherwise.
    for (const src of res.body.sources as Array<Record<string, unknown>>) {
      expect(Object.keys(src).sort()).toEqual(['authType', 'createdAt', 'kind', 'name']);
    }
    const serialized = JSON.stringify(res.body);
    for (const forbidden of ['apiKey', 'api_key', 'secret', 'token', 'credential']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('GET / carries both auth types and a kind parsed from the name', async () => {
    const res = await request(app()).get('/api/connections');
    const byName = Object.fromEntries(
      (res.body.sources as Array<{ name: string; kind: string; authType: string }>)
        .map((s) => [s.name, s]),
    );
    expect(byName[GITHUB]!.kind).toBe('github');
    expect(byName[GITHUB]!.authType).toBe('api-key');
    // The oauth2 branch of the list is represented, not just api-key.
    expect(byName['orgiq-confluence-engineering']!.authType).toBe('oauth2');
    // Sorted by name, so the panel's order does not depend on the vault's.
    const names = (res.body.sources as Array<{ name: string }>).map((s) => s.name);
    expect(names).toEqual([...names].sort());
  });

  it('GET / renders a fresh account as an empty list, not an error', async () => {
    // The `empty` scenario exists precisely so an auditor can see this state
    // without mutating shared rows (mock/core/contract.ts, bug class 4).
    fixtureRegistry.resetAll('empty');
    try {
      const res = await request(app()).get('/api/connections');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sources: [] });
    } finally {
      fixtureRegistry.resetAll('default');
    }
  });

  it('DELETE /:name refuses a name outside the orgiq- namespace', async () => {
    // The vault holds providers this app did not create; a delete that could
    // name any of them is a delete that can reach outside this product.
    for (const name of ['some-other-provider', 'orgiq', 'ORGIQ-github-x']) {
      const res = await request(app()).delete(`/api/connections/${name}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Unknown connection');
    }
    expect((await request(app()).get('/api/connections')).body.sources).toHaveLength(3);
  });

  it('DELETE /:name removes exactly the named source', async () => {
    const res = await request(app()).delete(`/api/connections/${JIRA}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const after = (await request(app()).get('/api/connections')).body.sources as Array<{ name: string }>;
    expect(after.map((s) => s.name)).not.toContain(JIRA);
    expect(after).toHaveLength(2);
  });

  it('DELETE /:name is idempotent — a second revoke still answers ok', async () => {
    await request(app()).delete(`/api/connections/${JIRA}`);
    const again = await request(app()).delete(`/api/connections/${JIRA}`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true });
  });
});
