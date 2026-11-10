// Guardrail rule detail — /api/observability/guardrails-detail
// (routes/guardrails-detail.ts). `invocation_traces.guardrail_action` is
// BLOCKED/ANONYMIZED/NONE and says nothing about WHICH rule fired; this router
// is the per-rule view.
//
// What is pinned:
//   * the two wire shapes (`{byRule, windowHours}` and `{interventions}`),
//     including the LOW/MEDIUM/HIGH severity keys the portal's severity bar
//     indexes by name — a renamed key here silently zeroes the bar,
//   * that `count` is the row's own aggregate and the three severity buckets
//     account for it,
//   * the window and limit clamps, including a garbage value falling back to
//     the default rather than to NaN,
//   * that an invalid `invocationId` is DROPPED rather than bound — the
//     filter is cast `::uuid` in SQL, so passing junk through would turn a
//     mistyped id into a 500,
//   * both DB-error branches degrading to an empty payload, with the echoed
//     `windowHours` preserved so the page can still say what it asked for.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
// The router now has an offline branch gated on `config.mock.aurora`, so it
// imports config.ts — which reaches `import.meta` and is unloadable under the
// CJS test build (the same trap drift-routes.test.ts documents). Mocked with
// `aurora: false` on purpose: every case in this file is about the LIVE SQL
// path, and the offline branch is pinned separately in
// observability-mock-branch.test.ts.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false } },
}));
// `/by-actor` resolves ids to names for display. Stubbed rather than reaching
// the identity provider: these cases are about the aggregate, and a name that
// cannot be resolved must not change the row (see the last case).
jest.mock('../../providers/identity.js', () => ({
  listUsers: jest.fn(async () => ([
    { id: 'u-caleb', displayName: 'Caleb Turner' },
  ])),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { guardrailsDetailRouter } from '../guardrails-detail.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;

type Param = { name: string; value: Record<string, unknown> };
const paramsOf = (call: number): Param[] => (execMock.mock.calls[call]![1] ?? []) as Param[];
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);
const valueOf = (call: number, name: string): unknown =>
  paramsOf(call).find((p) => p.name === name)?.value['longValue']
  ?? paramsOf(call).find((p) => p.name === name)?.value['stringValue'];

function buildApp() {
  const app = express();
  app.use(express.json());
  // The text columns are read through the caller's trace scope (lib/trace-scope.ts);
  // these cases are about the data plane, so they run as the cross-tenant admin.
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: 'u-admin', role: 'admin', tenant: 'orgiq', grants: {}, iat: 0 }; next(); });
  app.use('/api/observability/guardrails-detail', guardrailsDetailRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { execMock.mockReset(); });

describe('GET /by-rule', () => {
  it('maps the aggregate onto the severity-bar shape the portal indexes by name', async () => {
    execMock.mockResolvedValue([{
      rule_name: 'PII_EMAIL', rule_category: 'sensitive_information',
      cnt: '7', low_cnt: '1', med_cnt: '4', high_cnt: '2',
    }]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/by-rule');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['byRule', 'windowHours']);
    expect(res.body.byRule[0]).toEqual({
      ruleName: 'PII_EMAIL', ruleCategory: 'sensitive_information', count: 7,
      severityCounts: { LOW: 1, MEDIUM: 4, HIGH: 2 },
    });
    // The buckets have to account for the count they sit beside.
    const sc = res.body.byRule[0].severityCounts;
    expect(sc.LOW + sc.MEDIUM + sc.HIGH).toBe(res.body.byRule[0].count);
  });

  it('keeps an uncategorised rule null and zero-fills absent severity counts', async () => {
    execMock.mockResolvedValue([{ rule_name: 'CUSTOM', rule_category: null, cnt: '1' }]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/by-rule');
    expect(res.body.byRule[0].ruleCategory).toBeNull();
    expect(res.body.byRule[0].severityCounts).toEqual({ LOW: 0, MEDIUM: 0, HIGH: 0 });
  });

  it('defaults the window to 24h, caps it at 14 days, and ignores junk', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    const base = '/api/observability/guardrails-detail/by-rule';
    await request(app).get(base);
    await request(app).get('/api/observability/guardrails-detail/by-rule?windowHours=999999');
    await request(app).get('/api/observability/guardrails-detail/by-rule?windowHours=abc');
    await request(app).get('/api/observability/guardrails-detail/by-rule?windowHours=0');
    expect([0, 1, 2, 3].map((i) => valueOf(i, 'hours'))).toEqual([24, 24 * 14, 24, 24]);
  });

  it('marks a failed breakdown; a fortnight that blocked nothing stays unmarked', async () => {
    execMock.mockResolvedValue([]);
    const quiet = await request(buildApp())
      .get('/api/observability/guardrails-detail/by-rule?windowHours=6');
    expect(quiet.body).toEqual({ byRule: [], windowHours: 6 });

    execMock.mockRejectedValue(new Error('relation "observability.guardrail_interventions" does not exist'));
    const res = await request(buildApp())
      .get('/api/observability/guardrails-detail/by-rule?windowHours=6');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      byRule: [], windowHours: 6, degraded: true,
      error: 'relation "observability.guardrail_interventions" does not exist',
    });
  });
});

describe('GET /interventions', () => {
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('maps one intervention row onto the drill-down shape', async () => {
    execMock.mockResolvedValue([{
      intervention_id: 'gi-1', invocation_id: UUID, agent_id: 'orgiq-search',
      rule_name: 'PII_EMAIL', rule_category: 'sensitive_information',
      severity: 'HIGH', action: 'ANONYMIZED', matched_text: 'a@b.com',
      ts: '2026-08-20T09:00:00Z',
    }]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/interventions');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['interventions']);
    expect(res.body.interventions[0]).toEqual({
      interventionId: 'gi-1', invocationId: UUID, agentId: 'orgiq-search',
      ruleName: 'PII_EMAIL', ruleCategory: 'sensitive_information',
      severity: 'HIGH', action: 'ANONYMIZED', matchedText: 'a@b.com',
      ts: '2026-08-20T09:00:00Z',
    });
  });

  it('preserves nulls for an unattributed intervention', async () => {
    execMock.mockResolvedValue([{
      intervention_id: 'gi-2', invocation_id: null, agent_id: 'orgiq-search',
      rule_name: 'X', rule_category: null, severity: null, action: 'BLOCKED',
      matched_text: null, ts: 't',
    }]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/interventions');
    const row = res.body.interventions[0];
    expect(row.invocationId).toBeNull();
    expect(row.ruleCategory).toBeNull();
    expect(row.severity).toBeNull();
    expect(row.matchedText).toBeNull();
  });

  it('binds a valid invocationId and DROPS an invalid one instead of casting junk to uuid', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get(`/api/observability/guardrails-detail/interventions?invocationId=${UUID}`);
    await request(app).get('/api/observability/guardrails-detail/interventions?invocationId=not-a-uuid');

    expect(sqlOf(0)).toMatch(/invocation_id = :iid::uuid/);
    expect(valueOf(0, 'iid')).toBe(UUID);
    // No WHERE at all — a mistyped id must not reach `::uuid` and 500.
    expect(sqlOf(1)).not.toMatch(/WHERE/);
  });

  it('binds a rule filter as a parameter and combines it with the id filter', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp())
      .get(`/api/observability/guardrails-detail/interventions?invocationId=${UUID}&ruleName=PII_EMAIL`);
    expect(sqlOf(0)).toMatch(/g\.invocation_id = :iid::uuid AND g\.rule_name = :rule/);
    expect(sqlOf(0)).not.toMatch(/PII_EMAIL/);
    expect(valueOf(0, 'rule')).toBe('PII_EMAIL');
  });

  it('defaults the limit to 50, caps it at 500, and ignores junk', async () => {
    execMock.mockResolvedValue([]);
    const app = buildApp();
    const base = '/api/observability/guardrails-detail/interventions';
    await request(app).get(base);
    await request(app).get('/api/observability/guardrails-detail/interventions?limit=9999');
    await request(app).get('/api/observability/guardrails-detail/interventions?limit=abc');
    expect([0, 1, 2].map((i) => valueOf(i, 'lim'))).toEqual([50, 500, 50]);
  });

  it('marks a DB error; a clean window is a plain empty list', async () => {
    execMock.mockResolvedValue([]);
    const clean = await request(buildApp()).get('/api/observability/guardrails-detail/interventions');
    expect(clean.body).toEqual({ interventions: [] });

    execMock.mockRejectedValue(new Error('no such table'));
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/interventions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      interventions: [], degraded: true, error: 'no such table',
    });
  });
});

// ── GET /by-actor ─────────────────────────────────────────────────────────
//
// The question `by-rule` cannot answer: one person accounting for every PII
// block in the window is invisible in a rule rollup. The join was always
// available — interventions carry the invocation id and traces have carried
// `user_id` since sprint 2 — and had never been made.

describe('GET /by-actor', () => {
  const row = {
    user_id: 'u-caleb',
    interventions: 6, blocked: 5, anonymized: 1, high_severity: 5,
    unique_rules: 4, unique_agents: 1,
    top_rule: 'PROMPT_ATTACK', top_rule_category: 'PROMPT_ATTACK',
    first_seen_at: '2026-09-15T19:02:59Z', last_seen_at: '2026-09-16T08:45:25Z',
  };

  it('maps the aggregate onto the wire and resolves the id to a name', async () => {
    execMock.mockResolvedValue([row]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/by-actor');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['actors', 'windowHours']);
    expect(res.body.actors[0]).toEqual({
      userId: 'u-caleb', userName: 'Caleb Turner',
      interventions: 6, blocked: 5, anonymized: 1,
      uniqueRules: 4, uniqueAgents: 1,
      topRule: 'PROMPT_ATTACK', topRuleCategory: 'PROMPT_ATTACK',
      highSeverity: 5,
      firstSeenAt: '2026-09-15T19:02:59Z', lastSeenAt: '2026-09-16T08:45:25Z',
    });
  });

  it('keeps blocked and anonymized apart — they are different events', async () => {
    execMock.mockResolvedValue([row]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/by-actor');
    const a = res.body.actors[0];
    // One refused the request; the other served it with the sensitive part
    // removed. A single summed "interventions" number hides which happened.
    expect(a.blocked + a.anonymized).toBe(a.interventions);
    expect(a.blocked).not.toBe(a.interventions);
  });

  it('never returns matched_text — the roll-up is not where PII gets reprinted', async () => {
    execMock.mockResolvedValue([{ ...row, matched_text: '555-0123' }]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/by-actor');
    expect(JSON.stringify(res.body)).not.toContain('555-0123');
    expect(res.body.actors[0].matchedText).toBeUndefined();
  });

  it('excludes unattributed rows and test traffic in SQL, not in the client', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/guardrails-detail/by-actor');
    const sql = sqlOf(0);
    // A scheduled or agent-to-agent call has no actor. Bucketing those under
    // one "unknown" user would make the biggest row on the page a fiction.
    expect(sql).toMatch(/user_id IS NOT NULL/);
    expect(sql).toMatch(/template_id NOT LIKE 'test:%'/);
    expect(sql).toMatch(/JOIN observability\.invocation_traces/);
  });

  it('clamps the window and the limit, and falls back on garbage', async () => {
    execMock.mockResolvedValue([]);
    await request(buildApp()).get('/api/observability/guardrails-detail/by-actor?windowHours=99999&limit=9999');
    expect(valueOf(0, 'hours')).toBe(24 * 14);
    expect(valueOf(0, 'lim')).toBe(200);

    execMock.mockClear();
    await request(buildApp()).get('/api/observability/guardrails-detail/by-actor?windowHours=nope&limit=nope');
    expect(valueOf(0, 'hours')).toBe(24);
    expect(valueOf(0, 'lim')).toBe(50);
  });

  it('degrades to an empty list rather than failing the page', async () => {
    execMock.mockRejectedValue(new Error('relation does not exist'));
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/by-actor?windowHours=6');
    expect(res.status).toBe(200);
    expect(res.body.actors).toEqual([]);
    expect(res.body.degraded).toBe(true);
    // The echoed window survives, so the page can still say what it asked for.
    expect(res.body.windowHours).toBe(6);
  });

  it('an id with no known user still returns the row, named null', async () => {
    execMock.mockResolvedValue([{ ...row, user_id: 'u-not-seeded' }]);
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/by-actor');
    expect(res.body.actors[0].userId).toBe('u-not-seeded');
    expect(res.body.actors[0].userName).toBeNull();
  });
});
