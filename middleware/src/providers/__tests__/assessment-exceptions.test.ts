// REVIEW-2026-09-05 finding 1: a lead-assessor (or program-lead) held both
// ScoreAssessment (stage an is_na claim via POST /teams/:id/scores/apply,
// which opens a 'requested' exception) and ApproveException (approve it via
// PATCH /teams/:id/exceptions/:dimensionId) — nothing stopped the SAME
// identity from doing both. This exercises the mock-path fix at the
// provider level: applyScores now threads `requestedBy` onto the exception
// it opens, and patchException refuses an approve/deny where
// approved_by === requested_by (409) unless { override: true } is passed.
//
// Route-level 403/409/override wiring (including the admin-only override
// gate and its audit log) is covered separately in
// routes/__tests__/assessment-exceptions.test.ts.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';

function freeDimensionFor(teamId: string): string {
  const team = M.findTeam(teamId)!;
  const used = new Set(team.exceptions.map((e) => e.dimension_id));
  return M.DIMENSION_IDS.find((d) => !used.has(d))!;
}

describe('applyScores threads requestedBy onto a newly-opened exception', () => {
  it('records requested_by on the exception it opens', async () => {
    const dim = freeDimensionFor('TEAM-002');
    await provider.applyScores('TEAM-002', {
      relevant_dimension_ids: [dim],
      scores: [{ dimension_id: dim, is_na: true, suggested_level: 2, confidence: 'moderate', rationale: 'no prod service' }],
    }, 'u-lead-priya');

    const exceptions = await provider.listExceptions('TEAM-002');
    const opened = exceptions!.exceptions.find((e) => e.dimension_id === dim)!;
    expect(opened.status).toBe('requested');
    expect(opened.requested_by).toBe('u-lead-priya');
  });

  it('leaves requested_by unset when the caller passes none (backward compatible with existing 2-arg callers)', async () => {
    const dim = freeDimensionFor('TEAM-003');
    await provider.applyScores('TEAM-003', {
      relevant_dimension_ids: [dim],
      scores: [{ dimension_id: dim, is_na: true, suggested_level: 2, confidence: 'moderate', rationale: 'no prod service' }],
    });
    const exceptions = await provider.listExceptions('TEAM-003');
    const opened = exceptions!.exceptions.find((e) => e.dimension_id === dim)!;
    expect(opened.requested_by).toBeUndefined();
  });
});

describe('patchException: self-approval is refused (finding 1)', () => {
  it('409s when approved_by === requested_by, before it fails against seeded fixtures that predate the field', async () => {
    const dim = freeDimensionFor('TEAM-004');
    await provider.applyScores('TEAM-004', {
      relevant_dimension_ids: [dim],
      scores: [{ dimension_id: dim, is_na: true, suggested_level: 1, confidence: 'low', rationale: 'claims N/A' }],
    }, 'u-lead-self');

    const result = await provider.patchException('TEAM-004', dim, { status: 'approved', approved_by: 'u-lead-self' });
    expect(result).toEqual({ ok: false, status: 409, reason: expect.stringMatching(/cannot approve or deny/i) });

    // The exception is untouched — still requested, not silently approved.
    const exceptions = await provider.listExceptions('TEAM-004');
    expect(exceptions!.exceptions.find((e) => e.dimension_id === dim)!.status).toBe('requested');
  });

  it('a DIFFERENT lead-assessor may approve it normally', async () => {
    const dim = freeDimensionFor('TEAM-005');
    await provider.applyScores('TEAM-005', {
      relevant_dimension_ids: [dim],
      scores: [{ dimension_id: dim, is_na: true, suggested_level: 1, confidence: 'low', rationale: 'claims N/A' }],
    }, 'u-lead-a');

    const result = await provider.patchException('TEAM-005', dim, { status: 'approved', approved_by: 'u-lead-b' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.exception.status).toBe('approved');
  });

  it('admin may override a self-approval refusal with { override: true }', async () => {
    const dim = freeDimensionFor('TEAM-006');
    await provider.applyScores('TEAM-006', {
      relevant_dimension_ids: [dim],
      scores: [{ dimension_id: dim, is_na: true, suggested_level: 1, confidence: 'low', rationale: 'claims N/A' }],
    }, 'u-admin');

    const blocked = await provider.patchException('TEAM-006', dim, { status: 'approved', approved_by: 'u-admin' });
    expect(blocked.ok).toBe(false);

    const overridden = await provider.patchException('TEAM-006', dim, { status: 'approved', approved_by: 'u-admin', override: true });
    expect(overridden.ok).toBe(true);
    expect(overridden.ok && overridden.exception.status).toBe('approved');
  });

  it('a requested_by-less exception (seeded fixture) is never blocked — TEAM-001 dim 7', async () => {
    const before = await provider.listExceptions('TEAM-001');
    expect(before!.exceptions.find((e) => e.dimension_id === '7')!.requested_by).toBeUndefined();
    const result = await provider.patchException('TEAM-001', '7', { status: 'approved', approved_by: 'u-test' });
    expect(result.ok).toBe(true);
  });

  it('404s a team/dimension with no requested exception', async () => {
    const result = await provider.patchException('TEAM-999', '1', { status: 'approved', approved_by: 'u-test' });
    expect(result).toEqual({ ok: false, status: 404, reason: expect.any(String) });
  });
});
