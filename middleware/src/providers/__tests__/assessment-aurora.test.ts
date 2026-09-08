// Aurora-path tests for the assessment tenant (providers/assessment-aurora.ts).
// The Data API is stubbed — nothing here talks to a real Aurora cluster (none
// is reachable in this environment). What's verified: (a) every statement
// that touches caller-supplied data parameterizes it — never string
// interpolation — and (b) row -> mock-shape mapping round-trips correctly for
// a team, a dimension score (with evidence/history), a run, and a feedback
// task. The mock path (providers/assessment.ts under MOCK_AURORA) is
// untouched by any of this — see assessment.test.ts / assessment-fixes.test.ts,
// which still pass unmodified against the same file.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import { exec } from '../aurora.js';
import * as A from '../assessment-aurora.js';

const execMock = exec as unknown as jest.Mock;

beforeEach(() => execMock.mockReset());

function sqlOf(callIndex = 0): string {
  return execMock.mock.calls[callIndex]![0] as string;
}
function paramsOf(callIndex = 0): Array<{ name: string; value: unknown }> {
  return (execMock.mock.calls[callIndex]![1] ?? []) as Array<{ name: string; value: unknown }>;
}

describe('teams', () => {
  const TEAM_ROW = {
    id: 'TEAM-001', name: 'Payments Core', cohort: 'white_glove', status: 'ACTIVE', workflow_step: 3,
    assessment_lead: 'lee@example.com', contacts: ['lee@example.com', 'kim@example.com'],
    repos: '[{"name":"payments-api","gitlab_url":"https://gitlab/payments-api"}]',
    contributors: '[{"initials":"LK","name":"Lee Kim"}]', archetype: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
  };
  const EXC_ROW = {
    team_id: 'TEAM-001', dimension_id: '6', status: 'approved', source: 'archetype',
    reason: 'no prod service', approved_by: 'lead@example.com', approved_at: '2026-01-05T00:00:00Z',
  };

  it('fetchTeam parameterizes the id and never interpolates it into the SQL text', async () => {
    execMock.mockResolvedValueOnce([TEAM_ROW]).mockResolvedValueOnce([EXC_ROW]);
    const team = await A.fetchTeam('TEAM-001');
    expect(sqlOf(0)).not.toContain('TEAM-001');
    expect(sqlOf(0)).toMatch(/WHERE id = :id/);
    expect(paramsOf(0)).toContainEqual({ name: 'id', value: { stringValue: 'TEAM-001' } });
    expect(sqlOf(1)).toMatch(/WHERE team_id = :tid/);
    expect(paramsOf(1)).toContainEqual({ name: 'tid', value: { stringValue: 'TEAM-001' } });

    // Row -> MockTeam shape: JSONB columns parsed, TEXT[] passed through,
    // exceptions joined in from the second query.
    expect(team).toEqual({
      id: 'TEAM-001', name: 'Payments Core', cohort: 'white_glove', status: 'ACTIVE', workflow_step: 3,
      assessment_lead: 'lee@example.com', contacts: ['lee@example.com', 'kim@example.com'],
      repos: [{ name: 'payments-api', gitlab_url: 'https://gitlab/payments-api' }],
      contributors: [{ initials: 'LK', name: 'Lee Kim' }],
      archetype: null,
      exceptions: [{
        dimension_id: '6', status: 'approved', source: 'archetype', reason: 'no prod service',
        approved_by: 'lead@example.com', approved_at: '2026-01-05T00:00:00Z',
      }],
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
    });
  });

  it('fetchTeam returns null for a missing team without a second round trip', async () => {
    execMock.mockResolvedValueOnce([]);
    expect(await A.fetchTeam('TEAM-999')).toBeNull();
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('a requested exception with no approved_at maps to the mock convention of an empty string, not null', async () => {
    execMock.mockResolvedValueOnce([TEAM_ROW]).mockResolvedValueOnce([{ ...EXC_ROW, status: 'requested', approved_at: null, approved_by: '' }]);
    const team = await A.fetchTeam('TEAM-001');
    expect(team!.exceptions[0]!.approved_at).toBe('');
  });

  it('nextTeamId increments the highest existing TEAM-0NN, ignoring malformed ids', async () => {
    execMock.mockResolvedValueOnce([{ id: 'TEAM-001' }, { id: 'TEAM-007' }, { id: 'not-a-team-id' }]);
    expect(await A.nextTeamId()).toBe('TEAM-008');
  });

  it('createTeamRow parameterizes name/cohort/lead and never inlines caller input into the INSERT', async () => {
    execMock.mockResolvedValueOnce([]) // INSERT
      .mockResolvedValueOnce([{ ...TEAM_ROW, id: 'TEAM-009', name: "Robert'); DROP TABLE assessment_teams;--" }])
      .mockResolvedValueOnce([]);
    await A.createTeamRow({ id: 'TEAM-009', name: "Robert'); DROP TABLE assessment_teams;--", cohort: 'general', assessment_lead: '' });
    expect(sqlOf(0)).not.toContain('DROP TABLE');
    expect(sqlOf(0)).toMatch(/INSERT INTO assessment_teams/);
    expect(paramsOf(0)).toContainEqual({ name: 'name', value: { stringValue: "Robert'); DROP TABLE assessment_teams;--" } });
  });

  it('patchTeamRow falls back to the existing value for an omitted field instead of nulling it out', async () => {
    execMock.mockResolvedValueOnce([TEAM_ROW]).mockResolvedValueOnce([EXC_ROW]) // fetchTeam (existing)
      .mockResolvedValueOnce([]) // UPDATE
      .mockResolvedValueOnce([{ ...TEAM_ROW, status: 'PAUSED' }]).mockResolvedValueOnce([]); // fetchTeam (after)
    await A.patchTeamRow('TEAM-001', { status: 'PAUSED' });
    const updateParams = paramsOf(2);
    expect(updateParams).toContainEqual({ name: 'name', value: { stringValue: 'Payments Core' } });
    expect(updateParams).toContainEqual({ name: 'status', value: { stringValue: 'PAUSED' } });
  });

  it('resetTeamAssessment clears scoring but never touches assessment_evidence', async () => {
    execMock.mockResolvedValueOnce([{ x: 1 }]) // teamExists
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const ok = await A.resetTeamAssessment('TEAM-001');
    expect(ok).toBe(true);
    const allSql = execMock.mock.calls.map((c) => c[0] as string).join('\n');
    expect(allSql).toMatch(/UPDATE assessment_dimension_scores/);
    expect(allSql).toMatch(/DELETE FROM assessment_follow_up_questions/);
    expect(allSql).toMatch(/DELETE FROM assessment_dimension_history/);
    expect(allSql).not.toMatch(/DELETE FROM assessment_evidence/);
    expect(allSql).not.toMatch(/UPDATE assessment_evidence/);
  });

  it('resetTeamAssessment is a no-op false for a team that does not exist', async () => {
    execMock.mockResolvedValueOnce([]); // teamExists -> false
    expect(await A.resetTeamAssessment('TEAM-999')).toBe(false);
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});

describe('dimension scores / evidence / history', () => {
  it('fetchDimensionScores groups score + evidence + follow-up + history rows by dimension', async () => {
    execMock
      .mockResolvedValueOnce([{ team_id: 'TEAM-001', dimension_id: '1', current_level: 3, is_na: false, confidence: 'high', self_claimed_level: 4, evidence_class: 'observed', cap_applied: false, updated_at: '2026-01-01T00:00:00Z' }])
      .mockResolvedValueOnce([{ evidence_id: 'EV-1', team_id: 'TEAM-001', dimension_id: '1', source_type: 'document', excerpt: 'a pipeline yaml', supports_level: 3, captured_at: '2026-01-01T00:00:00Z', source_ref: 'PROV-1', scored: true, status: 'SCORED' }])
      .mockResolvedValueOnce([{ question_id: 'Q-1', team_id: 'TEAM-001', dimension_id: '1', text: 'What blocks Level 4?', target_audience: 'team', status: 'OPEN' }])
      .mockResolvedValueOnce([{ team_id: 'TEAM-001', dimension_id: '1', from_level: 2, to_level: 3, is_na: false, na_claimed: false, rationale: 'CI required before merge', evidence_ids: ['EV-1'], source_meeting: 'teams/TEAM-001', changed_at: '2026-01-01T00:00:00Z', changed_by: 'orgiq-assessment-scorer' }]);

    const dims = await A.fetchDimensionScores('TEAM-001');
    expect(Object.keys(dims)).toEqual(['1']);
    expect(dims['1']).toEqual({
      dimension_id: '1', current_level: 3, is_na: false, confidence: 'high', self_claimed_level: 4,
      evidence_class: 'observed', cap_applied: false, updated_at: '2026-01-01T00:00:00Z',
      evidence: [{ evidence_id: 'EV-1', dimension_id: '1', source_type: 'document', excerpt: 'a pipeline yaml', supports_level: 3, captured_at: '2026-01-01T00:00:00Z', source_ref: 'PROV-1', scored: true, status: 'SCORED' }],
      follow_up_questions: [{ question_id: 'Q-1', dimension_id: '1', text: 'What blocks Level 4?', target_audience: 'team', status: 'OPEN' }],
      history: [{ from_level: 2, to_level: 3, is_na: false, na_claimed: false, rationale: 'CI required before merge', evidence_ids: ['EV-1'], source_meeting: 'teams/TEAM-001', changed_at: '2026-01-01T00:00:00Z', changed_by: 'orgiq-assessment-scorer' }],
    });
  });

  it('excludes unscored (intake-log) evidence and evidence with no dimension_id from a dimension score', async () => {
    execMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) // the SQL itself filters scored=TRUE AND dimension_id IS NOT NULL — assert that here
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await A.fetchDimensionScores('TEAM-001');
    expect(sqlOf(1)).toMatch(/scored = TRUE AND dimension_id IS NOT NULL/);
  });

  it('upsertDimensionScore parameterizes every column and upserts on the composite key', async () => {
    execMock.mockResolvedValueOnce([]);
    await A.upsertDimensionScore('TEAM-001', {
      dimension_id: '1', current_level: 3, is_na: false, confidence: 'high', self_claimed_level: null,
      evidence_class: null, cap_applied: false, evidence: [], follow_up_questions: [], history: [], updated_at: '2026-01-01T00:00:00Z',
    });
    expect(sqlOf()).toMatch(/ON CONFLICT \(team_id, dimension_id\) DO UPDATE/);
    expect(paramsOf()).toContainEqual({ name: 'level', value: { longValue: 3 } });
    expect(paramsOf()).toContainEqual({ name: 'self', value: { isNull: true } });
  });

  it('insertHistoryRow passes evidence_ids as a real array parameter, not a joined string', async () => {
    execMock.mockResolvedValueOnce([]);
    await A.insertHistoryRow('TEAM-001', '1', {
      from_level: null, to_level: 2, is_na: false, na_claimed: false, rationale: 'seed',
      evidence_ids: ['EV-1', 'EV-2'], source_meeting: 'teams/TEAM-001', changed_at: '2026-01-01T00:00:00Z', changed_by: 'agent',
    });
    expect(paramsOf()).toContainEqual({ name: 'evidence_ids', value: { arrayValue: { stringValues: ['EV-1', 'EV-2'] } } });
  });

  it('requestExceptionRow overwrites a prior denied row on re-request (composite PK, one row per dimension)', async () => {
    execMock.mockResolvedValueOnce([]);
    await A.requestExceptionRow('TEAM-001', '7', 'no prod service, still pending');
    expect(sqlOf()).toMatch(/ON CONFLICT \(team_id, dimension_id\) DO UPDATE SET\s+status = 'requested'/);
  });
});

describe('applyScores orchestration', () => {
  const emptyScore = (id: string) => ({
    dimension_id: id, current_level: null, is_na: false, confidence: 'low' as const, self_claimed_level: null,
    evidence_class: null, cap_applied: false, evidence: [], follow_up_questions: [], history: [], updated_at: '2026-01-01T00:00:00Z',
  });

  it('returns null when the team does not exist, without calling computeEntry', async () => {
    execMock.mockResolvedValueOnce([]); // fetchTeam -> []
    const computeEntry = jest.fn();
    const result = await A.auroraApplyScores('TEAM-999', { relevant_dimension_ids: [], scores: [] }, computeEntry);
    expect(result).toBeNull();
    expect(computeEntry).not.toHaveBeenCalled();
  });

  it('persists an accepted entry (score upsert + history) and skips writes for a rejected one', async () => {
    execMock
      .mockResolvedValueOnce([{ id: 'TEAM-001', name: 'T', cohort: 'general', status: 'ACTIVE', workflow_step: 1, assessment_lead: '', contacts: [], repos: '[]', contributors: '[]', archetype: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }])
      .mockResolvedValueOnce([]) // exceptions for fetchTeam
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]) // fetchDimensionScores (4 queries)
      .mockResolvedValue([]); // every write statement

    const computeEntry = jest.fn()
      .mockReturnValueOnce({ ok: false, reason: 'bad dimension' })
      .mockReturnValueOnce({
        ok: true,
        result: {
          newScore: { ...emptyScore('2'), current_level: 3 },
          historyEntry: { from_level: null, to_level: 3, is_na: false, na_claimed: false, rationale: 'x', evidence_ids: [], source_meeting: 'm', changed_at: '2026-01-01T00:00:00Z', changed_by: 'agent' },
          newEvidence: [], newFollowups: [],
          applied: { dimension_id: '2', current_level: 3, cap_applied: false },
          exceptionToRequest: null,
        },
      });

    const result = await A.auroraApplyScores(
      'TEAM-001',
      { relevant_dimension_ids: ['1', '2'], scores: [{ dimension_id: '1', suggested_level: 1, confidence: 'low', rationale: '' }, { dimension_id: '2', suggested_level: 3, confidence: 'high', rationale: 'x' }] },
      computeEntry as unknown as A.ComputeScoreEntryFn,
    );

    expect(result!.rejected).toEqual([{ dimension_id: '1', reason: 'bad dimension' }]);
    expect(result!.applied).toEqual([{ dimension_id: '2', current_level: 3, cap_applied: false }]);
    const writeSql = execMock.mock.calls.slice(6).map((c) => c[0] as string).join('\n');
    expect(writeSql).toMatch(/INSERT INTO assessment_dimension_scores/);
    expect(writeSql).toMatch(/INSERT INTO assessment_dimension_history/);
    // One dimension scored out of 17 -> IN_PROGRESS (M.deriveTeamStatus),
    // written alongside updated_at rather than a bare touch.
    expect(writeSql).toMatch(/UPDATE assessment_teams SET status = :status, updated_at/);
    const statusCall = execMock.mock.calls.find((c) =>
      /UPDATE assessment_teams SET status/.test(c[0] as string));
    expect(statusCall![1]).toContainEqual({ name: 'status', value: { stringValue: 'IN_PROGRESS' } });
  });
});

describe('runs', () => {
  const RUN_ROW = {
    id: 'run-20260101T000000Z-score-dimensions-abc123', command: 'score-dimensions', team_id: 'TEAM-001',
    args: '{"foo":"bar"}', status: 'running' as const, source: 'agent', started_at: '2026-01-01T00:00:00Z',
    finished_at: null, summary: '', error: null, files_written: [] as string[],
  };

  it('fetchRun maps a row back to MockRun, parsing the jsonb args column', async () => {
    execMock.mockResolvedValueOnce([RUN_ROW]);
    const run = await A.fetchRun(RUN_ROW.id);
    expect(run).toEqual({
      id: RUN_ROW.id, command: 'score-dimensions', team_id: 'TEAM-001', args: { foo: 'bar' },
      status: 'running', source: 'agent', started_at: '2026-01-01T00:00:00Z', finished_at: null,
      summary: '', error: null, files_written: [],
    });
  });

  it('countRunningDuplicates scopes to team_id IS NULL when teamId is null, not a string comparison', async () => {
    execMock.mockResolvedValueOnce([{ cnt: 0 }]);
    await A.countRunningDuplicates('score-dimensions', null);
    expect(sqlOf()).toMatch(/team_id IS NULL/);
    expect(paramsOf()).not.toContainEqual(expect.objectContaining({ name: 'team' }));
  });

  it('insertRun parameterizes args as jsonb and files_written as a real array', async () => {
    execMock.mockResolvedValueOnce([]);
    await A.insertRun({ ...RUN_ROW, args: { foo: 'bar' }, files_written: ['a.json', 'b.json'] });
    expect(paramsOf()).toContainEqual({ name: 'args', value: { stringValue: '{"foo":"bar"}' } });
    expect(paramsOf()).toContainEqual({ name: 'files', value: { arrayValue: { stringValues: ['a.json', 'b.json'] } } });
    expect(sqlOf()).not.toContain('score-dimensions'); // command text itself must not be inlined
  });

  it('updateRunStatus never overwrites summary when none is given (COALESCE)', async () => {
    execMock.mockResolvedValueOnce([]);
    await A.updateRunStatus(RUN_ROW.id, { status: 'failed', finished_at: '2026-01-01T00:05:00Z', error: 'stopped by operator' });
    expect(sqlOf()).toMatch(/summary = COALESCE\(:summary, summary\)/);
    expect(paramsOf()).toContainEqual({ name: 'summary', value: { isNull: true } });
  });
});

describe('feedback tasks', () => {
  it('fetchFeedbackTasks only adds WHERE clauses for filters that were actually given', async () => {
    execMock.mockResolvedValueOnce([]);
    await A.fetchFeedbackTasks({ team: 'TEAM-001' });
    expect(sqlOf()).toMatch(/WHERE team_id = :team/);
    expect(sqlOf()).not.toMatch(/status = :status/);
    expect(sqlOf()).not.toMatch(/kind = :kind/);
  });

  it('rowToFeedbackTask maps nullable columns to null, not undefined', async () => {
    execMock.mockResolvedValueOnce([{
      task_id: 'fb-1', team_id: null, kind: 'general', status: 'OPEN', dimension_id: null,
      question: 'q', response: null, created_at: '2026-01-01T00:00:00Z', resolved_at: null,
    }]);
    const task = await A.fetchFeedbackTask('fb-1');
    expect(task).toEqual({
      task_id: 'fb-1', team_id: null, kind: 'general', status: 'OPEN', dimension_id: null,
      question: 'q', created_at: '2026-01-01T00:00:00Z', resolved_at: null, response: null,
    });
  });

  it('findFollowUpQuestion / setFollowUpStatus parameterize the question id', async () => {
    execMock.mockResolvedValueOnce([{ question_id: 'Q-1', team_id: 'TEAM-001', dimension_id: '1', text: 't', created_at: '2026-01-01T00:00:00Z' }]);
    await A.findFollowUpQuestion('Q-1');
    expect(paramsOf()).toContainEqual({ name: 'qid', value: { stringValue: 'Q-1' } });

    execMock.mockResolvedValueOnce([{ question_id: 'Q-1' }]);
    const ok = await A.setFollowUpStatus('Q-1', 'ANSWERED');
    expect(ok).toBe(true);
    expect(sqlOf(1)).toMatch(/SET status = :status/);
  });
});

describe('configuration', () => {
  it('fetchConfiguration falls back to a sane default when the row has never been written', async () => {
    execMock.mockResolvedValueOnce([]);
    const cfg = await A.fetchConfiguration();
    expect(cfg.target_level).toBe(3);
    expect(cfg.motions).toEqual([]);
  });

  it('upsertConfiguration merges a partial patch onto the current row rather than clobbering the other field', async () => {
    execMock
      .mockResolvedValueOnce([{ target_level: 3, motions: '[]', updated_at: '2026-01-01T00:00:00Z' }]) // fetchConfiguration (current)
      .mockResolvedValueOnce([]) // upsert
      .mockResolvedValueOnce([{ target_level: 4, motions: '[]', updated_at: '2026-01-02T00:00:00Z' }]); // fetchConfiguration (after)
    const cfg = await A.upsertConfiguration({ target_level: 4 });
    expect(paramsOf(1)).toContainEqual({ name: 'target', value: { longValue: 4 } });
    expect(cfg.target_level).toBe(4);
  });
});

// Attribution: the route hands launchRun the session sub, and the Aurora
// insert carries it as launched_by — a run is never anonymous on the real
// store, and never attributed from the request body.
describe('run attribution', () => {
  it('insertRun writes launched_by from the caller, NULL when unknown', async () => {
    execMock.mockResolvedValue({ records: [] });
    const rec = {
      id: 'run-x', command: 'score-dimensions', team_id: 'TEAM-001', args: {}, status: 'running' as const,
      source: 'agent', started_at: '2026-09-05T00:00:00Z', finished_at: null, summary: '', error: null, files_written: [],
    };
    await A.insertRun(rec, 'u-asha');
    // Data API params carry typed values: {stringValue} when known, {isNull} when not.
    expect(paramsOf(0).find((p) => p.name === 'launched_by')?.value).toEqual({ stringValue: 'u-asha' });
    execMock.mockReset(); execMock.mockResolvedValue({ records: [] });
    await A.insertRun(rec);
    expect(paramsOf(0).find((p) => p.name === 'launched_by')?.value).toEqual({ isNull: true });
  });
});

// ─── Added: stories / submissions / knowledge Aurora paths ─────────────────
// (getTeamRecommendations, listPortfolioRecommendations, listStories,
// getStory, submissions, and knowledge were `notMocked` before this pass —
// see providers/assessment-aurora.ts's stories/submissions/knowledge
// sections). Same conventions as the tests above: exec is stubbed, and every
// assertion is either "caller input never lands in the SQL text" or
// "row shape maps back to the exact mock-compatible object".

describe('stories', () => {
  const STORY_ROW = {
    filename: 'story-dim1-ci-evidence.md', team_id: 'TEAM-001', dimension_id: '1',
    title: "Close the open claim: verify branch-protection", markdown: '## Close the claim\n',
    status: 'ready', jira_key: null, created_at: '2026-01-01T00:00:00Z',
  };

  it('fetchStory parameterizes team + filename and maps a row to a StoryDraft', async () => {
    execMock.mockResolvedValueOnce([STORY_ROW]);
    const story = await A.fetchStory('TEAM-001', 'story-dim1-ci-evidence.md');
    expect(sqlOf()).toMatch(/WHERE team_id = :tid AND filename = :fn/);
    expect(sqlOf()).not.toContain('TEAM-001');
    expect(paramsOf()).toContainEqual({ name: 'tid', value: { stringValue: 'TEAM-001' } });
    expect(paramsOf()).toContainEqual({ name: 'fn', value: { stringValue: 'story-dim1-ci-evidence.md' } });
    expect(story).toEqual({
      filename: 'story-dim1-ci-evidence.md', team_id: 'TEAM-001', dimension_id: '1',
      title: "Close the open claim: verify branch-protection", markdown: '## Close the claim\n',
      status: 'ready', jira_key: null, created_at: '2026-01-01T00:00:00Z',
    });
  });

  it('fetchStory returns null when no row matches', async () => {
    execMock.mockResolvedValueOnce([]);
    expect(await A.fetchStory('TEAM-001', 'missing.md')).toBeNull();
  });

  it('fetchAllStories groups rows by team_id for the portfolio-recommendations bulk read', async () => {
    execMock.mockResolvedValueOnce([
      STORY_ROW,
      { ...STORY_ROW, filename: 'story-dim2.md', team_id: 'TEAM-002', dimension_id: '2' },
    ]);
    const byTeam = await A.fetchAllStories();
    expect([...byTeam.keys()]).toEqual(['TEAM-001', 'TEAM-002']);
    expect(byTeam.get('TEAM-001')).toHaveLength(1);
    expect(byTeam.get('TEAM-002')![0]!.dimension_id).toBe('2');
  });
});

describe('submissions', () => {
  const ENVELOPE: Record<string, unknown> = {
    schema_version: '1.0',
    envelope_id: 'sub-20260810T091500Z-form5-jordan-lee',
    source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: 'assessment-2026-08.csv', origin_row: 5, form_submission_id: '5' },
    team_id: 'TEAM-002',
    team_name_raw: 'Kubernetes Operator',
    submitter: { name: 'Jordan Lee', email: 'jordan.lee@example.com', is_primary_contact: true },
    submitted_at: '8/10/2026 09:15',
    ingested_at: '2026-08-10T09:20:00.000Z',
    assessment_date: '8/10/2026',
    self_certified: true,
    supersedes: null,
    dimension_hints: [],
    links: [{ url: 'https://example.com/pipeline', label: 'Evidence', dimension_id: '1', status: 'pending' }],
    status: 'committed',
    revision: 1,
  };

  it('fetchSubmission parameterizes team + envelope id and parses the envelope JSONB column as the wire shape', async () => {
    execMock.mockResolvedValueOnce([{ envelope: JSON.stringify(ENVELOPE) }]);
    const env = await A.fetchSubmission('TEAM-002', 'sub-20260810T091500Z-form5-jordan-lee');
    expect(sqlOf()).toMatch(/WHERE team_id = :tid AND envelope_id = :eid/);
    expect(sqlOf()).not.toContain('TEAM-002');
    expect(paramsOf()).toContainEqual({ name: 'tid', value: { stringValue: 'TEAM-002' } });
    expect(paramsOf()).toContainEqual({ name: 'eid', value: { stringValue: 'sub-20260810T091500Z-form5-jordan-lee' } });
    expect(env).toEqual(ENVELOPE);
  });

  it('fetchAllSubmissions lifts team_id alongside the parsed envelope for the cross-team listing', async () => {
    execMock.mockResolvedValueOnce([{ team_id: 'TEAM-002', envelope: JSON.stringify(ENVELOPE) }]);
    const rows = await A.fetchAllSubmissions();
    expect(rows).toEqual([{ ...ENVELOPE, team_id: 'TEAM-002' }]);
  });

  it('insertSubmission parameterizes every column, including the full envelope as jsonb, and never inlines caller text', async () => {
    execMock.mockResolvedValueOnce([]);
    const envelope = { ...ENVELOPE, team_name_raw: "Robert'); DROP TABLE assessment_submissions;--" } as never;
    await A.insertSubmission(envelope, '2026-08-10T09:15:00.000Z', '2026-08-10');
    expect(sqlOf()).not.toContain('DROP TABLE');
    expect(sqlOf()).toMatch(/INSERT INTO assessment_submissions/);
    expect(paramsOf()).toContainEqual({ name: 'submitted', value: { stringValue: '2026-08-10T09:15:00.000Z' } });
    expect(paramsOf()).toContainEqual({ name: 'adate', value: { stringValue: '2026-08-10' } });
    expect(paramsOf().find((p) => p.name === 'envelope')?.value).toEqual({ stringValue: JSON.stringify(envelope) });
  });

  it('markSubmissionCommitted / markSubmissionSuperseded flip both the lifted status column and the envelope JSON in place', async () => {
    execMock.mockResolvedValueOnce([{ envelope_id: 'sub-1' }]);
    const ok = await A.markSubmissionCommitted('TEAM-002', 'sub-1');
    expect(ok).toBe(true);
    expect(sqlOf()).toMatch(/jsonb_set\(envelope, '\{status\}', '"committed"'\)/);

    execMock.mockResolvedValueOnce([]);
    await A.markSubmissionSuperseded('TEAM-002', 'sub-0');
    expect(sqlOf(1)).toMatch(/jsonb_set\(envelope, '\{status\}', '"superseded"'\)/);
  });

  it('fetchCommittedFormIds keys by "team_id:form_submission_id" for committed envelopes only', async () => {
    execMock.mockResolvedValueOnce([
      { team_id: 'TEAM-002', form_id: '5' },
      { team_id: 'TEAM-003', form_id: '' }, // no form_submission_id on the envelope — excluded
    ]);
    const ids = await A.fetchCommittedFormIds();
    expect(sqlOf()).toMatch(/WHERE status = 'committed'/);
    expect(ids.has('TEAM-002:5')).toBe(true);
    expect(ids.has('TEAM-003:')).toBe(false);
    expect(ids.size).toBe(1);
  });
});

describe('knowledge', () => {
  it('fetchKnowledgeTree assembles sections with their nodes nested, in one round trip per table', async () => {
    execMock
      .mockResolvedValueOnce([{ key: 'enterprise_context', title: 'Enterprise Context', kind: 'local', provider: null }])
      .mockResolvedValueOnce([
        { id: 'ec:standards', section_key: 'enterprise_context', parent_id: null, title: 'Standards', is_dir: true, classification: null, editable: null, viewable: null, page_id: null, updated_at: null },
        { id: 'ec:standards/ci-cd-standards.md', section_key: 'enterprise_context', parent_id: 'ec:standards', title: 'CI/CD Standards', is_dir: false, classification: 'internal', editable: true, viewable: true, page_id: null, updated_at: '2026-01-01T00:00:00Z' },
      ]);
    const sections = await A.fetchKnowledgeTree();
    expect(sections).toEqual([{
      key: 'enterprise_context', title: 'Enterprise Context', kind: 'local', provider: undefined,
      nodes: [
        { id: 'ec:standards', title: 'Standards', parent_id: null, is_dir: true, classification: undefined, editable: undefined, viewable: undefined, updated_at: undefined, page_id: undefined },
        { id: 'ec:standards/ci-cd-standards.md', title: 'CI/CD Standards', parent_id: 'ec:standards', is_dir: false, classification: 'internal', editable: true, viewable: true, updated_at: '2026-01-01T00:00:00Z', page_id: undefined },
      ],
    }]);
  });

  it('fetchKnowledgeDoc maps a row to KnowledgeDoc, and fetchKnowledgeDocVersions orders newest stamp first', async () => {
    execMock.mockResolvedValueOnce([{
      id: 'rule:scoring-guardrails.md', title: 'Scoring Guardrails', classification: 'internal',
      markdown: '# Scoring Guardrails\n', editable: true, path: 'rules/scoring-guardrails.md', updated_at: '2026-08-01T00:00:00Z',
    }]);
    const doc = await A.fetchKnowledgeDoc('rule:scoring-guardrails.md');
    expect(doc).toEqual({
      id: 'rule:scoring-guardrails.md', title: 'Scoring Guardrails', classification: 'internal',
      markdown: '# Scoring Guardrails\n', editable: true, path: 'rules/scoring-guardrails.md', updated_at: '2026-08-01T00:00:00Z',
    });

    execMock.mockResolvedValueOnce([
      { stamp: '20260815T130000Z', label: null, size: 340, saved_at: '2026-08-15T13:00:00Z', markdown: 'v2' },
      { stamp: '20260801T090000Z', label: 'initial', size: 210, saved_at: '2026-08-01T09:00:00Z', markdown: 'v1' },
    ]);
    const versions = await A.fetchKnowledgeDocVersions('rule:scoring-guardrails.md');
    expect(sqlOf(1)).toMatch(/ORDER BY stamp DESC/);
    expect(versions.map((v) => v.stamp)).toEqual(['20260815T130000Z', '20260801T090000Z']);
    expect(versions[1]).toEqual({ stamp: '20260801T090000Z', label: 'initial', size: 210, saved_at: '2026-08-01T09:00:00Z', markdown: 'v1' });
  });

  it('upsertPublishedPageNode increments version on conflict and starts a new page at 1', async () => {
    execMock.mockResolvedValueOnce([{ version: 1 }]);
    const v1 = await A.upsertPublishedPageNode('confluence-eng', 'page:published:doc-1', 'Doc One', 'internal', 'published:doc-1', '2026-08-01T00:00:00Z');
    expect(v1).toBe(1);
    expect(sqlOf()).toMatch(/ON CONFLICT \(id\) DO UPDATE SET/);
    expect(sqlOf()).toMatch(/version = assessment_knowledge_nodes\.version \+ 1/);

    execMock.mockResolvedValueOnce([{ version: 2 }]);
    const v2 = await A.upsertPublishedPageNode('confluence-eng', 'page:published:doc-1', 'Doc One', 'internal', 'published:doc-1', '2026-08-02T00:00:00Z');
    expect(v2).toBe(2);
  });

  it('insertKnowledgeComment parameterizes the comment body and never inlines it into the SQL text', async () => {
    execMock.mockResolvedValueOnce([]);
    const body = "nice work'); DROP TABLE assessment_knowledge_comments;--";
    await A.insertKnowledgeComment('comment-1', 'rule:scoring-guardrails.md', body, 'lee@example.com', '2026-08-01T00:00:00Z');
    expect(sqlOf()).not.toContain('DROP TABLE');
    expect(sqlOf()).toMatch(/INSERT INTO assessment_knowledge_comments/);
    expect(paramsOf()).toContainEqual({ name: 'body', value: { stringValue: body } });
  });
});
