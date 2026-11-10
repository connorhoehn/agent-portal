// listDecisions against Aurora: the list's decider fields come from the same
// rule as the mock branch (lib/decision-authority.ts waitingOn) and the same
// columns the record reads (`decided_by` joined to people; the first decider
// participant by weight, then name). What the SQL returns is mocked here; the
// mock branch's rows are pinned in graph-decisions-mock.test.ts and the two
// branches meet in mock/core/parity (entities `decided_by`, invariants).

jest.mock('../aurora.js', () => ({ exec: jest.fn(), fetchAvatarsById: jest.fn(), withTransaction: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false, agentcore: true } },
}));
const mockGetProject = jest.fn();
jest.mock('../projects.js', () => ({ getProject: (id: string) => mockGetProject(id) }));
jest.mock('../identity.js', () => ({ getUser: jest.fn(async () => null) }));

import { exec } from '../aurora.js';
import { listDecisions } from '../decisions.js';

const execMock = exec as unknown as jest.Mock;
const row = (over: Record<string, unknown>) => ({
  id: 'd-x', topic: 't', summary: null, status: 'open', project_id: null, decided_at: null, resolution: null,
  decided_by: null, decided_by_name: null, decider_id: null, decider_name: null, participant_count: 2, ...over,
});

beforeEach(() => { execMock.mockReset(); mockGetProject.mockReset(); });

it('reads decided_by and the first decider participant in the one list query', async () => {
  execMock.mockResolvedValueOnce([]);
  await listDecisions();
  const sql = String(execMock.mock.calls[0]![0]);
  expect(sql).toMatch(/LEFT JOIN people pdb ON pdb\.id = d\.decided_by/);
  expect(sql).toMatch(/lower\(dd\.role\) = 'decider'[\s\S]*ORDER BY dd\.weight DESC NULLS LAST, pp\.name[\s\S]*LIMIT 1/);
});

it('names who decided a settled row, and who each waiting row waits on', async () => {
  execMock.mockResolvedValueOnce([
    row({ id: 'd-done', status: 'resolved', decided_at: '2026-01-01', decided_by: 'p-4', decided_by_name: 'Kai Ito', decider_id: 'p-4', decider_name: 'Kai Ito' }),
    row({ id: 'd-dec', status: 'escalated', project_id: 'p-auth', decider_id: 'p-5', decider_name: 'Sienna Garcia' }),
    row({ id: 'd-own', status: 'open', project_id: 'p-auth' }),
    row({ id: 'd-org', status: 'open' }),
  ]);
  mockGetProject.mockResolvedValue({ ownerId: 'p-1', ownerName: 'Nina Park' });
  const out = Object.fromEntries((await listDecisions()).map((d) => [d.id, [d.decidedBy, d.deciderRole, d.decider]]));
  expect(out).toEqual({
    'd-done': [{ id: 'p-4', name: 'Kai Ito' }, null, null],
    'd-dec': [null, 'decider', { id: 'p-5', name: 'Sienna Garcia' }],
    'd-own': [null, 'initiative-owner', { id: 'p-1', name: 'Nina Park' }],
    'd-org': [null, 'org-leader', null],
  });
  // The owner is looked up once, and only for the waiting row with no decider.
  expect(mockGetProject).toHaveBeenCalledTimes(1);
});

it('a failed owner lookup waits on the org-leader rather than on a guess', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  execMock.mockResolvedValueOnce([row({ status: 'open', project_id: 'p-auth' })]);
  mockGetProject.mockRejectedValue(new Error('aurora down'));
  expect((await listDecisions())[0]).toMatchObject({ deciderRole: 'org-leader', decider: null });
  warn.mockRestore();
});
