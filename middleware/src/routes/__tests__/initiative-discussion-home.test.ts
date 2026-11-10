// One conversation per initiative, for a Work viewer with no Social access
// (leftovers 2, 10 November). The Social binding read refuses them, so the
// initiative page used to fall back to the old `orgiq:initiative:<id>` thread
// nobody else reads. GET /api/graph/projects/:id/discussion tells the page
// where the discussion is instead: a PUBLIC bound channel's slug, and nothing
// else (no message, no member, no count). A private channel reads as unbound,
// as the binding read answers a non-member.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, region: 'us-east-1', aurora: {} } }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({
  resolveSession: (req: { session?: unknown }) => req.session ?? null,
  requireAction: () => (req: { session?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) =>
    (req.session ? next() : res.status(401).json({ error: 'session required' })),
}));
jest.mock('../../providers/activity.js', () => ({ getProjectActivitySeries: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { workItemsRouter } from '../work-items.js';
import { errorHandler } from '../../lib/async-handler.js';
import { socialBindingsFixture } from '../../mock/social-bindings.js';
import { boundChannel, discussionHome } from '../../lib/initiative-discussion.js';

function app(session: Record<string, unknown> | null) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { if (session) (req as unknown as { session: unknown }).session = session; next(); });
  a.use('/api/graph', workItemsRouter);
  a.use(errorHandler);
  return a;
}
// Helen holds a Work grant and no Social grant (providers/identity.ts seed).
const helen = { sub: 'u-helen', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] } };

afterEach(() => socialBindingsFixture.reset());

describe('GET /api/graph/projects/:id/discussion', () => {
  it('names a public bound channel by its slug, and nothing else', async () => {
    const res = await request(app(helen)).get('/api/graph/projects/p-auth-migration/discussion');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: { slug: 'auth-migration' } });
  });

  it('an unbound initiative has no channel: its own thread stays the discussion', async () => {
    const res = await request(app(helen)).get('/api/graph/projects/p-inference-platform/discussion');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channel: null });
  });

  it('a private bound channel reads as unbound (its name is not this reader\'s to learn)', async () => {
    socialBindingsFixture.rows().push({ tenant: 'orgiq', contextKind: 'initiative', contextId: 'p-inference-platform', channel: 'social:ch:moderators', createdBy: 'u-lena', createdAt: '2026-11-01T00:00:00.000Z' });
    expect(await boundChannel('p-inference-platform')).toBe('social:ch:moderators');
    expect(await discussionHome('p-inference-platform')).toBeNull();
    const res = await request(app(helen)).get('/api/graph/projects/p-inference-platform/discussion');
    expect(res.body).toEqual({ channel: null });
  });

  it('needs a session, and an unknown initiative is a 404', async () => {
    expect((await request(app(null)).get('/api/graph/projects/p-auth-migration/discussion')).status).toBe(401);
    expect((await request(app(helen)).get('/api/graph/projects/p-nope/discussion')).status).toBe(404);
  });
});
