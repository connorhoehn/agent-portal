// REVIEW-2026-09-05 findings 4/8 (commitSubmissions' non-atomic supersede+
// insert) and 10 (fetchScoringLogs/fetchScoringLog dropping run_id).
//
// `withTransaction` is mocked here to just invoke `fn(exec)` directly (no
// real begin/commit/rollback) — that primitive has its own dedicated test
// in aurora-transaction.test.ts. What THIS file verifies is the
// orchestration: commitSubmissionEnvelope wraps supersede+insert in ONE
// call to withTransaction (not two independent exec() calls), the insert is
// conflict-safe (ON CONFLICT DO NOTHING + RETURNING, so a lost race returns
// false instead of throwing an uncaught unique-violation), and
// insertScoringLog/fetchScoringLog(s) round-trip run_id.

jest.mock('../aurora.js', () => {
  const exec = jest.fn();
  const withTransaction = jest.fn(async (fn: (tx: typeof exec) => Promise<unknown>) => fn(exec));
  return { exec, withTransaction };
});

import { exec, withTransaction } from '../aurora.js';
import * as A from '../assessment-aurora.js';
import type * as M from '../../mock/assessment.js';

const execMock = exec as unknown as jest.Mock;
const withTransactionMock = withTransaction as unknown as jest.Mock;

beforeEach(() => {
  execMock.mockReset();
  withTransactionMock.mockClear();
});

const ENVELOPE = {
  schema_version: '1.0',
  envelope_id: 'sub-20260810T091500Z-form5-jordan-lee-r2',
  source: { kind: 'ms_forms_export', system: 'microsoft_forms', origin_file: 'x.csv', origin_row: 5, form_submission_id: '5' },
  team_id: 'TEAM-002',
  team_name_raw: 'Kubernetes Operator',
  submitter: { name: 'Jordan Lee', email: 'jordan.lee@example.com', is_primary_contact: true },
  submitted_at: '8/10/2026 09:15',
  ingested_at: '2026-08-10T09:20:00.000Z',
  assessment_date: '8/10/2026',
  self_certified: true,
  supersedes: 'sub-20260810T091500Z-form5-jordan-lee',
  dimension_hints: [],
  links: [],
  status: 'committed',
  revision: 2,
} as unknown as M.SubmissionEnvelope;

describe('commitSubmissionEnvelope — atomic supersede + conflict-safe insert (findings 4/8)', () => {
  it('wraps the supersede and the insert in ONE withTransaction call, in order', async () => {
    execMock
      .mockResolvedValueOnce([]) // markSubmissionSuperseded
      .mockResolvedValueOnce([{ envelope_id: ENVELOPE.envelope_id }]); // insertSubmission RETURNING

    const ok = await A.commitSubmissionEnvelope(ENVELOPE, '2026-08-10T09:15:00.000Z', '2026-08-10', 'sub-20260810T091500Z-form5-jordan-lee');

    expect(ok).toBe(true);
    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0]![0] as string).toMatch(/UPDATE assessment_submissions[\s\S]*status = 'superseded'/);
    expect(execMock.mock.calls[1]![0] as string).toMatch(/INSERT INTO assessment_submissions/);
    expect(execMock.mock.calls[1]![0] as string).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it('skips the supersede call entirely when there is no prior envelope', async () => {
    execMock.mockResolvedValueOnce([{ envelope_id: ENVELOPE.envelope_id }]);
    await A.commitSubmissionEnvelope(ENVELOPE, '2026-08-10T09:15:00.000Z', '2026-08-10', null);
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]![0] as string).toMatch(/INSERT INTO assessment_submissions/);
  });

  it('returns false — not a thrown error — when a concurrent commit already won the envelope_id race', async () => {
    execMock
      .mockResolvedValueOnce([]) // markSubmissionSuperseded
      .mockResolvedValueOnce([]); // insertSubmission RETURNING — empty means ON CONFLICT DO NOTHING fired

    const ok = await A.commitSubmissionEnvelope(ENVELOPE, '2026-08-10T09:15:00.000Z', '2026-08-10', 'sub-20260810T091500Z-form5-jordan-lee');
    expect(ok).toBe(false);
  });

  it('insertSubmission alone: false on conflict (empty RETURNING), true on a real insert', async () => {
    execMock.mockResolvedValueOnce([]);
    expect(await A.insertSubmission(ENVELOPE, '2026-08-10T09:15:00.000Z', '2026-08-10')).toBe(false);

    execMock.mockResolvedValueOnce([{ envelope_id: ENVELOPE.envelope_id }]);
    expect(await A.insertSubmission(ENVELOPE, '2026-08-10T09:15:00.000Z', '2026-08-10')).toBe(true);
  });

  it('insertSubmission parameterizes form_submission_id from envelope.source (backs the new partial unique index)', async () => {
    execMock.mockResolvedValueOnce([{ envelope_id: ENVELOPE.envelope_id }]);
    await A.insertSubmission(ENVELOPE, '2026-08-10T09:15:00.000Z', '2026-08-10');
    const params = execMock.mock.calls[0]![1] as Array<{ name: string; value: unknown }>;
    expect(params).toContainEqual({ name: 'formid', value: { stringValue: '5' } });
  });
});

describe('scoring logs carry run_id end to end (finding 10)', () => {
  it('insertScoringLog parameterizes run_id', async () => {
    execMock.mockResolvedValueOnce([]);
    await A.insertScoringLog({
      team_id: 'TEAM-002', envelope_id: null, stamp: '20260905T000000Z', source: 'agent',
      scores: [], run_id: 'run-abc123',
    });
    const params = execMock.mock.calls[0]![1] as Array<{ name: string; value: unknown }>;
    expect(execMock.mock.calls[0]![0] as string).toMatch(/INSERT INTO assessment_scoring_logs/);
    expect(params).toContainEqual({ name: 'run_id', value: { stringValue: 'run-abc123' } });
  });

  it('fetchScoringLogs selects run_id and maps it back onto the ScoringLog', async () => {
    execMock.mockResolvedValueOnce([{
      team_id: 'TEAM-002', stamp: '20260905T000000Z', envelope_id: null, source: 'agent',
      run_id: 'run-abc123', scores: '[]',
    }]);
    const logs = await A.fetchScoringLogs('TEAM-002');
    expect(execMock.mock.calls[0]![0] as string).toMatch(/SELECT.*run_id.*FROM assessment_scoring_logs/s);
    expect(logs[0]!.run_id).toBe('run-abc123');
  });

  it('fetchScoringLog (singular) also selects and maps run_id', async () => {
    execMock.mockResolvedValueOnce([{
      team_id: 'TEAM-002', stamp: '20260905T000000Z', envelope_id: null, source: 'agent',
      run_id: 'run-xyz789', scores: '[]',
    }]);
    const log = await A.fetchScoringLog('TEAM-002', '20260905T000000Z');
    expect(execMock.mock.calls[0]![0] as string).toMatch(/SELECT.*run_id.*FROM assessment_scoring_logs/s);
    expect(log!.run_id).toBe('run-xyz789');
  });

  it('a null run_id (seeded/manual log) maps to undefined, not the string "null"', async () => {
    execMock.mockResolvedValueOnce([{
      team_id: 'TEAM-002', stamp: '20260905T000000Z', envelope_id: null, source: 'manual',
      run_id: null, scores: '[]',
    }]);
    const logs = await A.fetchScoringLogs('TEAM-002');
    expect(logs[0]!.run_id).toBeUndefined();
  });
});

it('throws the lost insert conflict through the transaction so supersede is rolled back', async () => {
  execMock.mockResolvedValue([]);
  let rolledBack = false;
  withTransactionMock.mockImplementationOnce(async (fn: (tx: typeof exec) => Promise<unknown>) => {
    try { return await fn(exec); } catch (error) { rolledBack = true; throw error; }
  });
  expect(await A.commitSubmissionEnvelope(ENVELOPE, '2026-08-10T09:15:00.000Z', null, 'prior')).toBe(false);
  expect(rolledBack).toBe(true);
});
