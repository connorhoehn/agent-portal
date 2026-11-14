// createDecision against Aurora (meeting consent, package 4): one transaction
// writes the decision, its participants and the creation event, and the record
// reads the event's source, call id and named people back. What the SQL returns
// is mocked; the mock branch is covered by routes/__tests__/decisions-create-route.test.ts.

jest.mock('../aurora.js', () => ({ exec: jest.fn(), fetchAvatarsById: jest.fn(async () => new Map()), withTransaction: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: false, agentcore: true } },
}));
jest.mock('../projects.js', () => ({ getProject: jest.fn(async () => null) }));
jest.mock('../identity.js', () => ({ getUser: jest.fn(async () => null) }));
jest.mock('../work-items.js', () => ({ getWorkHeldBy: jest.fn(async () => []), mockSettleWorkBlockedOn: jest.fn(), txSettleWorkBlockedOn: jest.fn() }));

import { exec, withTransaction } from '../aurora.js';
import { createDecision, getDecision } from '../decisions.js';

const execMock = exec as unknown as jest.Mock;
const txMock = withTransaction as unknown as jest.Mock;

beforeEach(() => { execMock.mockReset(); txMock.mockReset(); });

const input = {
  id: 'd-new', projectId: 'p-auth', statement: 'Cut over the smallest tenants first', participants: [
    { personId: 'p-2', role: 'decider' as const }, { personId: 'p-4', role: 'contributor' as const },
  ], actorId: 'p-2', actorName: 'Vera Green', source: 'call' as const, callId: 'call-7',
  people: [{ id: 'p-2', name: 'Vera Green' }, { id: 'p-4', name: 'Nora DaSilva' }],
};

it('a recorded decision is inserted decided, with its one option, its participants and a recorded event in one transaction', async () => {
  const calls: Array<[string, Array<{ name: string; value: { stringValue?: string } }>]> = [];
  txMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(async (sql: string, params: never) => { calls.push([sql, params]); return []; }));
  execMock.mockResolvedValue([]);
  await createDecision({ ...input, state: 'resolved' });
  const param = (i: number, name: string) => calls[i]![1].find((p) => p.name === name)?.value.stringValue;
  expect(calls[0]![0]).toMatch(/INSERT INTO decisions[\s\S]*:options::jsonb[\s\S]*CURRENT_DATE, NOW\(\), :actor, :topic/);
  expect(param(0, 'status')).toBe('resolved');
  expect(JSON.parse(param(0, 'options')!)).toEqual([{ id: 'agreed', label: input.statement }]);
  expect(calls.slice(1, 3).map(([sql]) => sql)).toEqual([expect.stringMatching(/INSERT INTO decision_participants/), expect.stringMatching(/INSERT INTO decision_participants/)]);
  expect(param(1, 'role')).toBe('decider');
  expect(calls[3]![0]).toMatch(/INSERT INTO decision_events[\s\S]*:people::jsonb/);
  expect(param(3, 'kind')).toBe('recorded');
  expect(param(3, 'call')).toBe('call-7');
  expect(JSON.parse(param(3, 'people')!)).toEqual(input.people);
});

it('a raised decision is inserted open with no decider columns and a raised event', async () => {
  const calls: Array<[string, Array<{ name: string; value: { stringValue?: string } }>]> = [];
  txMock.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(async (sql: string, params: never) => { calls.push([sql, params]); return []; }));
  execMock.mockResolvedValue([]);
  await createDecision({ ...input, state: 'waiting', source: 'manual', callId: null });
  expect(calls[0]![0]).toMatch(/NULL, NULL, NULL, NULL\)/);
  expect(calls[0]![1].find((p) => p.name === 'status')?.value.stringValue).toBe('open');
  const event = calls[calls.length - 1]!;
  expect(event[0]).toMatch(/'', :source, NULL, :people::jsonb/);
  expect(event[1].find((p) => p.name === 'kind')?.value.stringValue).toBe('raised');
});

it('the record reads a creation event\'s source, call id and people, and leaves a decide event without them', async () => {
  execMock
    .mockResolvedValueOnce([{ id: 'd-new', topic: 't', summary: null, status: 'resolved', project_id: 'p-auth', work_item_id: null, decided_at: '2026-11-14T10:00:00Z', resolution: 't', decided_by: 'p-2', options: '[{"id":"agreed","label":"t"}]', decided_by_name: 'Vera Green' }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([
      { id: '2', kind: 'resolved', at: '2026-11-14T11:00:00Z', actor_id: 'p-2', actor_name: 'Vera Green', rationale: 'ok', source: null, call_id: null, people: null },
      { id: '1', kind: 'recorded', at: '2026-11-14T10:00:00Z', actor_id: 'p-2', actor_name: 'Vera Green', rationale: '', source: 'call', call_id: 'call-7', people: '[{"id":"p-2","name":"Vera Green"},{"id":"p-4","name":"Nora DaSilva"}]' },
    ]);
  const d = await getDecision('d-new');
  expect(execMock.mock.calls[2]![0]).toMatch(/source, call_id, people::text AS people/);
  expect(d!.history[0]).toEqual({ id: '2', kind: 'resolved', at: '2026-11-14T11:00:00Z', by: { id: 'p-2', name: 'Vera Green' }, rationale: 'ok' });
  expect(d!.history[1]).toEqual(expect.objectContaining({ kind: 'recorded', source: 'call', callId: 'call-7', people: input.people }));
});
