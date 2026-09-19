jest.mock('../aurora.js', () => ({ exec: jest.fn(), withTransaction: jest.fn() }));
import { exec, withTransaction } from '../aurora.js';
import { reserveRun, claimAssessmentRun, expireAssessmentClaims } from '../assessment-aurora.js';
import type * as M from '../../mock/assessment.js';
const query = jest.fn();
const run: M.MockRun = { id: 'r1', command: 'score-dimensions', team_id: null, args: {}, status: 'running', source: 'agent',
  started_at: '2026-09-19T10:00:00Z', finished_at: null, summary: '', error: null, files_written: [] };
const dispatch = { agentId: 'orgiq-assessment-scorer', payload: { evidence: [] } };
beforeEach(() => {
  jest.clearAllMocks();
  (withTransaction as jest.Mock).mockImplementation(async fn => fn(query));
});
it('locks global admission before duplicate/cap checks and inserts payload in the same transaction', async () => {
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 2, duplicate: 0 }]).mockResolvedValue([]);
  expect(await reserveRun(run, 'u-asha', dispatch, 3)).toBe('reserved');
  expect(query.mock.calls[0][0]).toMatch(/LOCK TABLE assessment_runs IN SHARE ROW EXCLUSIVE MODE/);
  expect(query.mock.calls[1][0]).toMatch(/IS NOT DISTINCT FROM :team/);
  expect(query.mock.calls[2][0]).toMatch(/INSERT INTO assessment_runs/);
  expect(query.mock.calls[3][0]).toMatch(/dispatch_payload/);
  expect(exec).not.toHaveBeenCalled();
});
it.each([[1, 1, 'duplicate'], [3, 0, 'capacity']])('rejects admission without inserting (%s,%s)', async (total, duplicate, expected) => {
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ total, duplicate }]);
  expect(await reserveRun(run, null, dispatch, 3)).toBe(expected);
  expect(query).toHaveBeenCalledTimes(2);
});
it('claims only unclaimed running records with database row exclusion', async () => {
  (exec as jest.Mock).mockResolvedValue([]);
  expect(await claimAssessmentRun()).toBeNull();
  expect((exec as jest.Mock).mock.calls[0][0]).toMatch(/dispatch_claimed_at IS NULL/);
  expect((exec as jest.Mock).mock.calls[0][0]).toMatch(/FOR UPDATE SKIP LOCKED/);
});
it('expires interrupted claims as failed rather than replaying their side effects', async () => {
  (exec as jest.Mock).mockResolvedValue([]);
  await expireAssessmentClaims();
  expect((exec as jest.Mock).mock.calls[0][0]).toMatch(/status = 'failed'/);
  expect((exec as jest.Mock).mock.calls[0][0]).toMatch(/20 minutes/);
});
