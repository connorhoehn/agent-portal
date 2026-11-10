// The decision-link writes resolve `:id` to an item whose initiative has a free
// decision, in board order — not the board's first row, whose initiative may
// have none (that left PUT/DELETE …/decisions/:decisionId skipped).

import { PARAM_RESOLVERS } from '../http.js';
import type { Json } from '../shape.js';

const resolveId = PARAM_RESOLVERS['id@/api/graph/work-items/:id/decisions/:decisionId']!;
const resolveDecision = PARAM_RESOLVERS['decisionId@/api/graph/work-items/:id/decisions']!;

const BOARD: Json[] = [
  { id: 'wi-a', projectId: 'p-none' },
  { id: 'wi-b', projectId: 'p-taken' },
  { id: 'wi-c', projectId: 'p-free' },
  { id: 'wi-d', projectId: 'p-free' },
];
const DECISIONS: Record<string, Json[]> = {
  'p-none': [],
  'p-taken': [{ id: 'd-1', workItemId: 'wi-other' }],
  'p-free': [{ id: 'd-2', workItemId: null }],
};

function reader(log: string[] = []) {
  return async (path: string): Promise<Json> => {
    log.push(path);
    if (path === '/api/graph/work') return BOARD;
    const m = /^\/api\/graph\/projects\/([^/]+)\/decisions$/.exec(path);
    return m ? (DECISIONS[decodeURIComponent(m[1]!)] ?? []) : null;
  };
}

describe('decision-link param resolvers', () => {
  it('takes the first item, in board order, whose initiative has a free decision', async () => {
    await expect(resolveId({ values: {}, read: reader() })).resolves.toBe('wi-c');
  });

  it('then takes that free decision for it', async () => {
    await expect(resolveDecision({ values: { id: 'wi-c' }, read: reader() })).resolves.toBe('d-2');
  });

  it('reads each initiative\'s decisions once, and answers null when no item qualifies', async () => {
    const log: string[] = [];
    const none = async (path: string): Promise<Json> => (path === '/api/graph/work' ? BOARD.slice(0, 2) : reader(log)(path));
    await expect(resolveId({ values: {}, read: none })).resolves.toBeNull();
    expect(log.filter((p) => p.endsWith('/decisions'))).toEqual([
      '/api/graph/projects/p-none/decisions', '/api/graph/projects/p-taken/decisions',
    ]);
  });
});
