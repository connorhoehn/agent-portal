jest.mock('../aurora.js', () => ({ exec: jest.fn(), fetchAvatarsById: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
import { exec, fetchAvatarsById } from '../aurora.js';
import { getDecision, listDecisionActivity } from '../decisions.js';

beforeEach(() => jest.resetAllMocks());
it('resolves photos only for the people in the decision and preserves missing photos', async () => {
  (exec as jest.Mock).mockResolvedValueOnce([{ id: 'd1', topic: 'Migration' }]).mockResolvedValueOnce([
    { person_id: 'p1', name: 'Vera' }, { person_id: 'p2', name: 'Nora' },
  ]);
  (fetchAvatarsById as jest.Mock).mockResolvedValue(new Map([['p1', '/portraits/vera.jpg']]));
  const detail = await getDecision('d1');
  expect(fetchAvatarsById).toHaveBeenCalledWith(['p1', 'p2']);
  expect(detail?.participants.map(person => person.avatarUrl)).toEqual(['/portraits/vera.jpg', null]);
});
it('does not read people photos when the decision does not exist', async () => {
  (exec as jest.Mock).mockResolvedValueOnce([]);
  expect(await getDecision('missing')).toBeNull();
  expect(fetchAvatarsById).not.toHaveBeenCalled();
});
it('carries the same portraits into activity even for people outside the initiative team', async () => {
  (exec as jest.Mock).mockResolvedValueOnce([{ id: 'd1', topic: 'Migration', escalated_at: '2026-11-02T12:00:00Z' }]).mockResolvedValueOnce([
    { decision_id: 'd1', person_id: 'p1', name: 'Sienna' },
  ]);
  (fetchAvatarsById as jest.Mock).mockResolvedValue(new Map([['p1', '/sienna.jpg']]));
  expect((await listDecisionActivity())[0]?.participants[0]?.avatarUrl).toBe('/sienna.jpg');
});
