// One store for a work item's conversation (docs/audit/2026-10-07-audit-plan.md
// D2; lib/work-thread.ts). With the REAL provider on the Aurora path (the RDS
// Data API transport replaced by a recorder), the comment routes:
//   * POST writes the thread `orgiq:work:<id>` and issues no SQL that touches
//     work_item_comments — the table is read-only audit history;
//   * GET reads the thread for human comments and asks the table only for its
//     is_system audit rows;
//   * the sender is the session's user and directory name, whatever the body says.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), displayNameForSubject: jest.fn() }));
jest.mock('../../providers/activity.js', () => ({ getProjectActivitySeries: jest.fn() }));
jest.mock('../../routes/chat-pins.js', () => {
  // The floor rule itself is the real one; the membership lookup is the memory backend's.
  return {
    historyFloor: async (channel: string, userId: string) => {
      const { socialChat } = jest.requireActual('../../lib/social-chat.js');
      const member = await socialChat().membershipStore.getMember(channel, userId);
      const floor = member?.historyFrom ? Date.parse(member.historyFrom) : NaN;
      return Number.isFinite(floor) ? floor : null;
    },
    messageVisible: (m: { deletedAt?: string; timestamp: string; metadata?: Record<string, unknown> }, floor: number | null) =>
      !m.deletedAt && m.metadata?.['deleted'] !== true && (floor === null || Date.parse(m.timestamp) > floor),
  };
});
jest.mock('../../providers/work-items.js', () => ({
  ...jest.requireActual('../../providers/work-items.js'),
  getWorkItem: jest.fn(async (id: string) => (id === 'wi-1' ? { id: 'wi-1', status: 'open' } : null)),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { workItemsRouter } from '../work-items.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { getUser } from '../../providers/identity.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';

const execMock = exec as unknown as jest.Mock;
const sqlSeen: string[] = [];

function app(session: Record<string, unknown> | null) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { if (session) (req as unknown as { session: unknown }).session = session; next(); });
  a.use('/api/graph', workItemsRouter);
  a.use(errorHandler);
  return a;
}
const nora = { sub: 'u-nora', role: 'sme', tenant: 'orgiq' };

beforeEach(() => {
  sqlSeen.length = 0;
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  execMock.mockReset();
  execMock.mockImplementation(async (sql: string) => {
    sqlSeen.push(sql);
    if (/FROM people WHERE id IN/.test(sql)) return [{ id: 'p-004', name: 'Nora DaSilva', title: 'Senior Engineer' }];
    if (/FROM projects/.test(sql)) return [{ ok: 1 }];
    if (/SELECT w\.id, w\.title, w\.pr_url, w\.pr_status\s+FROM work_items w/.test(sql)) return [{ id: 'wi-1', title: 'Cap the collector queue', pr_url: null, pr_status: null }];
    if (/FROM work_item_comments c\s+JOIN work_items/.test(sql)) return [{ id: 'wic-audit-1', body: 'Status changed from Open to Done', is_system: true,
      at: '2020-01-01 00:00:00+00', author_id: null, author_name: null, work_item_id: 'wi-1', title: 'Cap the collector queue', pr_url: null, pr_status: null }];
    if (/FROM work_item_comments/.test(sql)) return [{ id: 'wic-audit-1', work_item_id: 'wi-1', author_id: 'p-004', author_name: 'Nora DaSilva',
      author_title: 'Senior Engineer', body: 'Status changed from Open to Done', is_system: true, created_at: '2020-01-01 00:00:00+00' }];
    return [];
  });
  (getUser as jest.Mock).mockReset();
  (getUser as jest.Mock).mockResolvedValue({ id: 'u-nora', displayName: 'Nora DaSilva', personId: 'p-004' });
});
afterAll(() => setSocialChatBackend(null));

describe('POST /api/graph/work-items/:id/comments writes the thread, never the table', () => {
  it('stores a message on orgiq:work:<id> and issues no work_item_comments SQL', async () => {
    const res = await request(app(nora)).post('/api/graph/work-items/wi-1/comments').send({ body: 'Ship it after the canary.' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ workItemId: 'wi-1', authorId: 'p-004', authorName: 'Nora DaSilva', authorTitle: 'Senior Engineer',
      body: 'Ship it after the canary.', isSystem: false });
    expect(sqlSeen.filter((sql) => /work_item_comments/i.test(sql))).toEqual([]);
    const thread = await socialChat().chatStore.listMessages('orgiq:work:wi-1', 10);
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ id: res.body.id, userId: 'u-nora', clientId: 'rest', message: 'Ship it after the canary.',
      metadata: { displayName: 'Nora DaSilva', authorPersonId: 'p-004' } });
  });

  it('a 409 for a session with no linked person writes nothing anywhere', async () => {
    (getUser as jest.Mock).mockResolvedValue({ id: 'u-operator', displayName: 'Operator', personId: null });
    const res = await request(app({ sub: 'u-operator', role: 'admin', tenant: 'orgiq' })).post('/api/graph/work-items/wi-1/comments').send({ body: 'hi' });
    expect(res.status).toBe(409);
    expect(sqlSeen).toEqual([]);
    expect(await socialChat().chatStore.listMessages('orgiq:work:wi-1', 10)).toEqual([]);
  });
});

describe('GET /api/graph/work-items/:id/comments reads the thread', () => {
  it('human comments come from the thread; the table is asked only for is_system rows', async () => {
    await request(app(nora)).post('/api/graph/work-items/wi-1/comments').send({ body: 'From the thread.' });
    sqlSeen.length = 0;
    const res = await request(app(nora)).get('/api/graph/work-items/wi-1/comments');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.comments.map((c: { body: string; isSystem: boolean }) => [c.body, c.isSystem]))
      .toEqual([['Status changed from Open to Done', true], ['From the thread.', false]]);
    const tableReads = sqlSeen.filter((sql) => /work_item_comments/i.test(sql));
    expect(tableReads).toHaveLength(1);
    expect(tableReads[0]).toMatch(/AND c\.is_system/);
    expect(tableReads[0]).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });
});

// The two readers that counted the table (the initiative activity feed and
// v_work_item_summary.comment_count) read the thread now, so a comment posted
// after the migration is seen by both.
describe('the activity feed and the comment summary read the thread', () => {
  it('GET …/comments/summary counts the thread under the reader, and asks the table nothing', async () => {
    const first = await request(app(nora)).post('/api/graph/work-items/wi-1/comments').send({ body: 'one' });
    await new Promise((r) => setTimeout(r, 5));
    const second = await request(app(nora)).post('/api/graph/work-items/wi-1/comments').send({ body: 'two' });
    sqlSeen.length = 0;
    const res = await request(app(nora)).get('/api/graph/work-items/wi-1/comments/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workItemId: 'wi-1', commentCount: 2, lastCommentAt: second.body.createdAt });
    expect(sqlSeen.filter((sql) => /work_item_comments/i.test(sql))).toEqual([]);

    // A member whose history starts at the first comment counts only the second (strictly after).
    await socialChat().membershipStore.putMember({ channel: 'orgiq:work:wi-1', userId: 'u-late', role: 'member', addedBy: 'test',
      addedAt: first.body.createdAt, historyFrom: first.body.createdAt, removedAt: null });
    const late = await request(app({ sub: 'u-late', role: 'member', tenant: 'orgiq' })).get('/api/graph/work-items/wi-1/comments/summary');
    expect(late.body).toMatchObject({ commentCount: 1, lastCommentAt: second.body.createdAt });

    // A deleted message stops counting.
    await socialChat().chatStore.updateMessage('orgiq:work:wi-1', second.body.id, { deletedAt: new Date().toISOString(), message: '' });
    expect((await request(app(nora)).get('/api/graph/work-items/wi-1/comments/summary')).body).toMatchObject({ commentCount: 1, lastCommentAt: first.body.createdAt });
    expect((await request(app(nora)).get('/api/graph/work-items/wi-1/comments')).body.total).toBe(1);
  });

  it('404s an unknown item', async () => {
    expect((await request(app(nora)).get('/api/graph/work-items/wi-nope/comments/summary')).status).toBe(404);
  });

  it('GET /projects/:id/activity carries a post made after the migration, and asks the table only for audit rows', async () => {
    const posted = await request(app(nora)).post('/api/graph/work-items/wi-1/comments').send({ body: 'Posted after the migration.' });
    sqlSeen.length = 0;
    const res = await request(app(nora)).get('/api/graph/projects/p-obs/activity?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.find((e: { id: string }) => e.id === posted.body.id)).toMatchObject({
      kind: 'comment', action: 'commented on', actorId: 'p-004', actorName: 'Nora DaSilva', workItemId: 'wi-1', subject: 'Cap the collector queue',
    });
    expect(res.body.find((e: { id: string }) => e.id === 'wic-audit-1')).toMatchObject({ kind: 'status' });
    const tableReads = sqlSeen.filter((sql) => /work_item_comments/i.test(sql));
    expect(tableReads).toHaveLength(1);
    expect(tableReads[0]).toMatch(/AND c\.is_system/);
  });
});
