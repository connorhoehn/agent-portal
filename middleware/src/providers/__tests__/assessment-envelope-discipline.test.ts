// applyScores is the deterministic seam an agent's output goes through — it
// is the reason the assessment agents are allowed to exist at all
// (docs/assessment-tenant.md: "the agent NEVER persists scores"). A mock that
// accepts any envelope is worse than a 503, because it makes a broken scoring
// run look like a clean one.
//
// A live sweep against `dev:mock` found five envelopes the verb waved through
// or died on. Each one is pinned here with the wire evidence it came from:
//
//   POST /teams/TEAM-004/scores/apply {"scores":[{"dimension_id":"2",
//     "level":4,...}]}                      -> 200 {"applied":[{"current_level":null}],
//                                              "rejected":[]}
//   ...same route, follow_up_questions:[123] -> 500 {"error":"Internal server error"}
//                                              (TypeError: text.toLowerCase is not a
//                                               function, at normalizeQuestion)
//
// The 500 also fired on POST /runs/:runId/complete — the agent CALLBACK — so a
// scorer emitting one bad question left its run `running` forever and burned a
// slot of RUN_CONCURRENCY_CAP with no way to release it.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';

const TEAM = 'TEAM-004';

/**
 * A minimal envelope entry the verb accepts, for one dimension. Typed loosely
 * on purpose: half these cases are envelopes an agent could really emit and
 * `ApplyScoreInput` would not admit — a number where a question string
 * belongs — which is exactly the shape the run-time check has to catch.
 */
const good = (dimension_id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  dimension_id, suggested_level: 2, confidence: 'moderate', rationale: 'observed in the pipeline', ...over,
});

const apply = (entry: Record<string, unknown>) => provider.applyScores(TEAM, {
  relevant_dimension_ids: [String(entry['dimension_id'])],
  scores: [entry as unknown as provider.ApplyScoreInput],
});

describe('applyScores refuses a malformed envelope instead of applying it', () => {
  it('a missing suggested_level is a refusal, not a silent null score', async () => {
    // The agent spelled the key `level`. Before: applied with current_level
    // null and rejected: [] — the dimension was un-scored and the caller told
    // the envelope was clean.
    const before = M.scoresFor(TEAM)!['2']!.current_level;
    const result = await apply({ dimension_id: '2', level: 4, confidence: 'high', rationale: 'r' });
    expect(result!.applied).toEqual([]);
    expect(result!.rejected[0]!.reason).toMatch(/suggested_level is required/);
    expect(M.scoresFor(TEAM)!['2']!.current_level).toBe(before);
  });

  it('an explicit null suggested_level is still a legitimate decision', async () => {
    // "There isn't enough evidence to set a level yet" is a real outcome and
    // must stay distinguishable from "the key was missing".
    const result = await apply(good('11', { suggested_level: null, rationale: 'not enough evidence yet' }));
    expect(result!.rejected).toEqual([]);
    expect(result!.applied).toEqual([{ dimension_id: '11', current_level: null, cap_applied: false }]);
  });

  it('a non-string follow-up question is refused, not a 500', async () => {
    // normalizeQuestion (the idempotency key) calls .toLowerCase() on it.
    const result = await apply(good('6', { follow_up_questions: [123] }));
    expect(result!.applied).toEqual([]);
    expect(result!.rejected[0]!.reason).toMatch(/follow_up_questions\[0\] must be a non-empty string/);
  });

  it('a non-string evidence excerpt is refused rather than stored', async () => {
    // `excerpt` is VERBATIM text on the scorecard; an object rendered as
    // "[object Object]" in the Evidence tab.
    const before = M.scoresFor(TEAM)!['5']!.evidence.length;
    const result = await apply(good('5', { evidence_excerpts: [{ a: 1 }] }));
    expect(result!.applied).toEqual([]);
    expect(result!.rejected[0]!.reason).toMatch(/evidence_excerpts\[0\] must be a non-empty string/);
    expect(M.scoresFor(TEAM)!['5']!.evidence).toHaveLength(before);
  });

  it('an out-of-rubric self_claimed_level is refused — it drives the claimed track', async () => {
    // Before: the dimension's certification read
    // "Claimed Level 99 · Verified up to Level 2", verification_gap 97.
    const result = await apply(good('8', { self_claimed_level: 99 }));
    expect(result!.applied).toEqual([]);
    expect(result!.rejected[0]!.reason).toMatch(/self_claimed_level 99 must be an integer 0\.\.5/);
    const detail = await provider.getTeamDetail(TEAM);
    const dim8 = detail!.dimensions.find((d) => d.id === '8')!;
    expect(dim8.certification.claimed_level ?? 0).toBeLessThanOrEqual(5);
  });

  it('a score with no rationale is refused — the history entry is the audit trail', async () => {
    const result = await apply({ dimension_id: '3', suggested_level: 2, confidence: 'high' });
    expect(result!.applied).toEqual([]);
    expect(result!.rejected[0]!.reason).toMatch(/rationale is required/);
  });

  it('a non-boolean is_na is refused rather than read as a truthy N/A claim', async () => {
    const result = await apply(good('9', { is_na: 'yes' }));
    expect(result!.applied).toEqual([]);
    expect(result!.rejected[0]!.reason).toMatch(/is_na "yes" must be a boolean/);
  });

  it('a well-formed envelope still applies, with evidence and follow-ups', async () => {
    const result = await provider.applyScores(TEAM, {
      relevant_dimension_ids: ['10'],
      scores: [good('10', {
        suggested_level: 4, confidence: 'high', evidence_class: 'observed',
        evidence_excerpts: ['Opened the dashboard directly.'],
        follow_up_questions: ['Who owns the runbook?'], self_claimed_level: 4,
      }) as unknown as provider.ApplyScoreInput],
    });
    expect(result!.rejected).toEqual([]);
    expect(result!.applied).toEqual([{ dimension_id: '10', current_level: 4, cap_applied: false }]);
  });
});

describe('a run record tells the truth about what apply-scores did', () => {
  const launch = async (teamId: string): Promise<string> => {
    const r = await provider.launchRun('score-dimensions', {}, teamId, 'u-farah');
    if (!r.ok) throw new Error(r.reason);
    return r.run_id;
  };

  const entry = (over: Record<string, unknown>): M.ScoringLogEntry => ({
    dimension_id: '1', is_na: false, suggested_level: 2, confidence: 'moderate',
    rationale: 'from the pipeline config', evidence_excerpts: [], follow_up_questions: [],
    na_claimed: false, self_claimed_level: null, evidence_class: 'documented', cap_applied: false,
    ...over,
  } as M.ScoringLogEntry);

  it('an entirely-refused scoring log fails the run instead of reporting "Scored N dimensions"', async () => {
    const runId = await launch('TEAM-006');
    const result = await provider.completeRun(runId, {
      status: 'completed',
      scoring_log: [entry({ follow_up_questions: [42] })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('failed');
    expect(result.run.error).toMatch(/apply-scores refused every entry/);
  });

  it('a partly-refused scoring log completes but says which entries were refused', async () => {
    const runId = await launch('TEAM-007');
    const result = await provider.completeRun(runId, {
      status: 'completed',
      scoring_log: [entry({ dimension_id: '1' }), entry({ dimension_id: '2', self_claimed_level: 42 })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('completed');
    expect(result.run.summary).toMatch(/1 entry refused by apply-scores/);
    expect(result.run.summary).toMatch(/dimension 2: self_claimed_level 42/);
  });

  it('a clean scoring log completes with no refusal note', async () => {
    const runId = await launch('TEAM-005');
    const result = await provider.completeRun(runId, {
      status: 'completed',
      scoring_log: [entry({ dimension_id: '1' })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.run.status).toBe('completed');
    expect(result.run.summary).not.toMatch(/refused/);
    expect(result.run.error).toBeNull();
  });
});
