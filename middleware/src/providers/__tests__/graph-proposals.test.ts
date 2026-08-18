// Graph write-back tests. The critical properties: nothing applies without an
// approval, the applier only speaks in its four declarative mutations, writes
// are idempotent, and a failed apply is recorded rather than swallowed.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import { proposeGraphChange, decideProposal, listProposals } from '../graph-proposals.js';

const execMock = exec as unknown as jest.Mock;

const PENDING = {
  id: 'prop-1', source: 'sweep:bus_factor', job_id: null, finding_id: 'find-1',
  kind: 'add_person_skill', target_type: 'person', target_id: 'p-001',
  payload: '{"personId":"p-001","skillId":"s-mlops","weight":0.6}',
  rationale: 'Authored 3 MLOps ADRs', evidence: '{"docs":["doc-1"]}', confidence: 0.8,
  status: 'pending', reviewer: null, review_note: null, apply_error: null,
  created_at: '2026-08-18T00:00:00Z', decided_at: null, applied_at: null,
};

beforeEach(() => execMock.mockReset());

describe('proposing', () => {
  it('stores payload and evidence as jsonb', async () => {
    execMock.mockResolvedValue([PENDING]);
    const p = await proposeGraphChange({
      source: 'sweep:bus_factor', kind: 'add_person_skill', targetType: 'person',
      targetId: 'p-001', payload: { personId: 'p-001', skillId: 's-mlops' }, confidence: 0.8,
    });
    expect(execMock.mock.calls[0][0]).toMatch(/:payload::jsonb/);
    expect(p?.status).toBe('pending');
    expect(p?.payload).toEqual({ personId: 'p-001', skillId: 's-mlops', weight: 0.6 });
  });
});

describe('approval gate', () => {
  it('rejecting decides the row and never touches the graph', async () => {
    execMock.mockResolvedValue([{ ...PENDING, status: 'rejected' }]);
    const p = await decideProposal('prop-1', 'reject', { reviewer: 'connor' });
    expect(execMock).toHaveBeenCalledTimes(1);           // no apply query
    expect(p?.status).toBe('rejected');
  });

  it('only pending proposals can be decided', async () => {
    execMock.mockResolvedValue([]);
    const p = await decideProposal('prop-1', 'approve');
    expect(execMock.mock.calls[0][0]).toMatch(/status = 'pending'/);
    expect(p).toBeNull();
  });

  it('approving applies the mutation idempotently, then marks applied', async () => {
    execMock
      .mockResolvedValueOnce([{ ...PENDING, status: 'approved' }])   // decide
      .mockResolvedValueOnce([])                                     // apply
      .mockResolvedValueOnce([{ ...PENDING, status: 'applied' }]);   // mark applied
    const p = await decideProposal('prop-1', 'approve', { reviewer: 'connor' });
    const applySql = execMock.mock.calls[1][0] as string;
    expect(applySql).toMatch(/INSERT INTO person_skills/);
    expect(applySql).toMatch(/ON CONFLICT \(person_id, skill_id\) DO UPDATE/);
    expect(p?.status).toBe('applied');
  });

  it('records apply failures on the row instead of throwing them away', async () => {
    execMock
      .mockResolvedValueOnce([{ ...PENDING, status: 'approved', payload: '{}' }])  // decide, bad payload
      .mockResolvedValueOnce([{ ...PENDING, status: 'failed' }]);                  // mark failed
    const p = await decideProposal('prop-1', 'approve');
    const failSql = execMock.mock.calls[1][0] as string;
    expect(failSql).toMatch(/SET status='failed', apply_error=:err/);
    expect(p?.status).toBe('failed');
  });

  it('canonicalises collaboration pairs so (a,b) and (b,a) are one edge', async () => {
    const collab = {
      ...PENDING, kind: 'add_collaboration', target_type: 'person',
      payload: '{"personAId":"p-900","personBId":"p-100"}',
    };
    execMock
      .mockResolvedValueOnce([{ ...collab, status: 'approved' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...collab, status: 'applied' }]);
    await decideProposal('prop-1', 'approve');
    const params = execMock.mock.calls[1][1] as Array<{ name: string; value: { stringValue?: string } }>;
    expect(params.find((p) => p.name === 'a')?.value.stringValue).toBe('p-100');  // lower id first
    expect(params.find((p) => p.name === 'b')?.value.stringValue).toBe('p-900');
  });

  it('refuses a self-collaboration', async () => {
    const selfEdge = { ...PENDING, kind: 'add_collaboration', payload: '{"personAId":"p-1","personBId":"p-1"}' };
    execMock
      .mockResolvedValueOnce([{ ...selfEdge, status: 'approved' }])
      .mockResolvedValueOnce([{ ...selfEdge, status: 'failed' }]);
    const p = await decideProposal('prop-1', 'approve');
    expect(p?.status).toBe('failed');
  });
});

describe('listing', () => {
  it('filters by status', async () => {
    execMock.mockResolvedValue([PENDING]);
    await listProposals({ status: 'pending' });
    expect(execMock.mock.calls[0][0]).toMatch(/WHERE status = :status/);
  });
});
