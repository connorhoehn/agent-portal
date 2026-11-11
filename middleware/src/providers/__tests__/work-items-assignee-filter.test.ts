// The mock path of searchWorkItems: the assignee filter and a comma list of statuses.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));
import { searchWorkItems } from '../work-items.js';

describe('searchWorkItems, mock path', () => {
  it('assigneeId keeps only that person\'s items', async () => {
    const all = await searchWorkItems({ limit: 200 });
    const someone = all.find((w) => w.assigneeId)!.assigneeId!;
    const mine = await searchWorkItems({ assigneeId: someone, limit: 200 });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((w) => w.assigneeId === someone)).toBe(true);
    expect(mine.length).toBeLessThan(all.length);
  });

  it('a comma list of statuses keeps any of them and drops the rest', async () => {
    const open = await searchWorkItems({ status: 'open,in_progress,in_review', limit: 200 });
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((w) => ['open', 'in_progress', 'in_review'].includes(w.status))).toBe(true);
    const one = await searchWorkItems({ status: 'done', limit: 200 });
    expect(one.every((w) => w.status === 'done')).toBe(true);
  });

  // The My work page is read per person: the demo cast that signs in must not see an empty page.
  it.each([['Layla Hassan', 'p-008'], ['Nora DaSilva', 'p-004'], ['Eli Garcia', 'p-011'], ['Vera Green', 'p-002'], ['Theo Chang', 'p-001']])(
    'the persona %s (%s) has open work assigned across the mock board', async (_name, personId) => {
      const mine = await searchWorkItems({ assigneeId: personId, status: 'open,in_progress,in_review', limit: 200 });
      expect(mine.length).toBeGreaterThan(0);
    });
});
