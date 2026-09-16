// The offline half of routes/oncall.ts: the `observability.approvals` HITL
// fixture and the selectors built over it (plus the two `/timeline` bucket
// reads, which pull from the same trace corpus every other observability
// fixture test already exercises).
//
// oncall.ts was the one router with NO mock branch at all — every read went
// straight to `exec()`, which throws under `MOCK_AURORA`, is caught, and
// answers an empty payload. That is the "provider with no mock branch" bug
// class contract.ts names. This file pins the fixture and selectors that
// close it; oncall-mock-branch.test.ts (routes/__tests__/) pins the routes
// that read them.
//
// The clock is frozen for every case, same convention as
// observability-fixtures.test.ts: every approval below is authored as an
// OFFSET from `clock.hoursAgo()`, so an unfrozen read would be vague or flaky
// at UTC midnight.

import { fixtureRegistry, freezeClock, unfreezeClock } from '../core/index.js';
import { approvalRequests, bucketStartMs, pgTimestamp, type MockApprovalRow } from '../observability.js';
import {
  mockOncallHitlAlarmProbe,
  mockOncallHitlDecisionEvents,
  mockOncallHitlSla,
  mockOncallJudgeRegressions,
  mockOncallRecentDeploys,
  mockOncallTimelineBuckets,
  mockOncallTimelineHitl,
} from '../observability-queries.js';

const AT = '2026-09-08T15:20:00.000Z';

let restore: () => void;

beforeEach(() => {
  restore = freezeClock(AT);
  fixtureRegistry.resetAll('default');
});

afterEach(() => {
  restore();
  unfreezeClock();
  fixtureRegistry.resetAll('default');
});

function byId(rows: MockApprovalRow[], id: string): MockApprovalRow {
  const row = rows.find((r) => r.approval_id === id);
  if (!row) throw new Error(`no approval row with id ${id}`);
  return row;
}

// ── The fixture itself ──────────────────────────────────────────────────────

describe('approvalRequests — the observability.approvals fixture', () => {
  it('is the only agent that actually calls request_approval — orgiq-ingestion, every row', () => {
    const rows = approvalRequests.rows();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.agent_id).toBe('orgiq-ingestion');
  });

  it('carries one of each status the default corpus is authored to exercise', () => {
    const statuses = approvalRequests.rows().map((r) => r.status).sort();
    expect(statuses).toEqual(['APPROVED', 'APPROVED', 'EXPIRED', 'PENDING', 'REJECTED']);
  });

  it('the EXPIRED row was decided by "system" — the server-side auto-expiry, not a human', () => {
    const rows = approvalRequests.rows();
    const expired = rows.find((r) => r.status === 'EXPIRED')!;
    expect(expired.decided_by).toBe('system');
    expect(expired.decided_note).toBe('auto-expired after 5min');
  });

  it('the PENDING row is recent enough that neither HITL alarm threshold fires', () => {
    const pending = approvalRequests.rows().find((r) => r.status === 'PENDING')!;
    const ageS = (new Date(AT).getTime() - new Date(pending.requested_at).getTime()) / 1000;
    expect(ageS).toBeGreaterThan(0);
    expect(ageS).toBeLessThan(600); // below even the 10-minute warning threshold
  });

  it('declares an `empty` scenario with zero rows, and an `error` scenario that throws', () => {
    expect(approvalRequests.rows('empty')).toEqual([]);
    expect(() => approvalRequests.rows('error')).toThrow(/observability\.approvals unavailable/);
  });
});

// ── computeAlarms' HITL probe ───────────────────────────────────────────────

describe('mockOncallHitlAlarmProbe — unwindowed, matches computeAlarms\' SQL', () => {
  it('counts every PENDING row, not just recent ones', () => {
    const [row] = mockOncallHitlAlarmProbe();
    const pendingCount = approvalRequests.rows().filter((r) => r.status === 'PENDING').length;
    expect(row!['pending']).toBe(pendingCount);
  });

  it('reports the oldest PENDING request\'s age in seconds, from the one clock', () => {
    const [row] = mockOncallHitlAlarmProbe();
    const pending = byId(approvalRequests.rows(), 'ap-ing-postmortem-03');
    const expectedAgeS = (new Date(AT).getTime() - new Date(pending.requested_at).getTime()) / 1000;
    expect(row!['oldest_age_s']).toBeCloseTo(expectedAgeS, 3);
  });

  it('answers NULL — not 0 — when nothing is pending', () => {
    fixtureRegistry.resetAll('empty');
    const [row] = mockOncallHitlAlarmProbe();
    expect(row).toEqual({ pending: 0, oldest_age_s: null });
  });
});

// ── /hitl-sla ────────────────────────────────────────────────────────────────

describe('mockOncallHitlSla — matches the route\'s decision_seconds SQL', () => {
  it('excludes EXPIRED from `decided` but counts it in `sla_total`/`expired`', () => {
    const [row] = mockOncallHitlSla(24);
    // Within the default 24h window: REJECTED (ap-ing-perf-reviews-09),
    // APPROVED (ap-ing-adr-batch-14) and EXPIRED (ap-ing-allhands-recap-22).
    // The 30h-old APPROVED row falls outside the window entirely.
    expect(row!['decided']).toBe(2);
    expect(row!['expired']).toBe(1);
    expect(row!['sla_total']).toBe(3); // decision_seconds is non-null for all three
  });

  it('within_sla counts the one decision under the 5-minute threshold', () => {
    const [row] = mockOncallHitlSla(24);
    // adr-batch-14 decided in 3 minutes (180s, < 300s); perf-reviews-09 took
    // 15 minutes (900s); allhands-recap-22 EXPIRED at exactly 5 minutes
    // (300s, not < 300s).
    expect(row!['within_sla']).toBe(1);
  });

  it('pending_count and oldest_pending_age_s ignore the window entirely', () => {
    // requested 30h ago — outside a 6h window — but there is exactly one
    // PENDING row regardless of windowHours, because the real SQL's two
    // pending subqueries carry no `requested_at` filter at all.
    const wide = mockOncallHitlSla(24)[0]!;
    const narrow = mockOncallHitlSla(6)[0]!;
    expect(narrow['pending_count']).toBe(wide['pending_count']);
    expect(narrow['oldest_pending_age_s']).toBeCloseTo(wide['oldest_pending_age_s'] as number, 6);
  });

  it('answers a compliant, empty snapshot when nothing has ever been requested', () => {
    fixtureRegistry.resetAll('empty');
    const [row] = mockOncallHitlSla(24);
    expect(row).toMatchObject({
      pending_count: 0, oldest_pending_age_s: null, decided: 0,
      p50_s: null, p99_s: null, expired: 0, within_sla: 0, sla_total: 0,
    });
  });
});

// ── /recent-events sources ──────────────────────────────────────────────────

describe('mockOncallHitlDecisionEvents — decided (incl. EXPIRED), no status filter', () => {
  it('returns exactly the three approvals decided within the last 24h, newest first', () => {
    const rows = mockOncallHitlDecisionEvents(24);
    // Newest-first by decided_at, not requested_at: allhands-recap-22 was
    // REQUESTED after adr-batch-14 but DECIDED (expired) before it was.
    expect(rows.map((r) => r['approval_id'])).toEqual([
      'ap-ing-allhands-recap-22', 'ap-ing-adr-batch-14', 'ap-ing-perf-reviews-09',
    ]);
  });

  it('excludes the 30h-old decision once the window no longer reaches it', () => {
    const rows = mockOncallHitlDecisionEvents(24);
    expect(rows.some((r) => r['approval_id'] === 'ap-ing-legal-updates-01')).toBe(false);
    // A wide enough window reaches it.
    const wide = mockOncallHitlDecisionEvents(24 * 3);
    expect(wide.some((r) => r['approval_id'] === 'ap-ing-legal-updates-01')).toBe(true);
  });

  it('carries the real decided_by, in Postgres ::text timestamp form', () => {
    const row = mockOncallHitlDecisionEvents(24).find((r) => r['approval_id'] === 'ap-ing-adr-batch-14')!;
    expect(row['decided_by']).toBe('u-vera');
    expect(row['ts']).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\+00$/);
  });
});

describe('mockOncallRecentDeploys — the prompt registry, DESC, aliased to `ts`', () => {
  it('is newest-first and carries `ts` rather than `registered_at`', () => {
    const rows = mockOncallRecentDeploys(24);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r['registered_at']).toBeUndefined();
      expect(typeof r['ts']).toBe('string');
    }
    const stamps = rows.map((r) => String(r['ts']));
    expect(stamps).toEqual([...stamps].sort().reverse());
  });
});

describe('mockOncallJudgeRegressions — judge_score < 0.3, test traffic excluded', () => {
  it('every returned row is actually below the threshold', () => {
    const rows = mockOncallJudgeRegressions(24);
    for (const r of rows) expect(r['judge_score'] as number).toBeLessThan(0.3);
  });

  it('is newest-first', () => {
    const rows = mockOncallJudgeRegressions(24 * 7);
    const stamps = rows.map((r) => String(r['ts']));
    expect(stamps).toEqual([...stamps].sort().reverse());
  });
});

// ── /timeline's two bucket reads agree on their bucket keys ────────────────

describe('mockOncallTimelineBuckets / mockOncallTimelineHitl — matching bucket keys', () => {
  it('every hitl bucket_start is a bucket_start the signal-bucket read also produced', () => {
    const buckets = mockOncallTimelineBuckets(24, 15);
    const hitl = mockOncallTimelineHitl(24, 15);
    const bucketKeys = new Set(buckets.map((b) => b['bucket_start']));
    for (const h of hitl) expect(bucketKeys.has(h['bucket_start'])).toBe(true);
  });

  it('never reports a negative or fractional pending count', () => {
    const hitl = mockOncallTimelineHitl(24, 15);
    expect(hitl.length).toBeGreaterThan(0);
    for (const h of hitl) {
      expect(h['pending'] as number).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(h['pending'])).toBe(true);
      expect(Number.isInteger(h['decided'])).toBe(true);
    }
  });

  it('bucket_start round-trips through bucketStartMs consistently with pgTimestamp', () => {
    const hitl = mockOncallTimelineHitl(24, 15);
    for (const h of hitl) {
      const ms = new Date(String(h['bucket_start']).replace(' ', 'T').replace('+00', 'Z')).getTime();
      expect(pgTimestamp(bucketStartMs(new Date(ms).toISOString(), 15))).toBe(h['bucket_start']);
    }
  });
});
