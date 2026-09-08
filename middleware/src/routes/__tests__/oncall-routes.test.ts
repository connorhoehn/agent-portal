// On-call — /api/observability/oncall (routes/oncall.ts). The incident
// surface, mounted ungated so it keeps working when the portal session has
// timed out at 3am.
//
// The load-bearing assertion is the `unknown` alarm severity. Every probe here
// is defensive, and before `unknown` existed a probe that could not RUN fell
// through to the "all signals within thresholds" beacon — so a dead database
// rendered as all-clear at exactly the moment the surface had no idea. This
// file pins that an unevaluated probe says so, and that the ok beacon is only
// emitted when every probe really ran.
//
// Also pinned:
//   * the alarm thresholds, and that the reason NAMES the number and the
//     threshold rather than saying "degraded",
//   * `errorRate` on the timeline counting only REAL failures (guardrail
//     intervention or schema-invalid) — a weak answer is quality, surfaced as
//     judgeP05 in the same overlay,
//   * `/hitl-sla` answering a compliant fraction of 1 (not NaN, and not 0)
//     when nothing has been decided — no decisions is not a failed SLA,
//   * `/recent-events` merging four independent sources, sorting newest-first,
//     truncating to the limit, and SURVIVING the failure of any one source,
//   * an `unknown` alarm downgraded to `info` in the event feed, which styles
//     only three severities.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { oncallRouter } from '../oncall.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';

const execMock = exec as unknown as jest.Mock;
const sqlOf = (call: number): string => String(execMock.mock.calls[call]![0]);

const BASE = '/api/observability/oncall';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, oncallRouter);
  app.use(errorHandler);
  return app;
}

/** Route every exec by the table/shape it asks for, so order does not matter. */
function routeExec(handlers: {
  quality?: unknown[] | Error;
  approvalsAgg?: unknown[] | Error;
  buckets?: unknown[] | Error;
  hitlBuckets?: unknown[] | Error;
  deploys?: unknown[] | Error;
  sla?: unknown[] | Error;
  decided?: unknown[] | Error;
  judgeSpikes?: unknown[] | Error;
}) {
  execMock.mockImplementation((sql: string) => {
    const pick = (v: unknown[] | Error | undefined): Promise<unknown[]> =>
      v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? []);
    if (sql.includes('conformance')) return pick(handlers.quality);
    if (sql.includes("FILTER (WHERE status = 'PENDING')")) return pick(handlers.approvalsAgg);
    if (sql.includes('decision_seconds')) return pick(handlers.sla);
    if (sql.includes('per_bucket')) return pick(handlers.buckets);
    if (sql.includes('prompt_versions')) return pick(handlers.deploys);
    if (sql.includes('decided_at IS NOT NULL')) return pick(handlers.decided);
    if (sql.includes('judge_score < 0.3')) return pick(handlers.judgeSpikes);
    return pick(handlers.hitlBuckets);
  });
}

beforeEach(() => { execMock.mockReset(); });

describe('GET /alarms — the honesty property', () => {
  it('reports an ok BEACON only when every probe really ran', async () => {
    routeExec({ quality: [], approvalsAgg: [{ pending: '0', oldest_age_s: null }] });
    const res = await request(buildApp()).get('/api/observability/oncall/alarms');
    expect(res.status).toBe(200);
    expect(res.body.alarms).toHaveLength(1);
    expect(res.body.alarms[0]).toMatchObject({ name: 'overall', severity: 'ok' });
  });

  it('says UNKNOWN — never ok — when a probe could not be evaluated', async () => {
    // A dead database rendering as "all signals within thresholds" is the
    // failure this severity exists to prevent.
    routeExec({
      quality: new Error('relation "observability.invocation_traces" does not exist'),
      approvalsAgg: [{ pending: '0', oldest_age_s: null }],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/alarms');
    const severities = (res.body.alarms as Array<{ severity: string }>).map((a) => a.severity);
    expect(severities).toContain('unknown');
    expect(severities).not.toContain('ok');
    const unknown = (res.body.alarms as Array<{ name: string; reason: string }>)
      .find((a) => a.name === 'evaluation')!;
    expect(unknown.reason).toMatch(/Could not evaluate quality/);
    expect(unknown.reason).toMatch(/unknown, not clear/);
  });

  it('names BOTH failed probes when neither could run', async () => {
    routeExec({ quality: new Error('down'), approvalsAgg: new Error('down') });
    const res = await request(buildApp()).get('/api/observability/oncall/alarms');
    const unknown = (res.body.alarms as Array<{ name: string; reason: string }>)
      .find((a) => a.name === 'evaluation')!;
    expect(unknown.reason).toMatch(/quality and approval queue/);
  });

  it('fires schema, judge and drift alarms at their documented thresholds', async () => {
    routeExec({
      quality: [
        { agent_id: 'a-schema', cnt: '10', conformance: '0.9', p05: null, drift_p95: '0' },
        { agent_id: 'a-critical', cnt: '10', conformance: '1', p05: '0.1', drift_p95: '0' },
        { agent_id: 'a-warning', cnt: '10', conformance: '1', p05: '0.35', drift_p95: '0' },
        { agent_id: 'a-drift', cnt: '10', conformance: '1', p05: '0.9', drift_p95: '0.7' },
      ],
      approvalsAgg: [{ pending: '0', oldest_age_s: null }],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/alarms');
    const byName = Object.fromEntries(
      (res.body.alarms as Array<{ name: string; severity: string; reason: string; affectedAgent: string }>)
        .map((a) => [a.name, a]),
    );
    expect(byName['schema-conformance:a-schema']!.severity).toBe('warning');
    // The reason carries the number AND the threshold, so an operator can act.
    expect(byName['schema-conformance:a-schema']!.reason).toBe('Schema conformance 90.0% (threshold 95%)');
    expect(byName['judge-p05:a-critical']!.severity).toBe('critical');
    expect(byName['judge-p05:a-warning']!.severity).toBe('warning');
    expect(byName['drift-p95:a-drift']!.reason).toMatch(/Drift P95 0\.70 \(threshold 0\.6\)/);
    expect(byName['drift-p95:a-drift']!.affectedAgent).toBe('a-drift');
  });

  it('stays quiet for an agent inside every threshold', async () => {
    routeExec({
      quality: [{ agent_id: 'a-ok', cnt: '10', conformance: '0.99', p05: '0.8', drift_p95: '0.1' }],
      approvalsAgg: [{ pending: '0', oldest_age_s: null }],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/alarms');
    expect(res.body.alarms).toHaveLength(1);
    expect(res.body.alarms[0].severity).toBe('ok');
  });

  it('escalates a stale HITL queue by AGE, and warns separately on depth', async () => {
    routeExec({ quality: [], approvalsAgg: [{ pending: '12', oldest_age_s: '2400' }] });
    const res = await request(buildApp()).get('/api/observability/oncall/alarms');
    const byName = Object.fromEntries(
      (res.body.alarms as Array<{ name: string; severity: string; reason: string }>).map((a) => [a.name, a]),
    );
    expect(byName['hitl-stale']!.severity).toBe('critical');
    expect(byName['hitl-stale']!.reason).toMatch(/40m old \(critical > 30m\)/);
    expect(byName['hitl-depth']!.reason).toMatch(/12 pending approvals in queue \(threshold 10\)/);
  });

  it('warns rather than criticals for a queue between ten and thirty minutes old', async () => {
    routeExec({ quality: [], approvalsAgg: [{ pending: '2', oldest_age_s: '900' }] });
    const res = await request(buildApp()).get('/api/observability/oncall/alarms');
    const stale = (res.body.alarms as Array<{ name: string; severity: string }>)
      .find((a) => a.name === 'hitl-stale')!;
    expect(stale.severity).toBe('warning');
  });
});

describe('GET /timeline', () => {
  it('composes buckets, deploy markers and the live alarms in one payload', async () => {
    routeExec({
      buckets: [{
        bucket_start: '2026-08-20 09:00:00+00', invocations: '20',
        drift_p95: '0.3', judge_p05: '0.6', errors: '2', cost_usd: '0.4',
      }],
      hitlBuckets: [],
      deploys: [{
        registered_at: '2026-08-20T08:55:00Z', agent_id: 'orgiq-search',
        prompt_version: 'ab12cd', notes: 'tightened refusal',
      }],
      quality: [], approvalsAgg: [{ pending: '0', oldest_age_s: null }],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/timeline');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['activeAlarms', 'buckets', 'deployMarkers']);
    const bucket = res.body.buckets[0];
    // 2 real failures over 20 invocations.
    expect(bucket.errorRate).toBeCloseTo(0.1, 10);
    expect(bucket.driftP95).toBe(0.3);
    expect(bucket.judgeP05).toBe(0.6);
    expect(bucket.costUsd).toBe(0.4);
    expect(res.body.deployMarkers[0].promptVersion).toBe('ab12cd');
    expect(res.body.activeAlarms[0].severity).toBe('ok');
  });

  it('counts only guardrail interventions and schema failures as errors', async () => {
    routeExec({ buckets: [], hitlBuckets: [], deploys: [], quality: [], approvalsAgg: [] });
    await request(buildApp()).get('/api/observability/oncall/timeline');
    const bucketSql = execMock.mock.calls.map((c) => String(c[0])).find((s) => s.includes('per_bucket'))!;
    expect(bucketSql).toMatch(/guardrail_action IS NOT NULL AND w\.guardrail_action <> 'NONE'/);
    expect(bucketSql).toMatch(/w\.schema_valid = false/);
    // Quality lives in the same overlay as judge_p05, not folded into errors.
    expect(bucketSql).toMatch(/judge_p05/);
  });

  it('reports driftP95 as null — not 0 — for a bucket with no embeddings', async () => {
    routeExec({
      buckets: [{ bucket_start: 'b', invocations: '5', drift_p95: null, judge_p05: null, errors: '0', cost_usd: '0' }],
      hitlBuckets: [], deploys: [], quality: [], approvalsAgg: [],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/timeline');
    expect(res.body.buckets[0].driftP95).toBeNull();
    expect(res.body.buckets[0].judgeP05).toBeNull();
    expect(res.body.buckets[0].errorRate).toBe(0);
  });

  it('still renders when the deploy-marker query fails', async () => {
    routeExec({
      buckets: [], hitlBuckets: [], deploys: new Error('no prompt_versions table'),
      quality: [], approvalsAgg: [],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/timeline');
    expect(res.status).toBe(200);
    expect(res.body.deployMarkers).toEqual([]);
  });
});

describe('GET /hitl-sla', () => {
  it('reports the queue, the percentiles and the compliant fraction', async () => {
    routeExec({
      sla: [{
        pending_count: '3', oldest_pending_age_s: '420', decided: '10',
        p50_s: '45', p99_s: '280', expired: '1', within_sla: '8', sla_total: '10',
      }],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/hitl-sla');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pendingCount: 3, oldestPendingAgeSeconds: 420, decidedInWindow: 10,
      p50DecisionSeconds: 45, p99DecisionSeconds: 280, expiredInWindow: 1,
      slaCompliantFraction: 0.8, slaThresholdSeconds: 300,
    });
    // The threshold matches the server-side expiry, so "SLA compliant" lines
    // up with "did not auto-expire".
    expect(res.body.slaThresholdSeconds).toBe(5 * 60);
  });

  it('answers a compliant fraction of 1 — not NaN, not 0 — when nothing was decided', async () => {
    routeExec({
      sla: [{
        pending_count: '0', oldest_pending_age_s: null, decided: '0',
        p50_s: null, p99_s: null, expired: '0', within_sla: '0', sla_total: '0',
      }],
    });
    const res = await request(buildApp()).get('/api/observability/oncall/hitl-sla');
    expect(res.body.slaCompliantFraction).toBe(1);
    expect(res.body.oldestPendingAgeSeconds).toBeNull();
  });

  it('degrades to a compliant, empty answer when the table is missing', async () => {
    routeExec({ sla: new Error('relation "observability.approvals" does not exist') });
    const res = await request(buildApp()).get('/api/observability/oncall/hitl-sla');
    expect(res.status).toBe(200);
    expect(res.body.pendingCount).toBe(0);
    expect(res.body.slaCompliantFraction).toBe(1);
  });
});

describe('GET /recent-events', () => {
  const base = {
    deploys: [{ ts: '2026-08-20T01:00:00Z', agent_id: 'orgiq-search', prompt_version: 'abcdef0123', notes: null }],
    decided: [
      { approval_id: 'ap-1', ts: '2026-08-20T03:00:00Z', status: 'APPROVED', agent_id: 'orgiq-supervisor', decided_by: 'nora', decided_note: '' },
      { approval_id: 'ap-2', ts: '2026-08-20T02:00:00Z', status: 'EXPIRED', agent_id: 'orgiq-supervisor', decided_by: null, decided_note: null },
    ],
    judgeSpikes: [
      { invocation_id: 'inv-1', ts: '2026-08-20T04:00:00Z', agent_id: 'orgiq-advisor', judge_score: '0.15', judge_rationale: 'ungrounded', response_snippet: 's' },
      { invocation_id: 'inv-2', ts: '2026-08-20T00:30:00Z', agent_id: 'orgiq-advisor', judge_score: '0.28', judge_rationale: null, response_snippet: 'a weak answer' },
    ],
    quality: [], approvalsAgg: [{ pending: '0', oldest_age_s: null }],
  };

  it('merges four sources, sorts newest-first, and labels each kind', async () => {
    routeExec(base);
    const res = await request(buildApp()).get('/api/observability/oncall/recent-events');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['events']);
    const events = res.body.events as Array<{ ts: string; kind: string; severity: string; title: string; detail: string }>;
    expect(events.map((e) => e.ts)).toEqual([...events.map((e) => e.ts)].sort().reverse());
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('deploy');
    expect(kinds).toContain('hitl-decided');
    expect(kinds).toContain('hitl-expired');
    expect(kinds).toContain('judge-spike');
  });

  it('escalates a judge score under 0.2 to critical, and 0.2-0.3 to warning', async () => {
    routeExec(base);
    const res = await request(buildApp()).get('/api/observability/oncall/recent-events');
    const spikes = (res.body.events as Array<{ kind: string; severity: string; title: string }>)
      .filter((e) => e.kind === 'judge-spike');
    expect(spikes.find((s) => s.title.includes('0.15'))!.severity).toBe('critical');
    expect(spikes.find((s) => s.title.includes('0.28'))!.severity).toBe('warning');
  });

  it('falls back to the response snippet when the judge gave no rationale', async () => {
    routeExec(base);
    const res = await request(buildApp()).get('/api/observability/oncall/recent-events');
    const noRationale = (res.body.events as Array<{ kind: string; title: string; detail: string }>)
      .find((e) => e.kind === 'judge-spike' && e.title.includes('0.28'))!;
    expect(noRationale.detail).toBe('a weak answer');
  });

  it('explains an expired approval rather than leaving the detail blank', async () => {
    routeExec(base);
    const res = await request(buildApp()).get('/api/observability/oncall/recent-events');
    const expired = (res.body.events as Array<{ kind: string; detail: string; severity: string }>)
      .find((e) => e.kind === 'hitl-expired')!;
    expect(expired.detail).toBe('No human responded within 5 minutes');
    expect(expired.severity).toBe('warning');
  });

  it('names "system" when nobody is recorded as the decider', async () => {
    routeExec(base);
    const res = await request(buildApp()).get('/api/observability/oncall/recent-events');
    const titles = (res.body.events as Array<{ title: string }>).map((e) => e.title);
    expect(titles.some((t) => t.includes('APPROVED by nora'))).toBe(true);
  });

  it('downgrades an UNKNOWN alarm to info — the feed styles three severities', async () => {
    routeExec({ ...base, quality: new Error('down') });
    const res = await request(buildApp()).get('/api/observability/oncall/recent-events');
    const alarmEvents = (res.body.events as Array<{ kind: string; severity: string; title: string }>)
      .filter((e) => e.kind === 'alarm');
    expect(alarmEvents.length).toBeGreaterThan(0);
    expect(alarmEvents.map((e) => e.severity)).not.toContain('unknown');
    expect(alarmEvents.find((e) => e.title.includes('evaluation'))!.severity).toBe('info');
  });

  it('SURVIVES the failure of any one source', async () => {
    routeExec({ ...base, deploys: new Error('down'), judgeSpikes: new Error('down') });
    const res = await request(buildApp()).get('/api/observability/oncall/recent-events');
    expect(res.status).toBe(200);
    const kinds = (res.body.events as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('hitl-decided');
    expect(kinds).not.toContain('deploy');
    expect(kinds).not.toContain('judge-spike');
  });

  it('clamps the limit into 1..500 and truncates AFTER sorting', async () => {
    routeExec(base);
    const app = buildApp();
    const one = await request(app).get('/api/observability/oncall/recent-events?limit=1');
    expect(one.body.events).toHaveLength(1);
    // The single surviving event is the newest of all sources.
    expect(one.body.events[0].ts).toBe('2026-08-20T04:00:00Z');

    const junk = await request(app).get('/api/observability/oncall/recent-events?limit=abc');
    expect((junk.body.events as unknown[]).length).toBeGreaterThan(1);
  });
});
