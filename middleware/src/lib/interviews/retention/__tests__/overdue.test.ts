// A late deletion (lib/interviews/retention/overdue.ts): the facts on a row, the sweep's order, and the recruiter's one bell.
jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));
import { fixtureRegistry } from '../../../../mock/core/index.js';
import type { InterviewsWorld } from '../../types.js';
import { DEFAULT_PERIODS } from '../periods.js';
import { registerEraser } from '../registry.js';
import { doneLate, isOverdue, overdueBellId, overdueFirst, ringOverdue } from '../overdue.js';
import { sweep } from '../service.js';
import { deletionStore, setDeletionStore, type DeletionRow } from '../store.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const at = (ms: number) => new Date(ms).toISOString();
const row = (id: string, over: Partial<DeletionRow> = {}): DeletionRow => ({
  id, candidateId: 'cand-x', interviewIds: ['iv-a'], reason: 'request', requestedAt: at(NOW - 40 * DAY), requestedBy: 'u-r', dueBy: at(NOW - 10 * DAY),
  doneAt: null, removed: [], left: [{ kind: 'recording', why: 'failed', retry: true }], attempts: 1, revision: 1, ...over,
});
const world = {
  openings: [{ id: 'op', title: 'Backend Engineer', recruiterId: 'u-r' }, { id: 'op2', title: 'iOS Engineer', recruiterId: 'u-r' }],
  scorecards: [], candidates: [{ id: 'cand-x', name: 'Test Person' }],
  applications: [{ id: 'app-x', candidateId: 'cand-x', openingId: 'op', history: [] }, { id: 'app-y', candidateId: 'cand-x', openingId: 'op2', history: [] }],
  interviews: [{ id: 'iv-a', applicationId: 'app-x' }, { id: 'iv-b', applicationId: 'app-y' }],
} as unknown as InterviewsWorld;

afterEach(() => { fixtureRegistry.resetAll('default'); setDeletionStore(null); });

describe('the facts on a row', () => {
  it('overdue is open past its date; done late is finished after it', () => {
    expect(isOverdue(row('a'), NOW)).toBe(true);
    expect(isOverdue(row('a', { dueBy: at(NOW + DAY) }), NOW)).toBe(false);
    expect(isOverdue(row('a', { doneAt: at(NOW) }), NOW)).toBe(false);
    expect(doneLate(row('a', { doneAt: at(NOW) }))).toBe(true);
    expect(doneLate(row('a', { doneAt: at(NOW - 20 * DAY) }))).toBe(false);
    expect(overdueFirst([row('later', { dueBy: at(NOW + 5 * DAY) }), row('late'), row('later-still', { dueBy: at(NOW + 9 * DAY) })], NOW).map((r) => r.id))
      .toEqual(['late', 'later', 'later-still']);
  });
});

describe('the recruiter\'s bell', () => {
  const sent: Array<{ to: readonly string[]; input: Record<string, unknown> }> = [];
  const notify = async (to: readonly string[], input: unknown) => { sent.push({ to, input: input as Record<string, unknown> }); return [...to]; };
  beforeEach(() => { sent.length = 0; });

  it('rings once per row, names the openings and never the candidate, and opens the profile', async () => {
    const rung = new Set<string>();
    const rows = [row('del-1', { interviewIds: ['iv-a', 'iv-b'] }), row('del-2', { dueBy: at(NOW + DAY) }), row('del-3', { doneAt: at(NOW) })];
    expect(await ringOverdue(rows, world, NOW, { notify, inbox: () => null }, rung)).toBe(1);
    expect(sent).toHaveLength(1);
    const bell = sent[0]!;
    expect(bell.to).toEqual(['u-r']);
    expect(bell.input).toMatchObject({
      id: overdueBellId('del-1', 'u-r'),
      title: 'A candidate\'s deletion on Backend Engineer and one other opening is late',
      payload: { tenant: 'interviews', kind: 'interview-deletion-overdue', audience: 'recruiter' },
      action: { label: 'Open the profile', href: '/interviews/candidates/cand-x' },
    });
    expect(JSON.stringify(bell.input)).not.toMatch(/Test Person|2026|del-1/);
    // A second sweep in this process rings nothing.
    expect(await ringOverdue(rows, world, NOW + DAY, { notify, inbox: () => null }, rung)).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('after a restart, the recruiter\'s inbox remembers the bell; a bell nobody received is tried again', async () => {
    const inbox = { listForUser: async () => [{ id: overdueBellId('del-1', 'u-r') }] };
    expect(await ringOverdue([row('del-1')], world, NOW, { notify, inbox: () => inbox }, new Set())).toBe(0);
    expect(sent).toHaveLength(0);
    const rung = new Set<string>();
    const nobody = async () => [] as string[];
    expect(await ringOverdue([row('del-1')], world, NOW, { notify: nobody, inbox: () => null }, rung)).toBe(0);
    expect(await ringOverdue([row('del-1')], world, NOW, { notify, inbox: () => null }, rung)).toBe(1);
  });
});

describe('the sweep and late rows', () => {
  it('retries overdue rows first and rings only for those still open past their date', async () => {
    const order: string[] = [];
    registerEraser({ kind: 'recording', class: 'media', erase: async (ids) => { order.push(ids.join(',')); if (ids.includes('iv-b')) throw new Error('down'); return 1; } });
    await deletionStore().insert({ ...row('del-soon', { interviewIds: ['iv-a'], dueBy: at(NOW + 20 * DAY), requestedAt: at(NOW - 50 * DAY) }) });
    await deletionStore().insert({ ...row('del-late', { interviewIds: ['iv-b'] }) });
    const rung: Array<string[]> = [];
    await sweep({
      now: () => NOW, load: async () => world, enabled: () => true, periods: () => ({ ...DEFAULT_PERIODS }),
      ringOverdue: async (rows) => { rung.push(rows.filter((r) => isOverdue(r, NOW)).map((r) => r.id)); return 0; },
    });
    expect(order.slice(0, 2)).toEqual(['iv-b', 'iv-a']);
    expect(rung).toEqual([['del-late']]);
  });
});
