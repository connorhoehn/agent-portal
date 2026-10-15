// docs/assessment-journeys/{lead-assessor,program-lead,admin}/DEFECTS.md filed
// the same defect under all three roles: a submission that has been scored
// still reads "Unprocessed" (the "Processed" filter pill was unreachable —
// the middleware only ever wrote staged/committed/superseded, never
// scored/processed), and a team's status pill could read "New" while its own
// dimensions showed 17/17 assessed.
//
// Root cause: `team.status` was a hand-set constant (only ever written at
// createTeam/resetAssessment) instead of being derived from the dims
// applyScores mutates, and a submission envelope's `status` never reflected
// whether its own hinted dimensions had actually been scored.
//
// Fix: `M.deriveTeamStatus` (mock/assessment.ts) computes NEW/IN_PROGRESS/
// ASSESSED from the team's dimension scores and is now applied at the end of
// every `applyScores` call (both the mock and Aurora paths — see
// assessment-aurora.test.ts for the Aurora-side assertion). Separately,
// `M.isSubmissionProcessed` computes a read-time-only 'processed' override
// for a `committed` envelope once every dimension its self-assessment hinted
// at has been scored *after* it was ingested — schema/assessment_schema.sql's
// CHECK on assessment_submissions.status only allows staged/committed/
// superseded, so this is never persisted, only projected onto the wire by
// `wireSubmissionStatus` in listSubmissions/getSubmissionDetail.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import * as provider from '../assessment.js';
import * as M from '../../mock/assessment.js';

function emptyScore(dimensionId: string, updatedAt: string): M.MockDimensionScore {
  return {
    dimension_id: dimensionId, current_level: null, is_na: false, confidence: 'low',
    self_claimed_level: null, evidence_class: null, cap_applied: false,
    evidence: [], follow_up_questions: [], history: [], updated_at: updatedAt,
  };
}

function hint(dimensionId: string): M.DimensionHint {
  return {
    dimension_id: dimensionId, main_answer: 'We do this.', matched_level: null,
    follow_up_answer: null, evidence_context: '', self_rating: 'Developing',
    self_rating_aspect: 'Some practice', claimed_na: false,
  };
}

function makeTeam(id: string): M.MockTeam {
  const now = new Date().toISOString();
  return {
    id, name: id, cohort: 'general', status: 'NEW', workflow_step: 1, assessment_lead: '',
    contacts: [], repos: [], archetype: null, rubric_version: M.DEFAULT_RUBRIC_VERSION,
    exceptions: [], created_at: now, updated_at: now,
    contributors: [],
  };
}

function makeCommittedEnvelope(
  teamId: string, envelopeId: string, dimensionIds: string[], ingestedAt: string,
): M.SubmissionEnvelope {
  return {
    schema_version: '1.0', envelope_id: envelopeId,
    source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: 'test.csv', origin_row: 1, form_submission_id: envelopeId },
    team_id: teamId, team_name_raw: teamId,
    submitter: { name: 'Test Submitter', email: 'test@example.com', is_primary_contact: true },
    submitted_at: ingestedAt, ingested_at: ingestedAt, assessment_date: ingestedAt.slice(0, 10),
    self_certified: true, supersedes: null,
    dimension_hints: dimensionIds.map(hint),
    status: 'committed', revision: 1,
  };
}

/** Every dim id except the given ones — used to seed the rest of a team's 17
 * dimensions as untouched so applyScores only needs to cover what a test
 * actually cares about. */
function seedEmptyDims(teamId: string, ingestedAt: string): void {
  const seededAt = new Date(Date.parse(ingestedAt) - 60_000).toISOString(); // strictly before ingestion
  M.setScoresFor(teamId, Object.fromEntries(
    M.DIMENSION_IDS.map((d) => [d, emptyScore(d, seededAt)]),
  ));
}

describe('applyScores advances the submission and team status it actually changed', () => {
  const TEAM_ID = 'TEAM-STATUS-1';
  const ENVELOPE_ID = 'sub-test-status-1';
  const INGESTED_AT = new Date().toISOString();

  beforeEach(() => {
    M.teams().push(makeTeam(TEAM_ID));
    seedEmptyDims(TEAM_ID, INGESTED_AT);
    M.upsertSubmission(makeCommittedEnvelope(TEAM_ID, ENVELOPE_ID, ['1', '2', '3'], INGESTED_AT));
    M.addScoringLog({ team_id: TEAM_ID, envelope_id: ENVELOPE_ID, run_id: 'run-attributed-submission', stamp: 'test', source: 'agent', scores: [] });
  });

  afterEach(() => {
    M.dropTeam(TEAM_ID);
  });

  it('scoring every dimension a submission hinted at flips its status to "processed"', async () => {
    const before = await provider.getSubmissionDetail(TEAM_ID, ENVELOPE_ID);
    expect(before?.status).toBe('committed');

    const result = await provider.applyScores(TEAM_ID, {
      relevant_dimension_ids: ['1', '2', '3'],
      scores: ['1', '2', '3'].map((dimension_id) => ({
        dimension_id, suggested_level: 2, confidence: 'moderate' as const, source_meeting: 'run-attributed-submission', rationale: 'Scored via test.',
      })),
    });
    expect(result?.applied).toHaveLength(3);

    const after = await provider.getSubmissionDetail(TEAM_ID, ENVELOPE_ID);
    expect(after?.status).toBe('processed');

    // The "Processed" filter reads listSubmissions the same way the route
    // does — assert the fix holds there too, not just on the detail read.
    const listing = await provider.listSubmissions();
    const group = listing.groups.find((g) => g.latest_envelope_id === ENVELOPE_ID);
    expect(group?.status).toBe('processed');
  });

  it('scoring only some of a submission\'s hinted dimensions leaves it "committed", not "processed"', async () => {
    await provider.applyScores(TEAM_ID, {
      relevant_dimension_ids: ['1', '2'],
      scores: [
        { dimension_id: '1', suggested_level: 2, confidence: 'moderate' as const, source_meeting: 'run-attributed-submission', rationale: 'Scored via test.' },
        { dimension_id: '2', suggested_level: 2, confidence: 'moderate' as const, source_meeting: 'run-attributed-submission', rationale: 'Scored via test.' },
      ],
    });

    const after = await provider.getSubmissionDetail(TEAM_ID, ENVELOPE_ID);
    expect(after?.status).toBe('committed');
  });

  it('a dimension scored to "documented / pending" (moderate confidence, no verified level) still counts as processed', async () => {
    // The audit's repro: a scoring pass looked at a dimension and concluded
    // there isn't enough evidence to set a level yet — current_level stays
    // null, is_na stays false, but the dimension WAS worked (a history entry
    // is recorded). That must be enough to flip the submission to
    // "processed"; the old predicate demanded a resolved level/N/A and kept
    // reading "Unprocessed" forever for this outcome.
    const result = await provider.applyScores(TEAM_ID, {
      relevant_dimension_ids: ['1', '2', '3'],
      scores: ['1', '2', '3'].map((dimension_id) => ({
        dimension_id, suggested_level: null, confidence: 'moderate' as const,
        source_meeting: 'run-attributed-submission', rationale: 'Not enough evidence to set a level yet.',
      })),
    });
    expect(result?.applied).toHaveLength(3);
    for (const dim of ['1', '2', '3']) {
      expect(M.scoresFor(TEAM_ID)![dim]!.current_level).toBeNull();
      expect(M.scoresFor(TEAM_ID)![dim]!.is_na).toBe(false);
    }

    const after = await provider.getSubmissionDetail(TEAM_ID, ENVELOPE_ID);
    expect(after?.status).toBe('processed');

    const listing = await provider.listSubmissions();
    const group = listing.groups.find((g) => g.latest_envelope_id === ENVELOPE_ID);
    expect(group?.status).toBe('processed');
  });

  it('attaching more evidence without a scoring pass does not, by itself, mark a dimension processed', async () => {
    // The audit also noted attaching evidence made a row LESS likely to read
    // processed — evidence alone (no history entry) must not count.
    const dims = M.scoresFor(TEAM_ID)!;
    dims['3'] = {
      ...dims['3']!,
      evidence: [
        ...dims['3']!.evidence,
        {
          evidence_id: 'EV-manual', dimension_id: '3', source_type: 'document',
          excerpt: 'Uploaded but not yet reviewed.', supports_level: null,
          captured_at: new Date().toISOString(), source_ref: 'PROV-manual', scored: false, status: 'PENDING',
        },
      ],
      updated_at: new Date().toISOString(),
    };

    await provider.applyScores(TEAM_ID, {
      relevant_dimension_ids: ['1', '2'],
      scores: [
        { dimension_id: '1', suggested_level: 2, confidence: 'moderate' as const, source_meeting: 'run-attributed-submission', rationale: 'Scored via test.' },
        { dimension_id: '2', suggested_level: 2, confidence: 'moderate' as const, source_meeting: 'run-attributed-submission', rationale: 'Scored via test.' },
      ],
    });

    const after = await provider.getSubmissionDetail(TEAM_ID, ENVELOPE_ID);
    expect(after?.status).toBe('committed');
  });

  it('a resubmission (fresh envelope) is not treated as processed just because the team was already fully assessed', async () => {
    // Score all 17 dims so the team is genuinely ASSESSED...
    await provider.applyScores(TEAM_ID, {
      relevant_dimension_ids: [...M.DIMENSION_IDS],
      scores: M.DIMENSION_IDS.map((dimension_id) => ({
        dimension_id, suggested_level: 3, confidence: 'moderate' as const, source_meeting: 'run-attributed-submission', rationale: 'Scored via test.',
      })),
    });
    expect(M.teamStatus(TEAM_ID)).toBe('ASSESSED');

    // ...then a brand-new revision comes in after that scoring pass. It must
    // read as unprocessed until IT is scored, even though the team's
    // dimension scores already satisfy its hints.
    const laterIngest = new Date(Date.now() + 60_000).toISOString();
    const NEW_ENVELOPE_ID = 'sub-test-status-1-r2';
    M.upsertSubmission(makeCommittedEnvelope(TEAM_ID, NEW_ENVELOPE_ID, ['1', '2'], laterIngest));

    const detail = await provider.getSubmissionDetail(TEAM_ID, NEW_ENVELOPE_ID);
    expect(detail?.status).toBe('committed');
  });
});

describe('applyScores derives team.status from dimension scores (never a hand-set constant)', () => {
  const TEAM_ID = 'TEAM-STATUS-2';
  const INGESTED_AT = new Date().toISOString();

  beforeEach(() => {
    M.teams().push(makeTeam(TEAM_ID));
    seedEmptyDims(TEAM_ID, INGESTED_AT);
  });

  afterEach(() => {
    M.dropTeam(TEAM_ID);
  });

  it('starts NEW, moves to IN_PROGRESS once some (not all) dimensions are scored, and does not jump to ASSESSED early', async () => {
    expect(M.teamStatus(TEAM_ID)).toBe('NEW');

    const allButOne = M.DIMENSION_IDS.slice(0, -1);
    await provider.applyScores(TEAM_ID, {
      relevant_dimension_ids: allButOne,
      scores: allButOne.map((dimension_id) => ({
        dimension_id, suggested_level: 2, confidence: 'moderate' as const, rationale: 'Scored via test.',
      })),
    });

    // 16 of 17 scored — a partially-scored team must not read ASSESSED.
    expect(M.teamStatus(TEAM_ID)).toBe('IN_PROGRESS');
  });

  it('advances to ASSESSED once every dimension has been scored', async () => {
    await provider.applyScores(TEAM_ID, {
      relevant_dimension_ids: [...M.DIMENSION_IDS],
      scores: M.DIMENSION_IDS.map((dimension_id) => ({
        dimension_id, suggested_level: 3, confidence: 'moderate' as const, rationale: 'Scored via test.',
      })),
    });

    expect(M.teamStatus(TEAM_ID)).toBe('ASSESSED');
  });
});

// The tests above build their own teams, so none of them says anything about the
// world a developer running `dev:mock` actually opens. That world decided one of
// these statuses by a coin flip.
describe('seeded submission status requires provenance rather than guessing', () => {
  it('keeps legacy envelopes committed when history has no attributable run', async () => {
    const listing = await provider.listSubmissions();
    const statuses = new Set(listing.envelopes.map((e) => e.status));

    // TEAM-002's r3 revision arrived AFTER the team's last scoring pass, so it
    // waits. Every seeded dimension for that team is stamped daysAgo(14) and the
    // envelope used to be daysAgo(14) too — `isSubmissionProcessed` compares the
    // two with `>=`, and each stamp is sampled when its own fixture materializes,
    // so this row flipped between "committed" and "processed" run to run with
    // nothing changed. The wire snapshot caught it churning.
    const awaiting = listing.envelopes.find((e) => e.team_id === 'TEAM-002' && e.revision === 3);
    expect(awaiting?.status).toBe('committed');
    expect(Date.parse(awaiting!.ingested_at))
      .toBeGreaterThan(Date.parse(M.scoresFor('TEAM-002')!['1']!.history.at(-1)!.changed_at));

    // TEAM-005 has later team scores, but no envelope-linked run. Those scores
    // must not fabricate proof that this particular submission was processed.
    const done = listing.envelopes.find((e) => e.team_id === 'TEAM-005');
    expect(done?.status).toBe('committed');

    // A processed fixture needs explicit provenance; tests above provide it.
    // The historical seed must not acquire it from timestamp coincidence.
    expect(statuses).toContain('committed');
    expect(statuses).not.toContain('processed');
    expect(statuses).toContain('staged');
    expect(statuses).toContain('superseded');
  });
});
