// GET /api/discussions/unread: the active tenant's page discussions with new
// messages, every count recomputed server-side from the stored cursor and
// messages, every thread re-decided against the current read gate.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ ...jest.requireActual('../../lib/authz.js'), isAllowed: jest.fn() }));
jest.mock('../../lib/page-resources.js', () => ({ pageResourceVisible: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { discussionsRouter } from '../discussions.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { pageResourceVisible } from '../../lib/page-resources.js';
import type { Session } from '../../lib/session.js';
import { createMemorySocialChatBackend, setSocialChatBackend, type SocialChatBackend } from '../../lib/social-chat.js';
import { unreadItemId, DISCUSSION_UNREAD_KIND } from '../../lib/page-thread-unread.js';
import { setNotificationSink } from '../../lib/social-notify.js';

const TEAM = 'assessment:team:TEAM-005';
const asha: Session = { sub: 'asha', name: 'Asha', tenant: 'assessment', role: 'assessor', epoch: 2, iat: 1, grants: { assessment: ['assessor'] } };
let users: Map<string, UserInfo>; let session: Session | undefined; let backend: SocialChatBackend;
let items: Array<{ id: string; payload: Record<string, unknown> }>; let teamExists: boolean;
const app = express();
app.use((req, _res, next) => { req.session = session; next(); });
app.use('/api/discussions', discussionsRouter); app.use(errorHandler);
const u = (id: string, grants: Record<string, string[]>, epoch = 1): UserInfo => ({ id, displayName: `${id} Dir`, email: null, personId: null, epoch, grants });
const msg = (id: string, userId: string, at: string) => ({ id, clientId: `c-${userId}`, channel: TEAM, userId, message: `${id} text`, timestamp: at, metadata: {} });
const prevDemo = process.env['AUTH_DEMO_MODE'];
beforeAll(() => { process.env['NODE_ENV'] = 'production'; process.env['AUTH_DEMO_MODE'] = 'false'; });
afterAll(() => {
  process.env['NODE_ENV'] = 'test'; if (prevDemo === undefined) delete process.env['AUTH_DEMO_MODE']; else process.env['AUTH_DEMO_MODE'] = prevDemo;
  setSocialChatBackend(null); setNotificationSink(null);
});
beforeEach(async () => {
  session = structuredClone(asha); teamExists = true;
  users = new Map([['asha', u('asha', { assessment: ['assessor'] }, 2)], ['jonas', u('jonas', { assessment: ['lead-assessor'] })]]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()]);
  jest.mocked(isAllowed).mockImplementation(async (p, action) => action === 'ViewAssessment' && p.tenant === 'assessment');
  jest.mocked(pageResourceVisible).mockImplementation(async () => teamExists);
  backend = createMemorySocialChatBackend({ fixtures: false });
  setSocialChatBackend(backend);
  for (const m of [msg('m1', 'jonas', '2026-10-06T09:00:00.000Z'), msg('m2', 'jonas', '2026-10-06T09:05:00.000Z'), msg('m3', 'jonas', '2026-10-06T09:06:00.000Z')]) await backend.chatStore.putMessage(m);
  await backend.readReceiptStore.advance({ channel: TEAM, userId: 'asha', readAt: '2026-10-06T09:00:00.000Z', updatedAt: '2026-10-06T09:00:00.000Z' });
  // A pre-0.118 item (no `chatUnread` marker) still names its thread.
  items = [{ id: unreadItemId(TEAM, '2026-10-06T09:00:00.000Z'), payload: { kind: DISCUSSION_UNREAD_KIND, tenant: 'assessment', channel: TEAM } },
    { id: 'other', payload: { kind: 'mention', tenant: 'assessment', channel: TEAM } }];
  setNotificationSink({ notifyUser: async () => undefined, listForUser: async () => items });
});

it('returns the reader\'s threads with a server-computed count and the rail door they belong to', async () => {
  const res = await request(app).get('/api/discussions/unread');
  expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ tenant: 'assessment', sections: { '/assessment/teams': 1 }, threads: [expect.objectContaining({
    channel: TEAM, title: 'Team TEAM-005', unreadCount: 2, section: '/assessment/teams', href: '/assessment/teams/TEAM-005?tab=discussion',
    lastMessageAt: '2026-10-06T09:06:00.000Z', lastMessagePreview: 'm3 text',
  })] });
});

it('drops a thread once read, and refuses anonymous or retired sessions', async () => {
  await backend.readReceiptStore.advance({ channel: TEAM, userId: 'asha', readAt: '2026-10-06T09:06:00.000Z', updatedAt: '2026-10-06T09:07:00.000Z' });
  expect((await request(app).get('/api/discussions/unread')).body.threads).toEqual([]);
  session = undefined; expect((await request(app).get('/api/discussions/unread')).status).toBe(401);
  session = structuredClone(asha); users.get('asha')!.epoch = 3;
  expect((await request(app).get('/api/discussions/unread')).status).toBe(401);
});

it('re-asks the read gate per thread: a denied policy, a gone page or another active tenant lists nothing', async () => {
  jest.mocked(isAllowed).mockImplementation(async () => false);
  expect((await request(app).get('/api/discussions/unread')).body.threads).toEqual([]);
  jest.mocked(isAllowed).mockImplementation(async (p, action) => action === 'ViewAssessment' && p.tenant === 'assessment');
  teamExists = false;
  expect((await request(app).get('/api/discussions/unread')).body.threads).toEqual([]);
  teamExists = true;
  users.set('asha', u('asha', { assessment: ['assessor'], orgiq: ['member'] }, 2));
  session = { ...structuredClone(asha), tenant: 'orgiq', role: 'member', grants: { assessment: ['assessor'], orgiq: ['member'] } };
  const res = await request(app).get('/api/discussions/unread');
  expect(res.status).toBe(200); expect(res.body).toEqual({ tenant: 'orgiq', threads: [], sections: {} });
});

it('lists nothing without a gateway inbox', async () => {
  setNotificationSink(null);
  expect((await request(app).get('/api/discussions/unread')).body).toEqual({ tenant: 'assessment', threads: [], sections: {} });
});
