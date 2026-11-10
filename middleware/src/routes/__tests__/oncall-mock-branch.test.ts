// On-call — /api/observability/oncall (routes/oncall.ts) — with no Aurora.
//
// WHY THIS FILE EXISTS. This router had no mock branch at all: all four
// routes called `exec()` directly, which throws under `MOCK_AURORA`, is
// caught, and answers an empty payload — so On-Call, the one live-incident
// surface in the product, rendered blank in the entire offline demo while
// the pages either side of it (drift, cost) showed the same day of traffic.
// oncall-routes.test.ts pins the LIVE SQL path (`config.mock.aurora ===
// false`, same convention as cost-routes.test.ts); this is the other half —
// the same four routes, `aurora: true`, answering from
// `mock/observability.ts`'s trace corpus and its new `approvalRequests`
// fixture, exactly as cost-mock-branch.test.ts does for `/cost`.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { oncallRouter } from '../oncall.js';
import { errorHandler } from '../../lib/async-handler.js';
import { fixtureRegistry, freezeClock, unfreezeClock, type ScenarioName } from '../../mock/core/index.js';

const AT = '2026-09-08T15:20:00.000Z';
const BASE = '/api/observability/oncall';

function buildApp() {
  const app = express();
  app.use(express.json());
  // The snippet routes read their scope from the session (lib/trace-scope.ts); these
  // cases are about the data plane, so they run as the cross-tenant admin.
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: 'u-admin', role: 'admin', tenant: 'orgiq', grants: {}, iat: 0 }; next(); });
  app.use(BASE, oncallRouter);
  app.use(errorHandler);
  return app;
}

let restoreClock: () => void;
beforeEach(() => {
  restoreClock = freezeClock(AT);
  fixtureRegistry.resetAll('default');
});
afterEach(() => {
  restoreClock();
  unfreezeClock();
  fixtureRegistry.resetAll('default');
});

/** Run `fn` with every fixture in `scenario`, then put `default` back. */
async function inScenario(scenario: ScenarioName, fn: () => Promise<void>): Promise<void> {
  fixtureRegistry.resetAll(scenario);
  try {
    await fn();
  } finally {
    fixtureRegistry.resetAll('default');
  }
}

describe('the mock branch answers offline, seeded, not degraded', () => {
  it('serves all four routes with no `degraded` marker', async () => {
    const app = buildApp();
    for (const path of ['/timeline', '/alarms', '/hitl-sla', '/recent-events']) {
      const res = await request(app).get(`${BASE}${path}`).expect(200);
      expect(res.body.degraded).toBeUndefined();
    }
  });

  it('/timeline composes buckets, deploy markers and live alarms from the seeded corpus', async () => {
    const app = buildApp();
    const res = await request(app).get(`${BASE}/timeline`).expect(200);
    expect(res.body.buckets.length).toBeGreaterThan(0);
    expect(res.body.activeAlarms.length).toBeGreaterThan(0);
    // Every bucket's errorRate is a real fraction, never NaN.
    for (const b of res.body.buckets) {
      expect(Number.isFinite(b.errorRate)).toBe(true);
      expect(b.errorRate).toBeGreaterThanOrEqual(0);
    }
    // orgiq-advisor's prompt was registered 4h before the frozen clock — the
    // default 24h window reaches it.
    expect(res.body.deployMarkers.some((m: { agentId: string }) => m.agentId === 'orgiq-advisor')).toBe(true);
  });

  it('/alarms reports the HITL probe honestly quiet — the one PENDING row is minutes old', async () => {
    const app = buildApp();
    const res = await request(app).get(`${BASE}/alarms`).expect(200);
    const names = (res.body.alarms as Array<{ name: string }>).map((a) => a.name);
    expect(names).not.toContain('hitl-stale');
    expect(names).not.toContain('hitl-depth');
  });

  it('/hitl-sla reports the seeded queue: one pending, two decided, one expired, in the default 24h window', async () => {
    const app = buildApp();
    const res = await request(app).get(`${BASE}/hitl-sla`).expect(200);
    expect(res.body).toMatchObject({
      pendingCount: 1,
      decidedInWindow: 2,
      expiredInWindow: 1,
      slaThresholdSeconds: 300,
    });
    expect(res.body.oldestPendingAgeSeconds).toBeGreaterThan(0);
    expect(res.body.oldestPendingAgeSeconds).toBeLessThan(600);
    // 1 of 3 decisions (adr-batch-14, 3 minutes) landed under the 5-minute SLA.
    expect(res.body.slaCompliantFraction).toBeCloseTo(1 / 3, 6);
  });

  it('/recent-events merges deploys, HITL decisions and judge regressions, newest first', async () => {
    const app = buildApp();
    const res = await request(app).get(`${BASE}/recent-events`).expect(200);
    const events = res.body.events as Array<{ ts: string; kind: string; title: string }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events.map((e) => e.ts)).toEqual([...events.map((e) => e.ts)].sort().reverse());
    const kinds = new Set(events.map((e) => e.kind));
    expect(kinds.has('hitl-decided')).toBe(true);
    expect(kinds.has('hitl-expired')).toBe(true);
    // The EXPIRED row carries the same note the server-side auto-expiry
    // always writes (`applyDecision(id, 'EXPIRED', 'system', 'auto-expired
    // after 5min')` in routes/approvals.ts) — a real note, so the route's
    // `note || 'No human responded…'` fallback never triggers here.
    const expired = events.find((e) => e.kind === 'hitl-expired')!;
    expect((expired as unknown as { detail: string }).detail).toBe('auto-expired after 5min');
  });

  it('/recent-events names the real approver on a decided HITL event', async () => {
    const app = buildApp();
    const res = await request(app).get(`${BASE}/recent-events`).expect(200);
    const events = res.body.events as Array<{ kind: string; title: string }>;
    expect(events.some((e) => e.kind === 'hitl-decided' && e.title.includes('Vera Green') && !e.title.includes('u-vera'))).toBe(true);
  });
});

describe('the mock branch answers an honest empty — no marker', () => {
  it('every route renders a real empty state when nothing has ever been requested or ingested', async () => {
    const app = buildApp();
    await inScenario('empty', async () => {
      const alarms = (await request(app).get(`${BASE}/alarms`).expect(200)).body;
      expect(alarms.degraded).toBeUndefined();
      // No approvals AND no traces: every probe ran and found nothing wrong.
      expect(alarms.alarms).toEqual([
        expect.objectContaining({ name: 'overall', severity: 'ok' }),
      ]);

      const sla = (await request(app).get(`${BASE}/hitl-sla`).expect(200)).body;
      expect(sla.degraded).toBeUndefined();
      expect(sla).toMatchObject({ pendingCount: 0, decidedInWindow: 0, slaCompliantFraction: null });

      const timeline = (await request(app).get(`${BASE}/timeline`).expect(200)).body;
      expect(timeline.degraded).toBeUndefined();
      expect(timeline.buckets).toEqual([]);

      const events = (await request(app).get(`${BASE}/recent-events`).expect(200)).body;
      expect(events.degraded).toBeUndefined();
      expect(events.events).toEqual([]);
    });
  });
});

describe('the mock branch degrades honestly on the error world', () => {
  it('marks every route degraded, with a reason, when the trace table is unreadable', async () => {
    const app = buildApp();
    await inScenario('error', async () => {
      for (const path of ['/timeline', '/alarms', '/hitl-sla', '/recent-events']) {
        const res = await request(app).get(`${BASE}${path}`).expect(200);
        expect(res.body.degraded).toBe(true);
        expect(typeof res.body.error).toBe('string');
        expect(res.body.error.length).toBeGreaterThan(0);
      }
    });
  });

  it('/alarms still distinguishes the unknown-probe beacon from ok, and folds it into `degraded`', async () => {
    const app = buildApp();
    await inScenario('error', async () => {
      const res = await request(app).get(`${BASE}/alarms`).expect(200);
      const severities = (res.body.alarms as Array<{ severity: string }>).map((a) => a.severity);
      expect(severities).toContain('unknown');
      expect(severities).not.toContain('ok');
      expect(res.body.degraded).toBe(true);
    });
  });
});
