// Covers the stretch-proof finding (docs/assessment-journeys/stretch/agent-e2e.md):
// a completed score-dimensions/process-self-assessment mock run used to write
// a single-dimension "plausible placeholder" scoring log and never apply it,
// leaving the scorecard at "Not yet assessed 0/17" forever.
//
// Two things are tested:
//  1. buildScoringLogForTeam — the pure function that turns what a team
//     actually has (intake evidence log, committed submission envelopes) into
//     a full 17-dimension ScoringLog, deterministically (seeded by team id +
//     dimension id, never Math.random) for dimensions with no evidence at all.
//  2. launchRun (mock path) — completing a score-dimensions run now applies
//     that log through the real applyScores seam, so the scorecard actually
//     changes.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';

function committedEnvelope(overrides: Partial<M.SubmissionEnvelope> & { dimension_hints: M.DimensionHint[] }): M.SubmissionEnvelope {
  return {
    schema_version: '1.0',
    envelope_id: 'sub-test-envelope',
    source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: 'test.csv', origin_row: 1, form_submission_id: '1' },
    team_id: 'TEAM-TEST',
    team_name_raw: 'Test Team',
    submitter: { name: 'Test Submitter', email: 'test@example.com', is_primary_contact: true },
    submitted_at: '1/1/2026 00:00',
    ingested_at: new Date().toISOString(),
    assessment_date: new Date().toISOString(),
    self_certified: true,
    supersedes: null,
    status: 'committed',
    revision: 1,
    ...overrides,
  };
}

function hint(overrides: Partial<M.DimensionHint> & { dimension_id: string }): M.DimensionHint {
  return {
    main_answer: '', matched_level: null, follow_up_answer: null, evidence_context: '',
    self_rating: '', self_rating_aspect: '', claimed_na: false,
    ...overrides,
  };
}

const emptyTeam = (id: string): M.MockTeam => ({
  id, name: id, cohort: 'general', status: 'NEW', workflow_step: 1, assessment_lead: '',
  contacts: [], repos: [], archetype: null, rubric_version: M.DEFAULT_RUBRIC_VERSION,
  exceptions: [], created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(), contributors: [],
});

describe('buildScoringLogForTeam (pure)', () => {
  it('always returns exactly 17 entries, one per dimension id', () => {
    const team = emptyTeam('TEAM-PURE-1');
    const log = provider.buildScoringLogForTeam(team, undefined, [], [], 'run-1');
    expect(log.scores).toHaveLength(17);
    expect(log.scores.map((s) => s.dimension_id).sort((a, b) => Number(a) - Number(b)))
      .toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1)));
    expect(log.team_id).toBe('TEAM-PURE-1');
    expect(log.source).toBe('mock');
    expect(log.run_id).toBe('run-1');
  });

  it('is deterministic: two calls against the same unchanged team produce the same scores', () => {
    const team = emptyTeam('TEAM-PURE-2');
    const log1 = provider.buildScoringLogForTeam(team, undefined, [], [], 'run-a');
    const log2 = provider.buildScoringLogForTeam(team, undefined, [], [], 'run-b');
    // run_id differs by design (it's carried through from the caller), but the
    // per-dimension scores — the deterministic, seeded part — must be identical.
    expect(log2.scores).toEqual(log1.scores);
  });

  it('a dimension with no evidence at all gets a low-confidence entry with a suggested_level in 0..2 and a named follow-up', () => {
    const team = emptyTeam('TEAM-PURE-3');
    const log = provider.buildScoringLogForTeam(team, undefined, [], [], 'run-1');
    for (const entry of log.scores) {
      expect(entry.confidence).toBe('low');
      expect(entry.is_na).toBe(false);
      expect(entry.self_claimed_level).toBeNull();
      expect(entry.suggested_level).toBeGreaterThanOrEqual(0);
      expect(entry.suggested_level).toBeLessThanOrEqual(2);
      expect(entry.rationale).toMatch(/no evidence was found/i);
      expect(entry.follow_up_questions).toHaveLength(1);
    }
  });

  it('splits evidence-backed vs no-evidence dimensions correctly', () => {
    const team = emptyTeam('TEAM-PURE-4');
    const evidenceLog: M.EvidenceLogItem[] = [{
      evidence_id: 'EV-1', dimension_id: '3', source_type: 'document', excerpt: 'A runbook.',
      supports_level: 2, captured_at: new Date().toISOString(), source_ref: 'PROV-1', scored: false, status: 'CLASSIFIED',
    }];
    const envelope = committedEnvelope({
      team_id: team.id,
      dimension_hints: [hint({ dimension_id: '5', self_rating: 'Developing', main_answer: 'We do CI.' })],
    });
    const log = provider.buildScoringLogForTeam(team, undefined, evidenceLog, [envelope], 'run-1');
    const summary = provider.summarizeScoringLog(log);
    expect(summary.fromEvidence).toBe(2); // dims 3 and 5
    expect(summary.noEvidence).toBe(15);
    const dim3 = log.scores.find((s) => s.dimension_id === '3')!;
    expect(dim3.evidence_excerpts).toContain('A runbook.');
    const dim5 = log.scores.find((s) => s.dimension_id === '5')!;
    expect(dim5.self_claimed_level).toBe(2); // "Developing" == level 2 on dimension 1's rubric; dimension 5 shares the same level-name vocabulary
  });

  it('a claimed_na hint produces an is_na claim (na_claimed) rather than a scored level', () => {
    const team = emptyTeam('TEAM-PURE-5');
    const envelope = committedEnvelope({
      team_id: team.id,
      dimension_hints: [hint({ dimension_id: '6', claimed_na: true, main_answer: 'We do not do this at all.' })],
    });
    const log = provider.buildScoringLogForTeam(team, undefined, [], [envelope], 'run-1');
    const dim6 = log.scores.find((s) => s.dimension_id === '6')!;
    expect(dim6.is_na).toBe(true);
    expect(dim6.na_claimed).toBe(true);
    expect(dim6.suggested_level).toBeNull();
  });

  it('applying a claimed_na entry opens a pending exception request (N/A is never self-granting)', async () => {
    const team = emptyTeam('TEAM-PURE-6');
    M.teams().push(team);
    M.setScoresFor(team.id, Object.fromEntries(
      M.DIMENSION_IDS.map((d) => [d, {
        dimension_id: d, current_level: null, is_na: false, confidence: 'low' as const,
        self_claimed_level: null, evidence_class: null, cap_applied: false,
        evidence: [], follow_up_questions: [], history: [], updated_at: new Date().toISOString(),
      }]),
    ));
    const envelope = committedEnvelope({
      team_id: team.id,
      dimension_hints: [hint({ dimension_id: '6', claimed_na: true })],
    });
    const log = provider.buildScoringLogForTeam(team, M.scoresFor(team.id)!, [], [envelope], 'run-1');
    const payload = {
      relevant_dimension_ids: [...M.DIMENSION_IDS],
      scores: log.scores.map((s) => ({
        dimension_id: s.dimension_id, is_na: s.is_na, suggested_level: s.suggested_level,
        confidence: s.confidence, rationale: s.rationale, evidence_excerpts: s.evidence_excerpts,
        follow_up_questions: s.follow_up_questions, self_claimed_level: s.self_claimed_level,
        evidence_class: s.evidence_class, source_meeting: 'run-1', changed_by: 'agent:score-dimensions',
      })),
    };
    await provider.applyScores(team.id, payload);
    expect(team.exceptions).toEqual([expect.objectContaining({ dimension_id: '6', status: 'requested' })]);
  });
});

describe('score-dimensions run completion applies scores to the scorecard (mock path)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('launching + completing a run for an unassessed team (TEAM-006) scores all 17 dimensions', async () => {
    const before = await provider.getTeamDetail('TEAM-006');
    expect(before!.dimensions.every((d) => d.current_level === null)).toBe(true);

    const launch = await provider.launchRun('score-dimensions', {}, 'TEAM-006');
    expect(launch.ok).toBe(true);
    if (!launch.ok) throw new Error('launch failed');

    await jest.advanceTimersByTimeAsync(8_000);

    const run = await provider.getRun(launch.run_id);
    expect(run!.status).toBe('completed');

    const after = await provider.getTeamDetail('TEAM-006');
    const scored = after!.dimensions.filter((d) => d.current_level !== null);
    expect(scored).toHaveLength(17);

    // The run's summary and files_written both name the scoring-log stamp
    // that was actually written for this run.
    const logs = await provider.listScoringLogs('TEAM-006');
    const newest = logs![0]!;
    expect(run!.files_written[0]).toContain(newest.stamp);
    expect(run!.summary).toMatch(/^Scored 17 dimensions: \d+ from evidence, \d+ low-confidence with no evidence; \d+ follow-ups? opened\.$/);

    const fullLog = await provider.getScoringLog('TEAM-006', newest.stamp);
    expect(fullLog!.scores).toHaveLength(17);
  });
});
