jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
import * as M from '../../mock/assessment.js';
import { parseSubmission } from '../assessment.js';

it('a later manual score or another envelope run cannot mark this envelope processed', () => {
  const env = { envelope_id: 'wanted', status: 'committed' as const, dimension_hints: [{ dimension_id: '1' } as M.DimensionHint], ingested_at: '2026-09-01T00:00:00Z' };
  const dims = { '1': { ...M.blankDimensions()['1']!, history: [{ source_meeting: 'run-other', changed_at: '2026-09-02T00:00:00Z' } as M.DimensionHistoryEntry] } };
  const log = { team_id: 't', envelope_id: 'other', run_id: 'run-other', source: 'agent', scores: [], stamp: 'test' };
  expect(M.isSubmissionProcessed(env, dims, [log])).toBe(false);
  expect(M.isSubmissionProcessed(env, dims)).toBe(false);
  expect(M.isSubmissionProcessed(env, dims, [{ ...log, envelope_id: 'wanted' }])).toBe(true);
  dims['1'].history[0]!.source_meeting = 'manual-review';
  expect(M.isSubmissionProcessed(env, dims, [{ ...log, envelope_id: 'wanted' }])).toBe(false);
});
it('unresolved team rows expose committed team matches for safe manual assignment', async () => {
  const result = await parseSubmission({ source_file: 'repeat.csv', records: [{ Id: '9', 'What is your team name?': 'An unmapped legacy name', 'Completion time': '8/19/2026 13:45', Name: 'Dana', Email: 'dana@example.com' }] });
  expect(result.rows[0]).toMatchObject({ status: 'unknown_team', team_id: null, seen_team_ids: ['TEAM-005'] });
});
