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

  it('degrades to an empty breakdown but still echoes the window it asked for', async () => {
    execMock.mockRejectedValue(new Error('relation "observability.guardrail_interventions" does not exist'));
    const res = await request(buildApp())
      .get('/api/observability/guardrails-detail/by-rule?windowHours=6');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ byRule: [], windowHours: 6 });
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
    expect(sqlOf(0)).toMatch(/invocation_id = :iid::uuid AND rule_name = :rule/);
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

  it('degrades to an empty list on a DB error', async () => {
    execMock.mockRejectedValue(new Error('no such table'));
    const res = await request(buildApp()).get('/api/observability/guardrails-detail/interventions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ interventions: [] });
  });
});
