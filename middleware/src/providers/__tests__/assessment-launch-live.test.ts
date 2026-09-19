jest.mock('../../config.js', () => ({ config: { mock: { aurora: false, agentcore: false }, auth: {} } }));
jest.mock('../assessment-aurora.js', () => ({ fetchSubmissionsForTeam: jest.fn(), fetchTeam: jest.fn(), fetchEvidenceLog: jest.fn(), reserveRun: jest.fn() }));
jest.mock('../../lib/assessment-broker.js', () => ({ assessmentBroker: { publish: jest.fn() } }));
import * as A from '../assessment-aurora.js';
import { launchRun } from '../assessment.js';
import { assessmentBroker } from '../../lib/assessment-broker.js';
beforeEach(() => {
  jest.clearAllMocks();
  (A.fetchSubmissionsForTeam as jest.Mock).mockResolvedValue([{ envelope_id: 's1', team_id: 'TEAM-001', status: 'committed', dimension_hints: [{ dimension_id: '10' }] }]);
  (A.fetchTeam as jest.Mock).mockResolvedValue({ id: 'TEAM-001', rubric_version: 'v1' });
  (A.fetchEvidenceLog as jest.Mock).mockResolvedValue([]);
  (A.reserveRun as jest.Mock).mockResolvedValue('reserved');
});
it('persists exact source and trusted identity atomically before announcing a running record', async () => {
  const result = await launchRun('process-self-assessment', { submission: 's1', auth: { tenant: 'evil' } }, 'TEAM-001', 'u-asha');
  expect(result.ok).toBe(true);
  expect(A.reserveRun).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ submission: 's1' }) }), 'u-asha',
    expect.objectContaining({ agentId: 'orgiq-assessment-scorer', payload: expect.objectContaining({ auth: { tenant: 'assessment', sub: 'u-asha' }, evidence: [expect.objectContaining({ id: 's1' })] }) }), 3);
  expect(assessmentBroker.publish).toHaveBeenCalledTimes(1);
});
it('rejects a foreign or nonexistent submission without reserving a slot', async () => {
  const result = await launchRun('process-self-assessment', { submission: 'other-team' }, 'TEAM-001', 'u-asha');
  expect(result).toMatchObject({ ok: false, status: 400 });
  expect(A.reserveRun).not.toHaveBeenCalled();
});
it.each([['duplicate', 409], ['capacity', 429]])('maps atomic admission %s without publishing a false started event', async (admission, status) => {
  (A.reserveRun as jest.Mock).mockResolvedValue(admission);
  expect(await launchRun('process-self-assessment', { submission: 's1' }, 'TEAM-001')).toMatchObject({ ok: false, status });
  expect(assessmentBroker.publish).not.toHaveBeenCalled();
});
