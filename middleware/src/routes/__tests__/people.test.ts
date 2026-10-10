jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { peopleRouter, tenantDmChannel } from '../people.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';
import { setSocialChatBackend, type SocialChatBackend, type SocialConversationRow } from '../../lib/social-chat.js';

const ana: Session = { sub: 'ana', name: 'Cookie label', tenant: 'assessment', role: 'assessor', epoch: 3, iat: 1, grants: { assessment: ['assessor'] } };
let users: Map<string, UserInfo>; let session: Session | undefined;
const app = express();
app.use((req, _res, next) => { req.session = session; next(); });
app.use('/api/people', peopleRouter); app.use(errorHandler);
const u = (id: string, grants: Record<string, string[]>, epoch = 1): UserInfo => ({ id, displayName: `${id} Dir`, email: null, personId: null, epoch, grants });
const prevDemo = process.env['AUTH_DEMO_MODE'];
beforeAll(() => { process.env['NODE_ENV'] = 'production'; process.env['AUTH_DEMO_MODE'] = 'false'; });
afterAll(() => { process.env['NODE_ENV'] = 'test'; if (prevDemo === undefined) delete process.env['AUTH_DEMO_MODE']; else process.env['AUTH_DEMO_MODE'] = prevDemo; });
beforeEach(() => {
  session = structuredClone(ana);
  users = new Map([
    ['ana', u('ana', { assessment: ['assessor'] }, 3)], ['bea', u('bea', { assessment: ['lead-assessor'], orgiq: ['member'] })],
    ['cy', u('cy', { orgiq: ['member'] })], ['dee', u('dee', { assessment: [] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()]);
});

it('lists only people who share the caller\'s active tenant, with the guarded lobby and DM names', async () => {
  const res = await request(app).get('/api/people/shared');
  expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ tenant: 'assessment', me: { userId: 'ana', displayName: 'ana Dir', avatarUrl: null }, lobby: 'assessment:lobby',
    dmPrefix: 'assessment:dm:', people: [{ userId: 'bea', displayName: 'bea Dir', avatarUrl: null }] });
  expect(listUsers).toHaveBeenCalledWith({ authoritative: true });
});

it('refuses anonymous callers and sessions whose epoch or role is no longer current', async () => {
  session = undefined; expect((await request(app).get('/api/people/shared')).status).toBe(401);
  session = structuredClone(ana); users.get('ana')!.epoch = 4;
  expect((await request(app).get('/api/people/shared')).status).toBe(401);
  users.get('ana')!.epoch = 3; users.get('ana')!.grants = { assessment: [] };
  expect((await request(app).get('/api/people/shared')).status).toBe(401);
});

it('returns no roster when the session is revoked during the directory read', async () => {
  jest.mocked(listUsers).mockImplementation(async () => { users.get('ana')!.epoch = 9; return [...users.values()]; });
  const res = await request(app).get('/api/people/shared');
  expect(res.status).toBe(401); expect(res.body.people).toBeUndefined();
});

it('names a DM by sorted distinct ids', () => {
  expect(tenantDmChannel('orgiq', ['u-b', 'u-a', 'u-b'])).toBe('orgiq:dm:u-a:u-b');
});

describe('GET /api/people/conversations', () => {
  const row = (channel: string, at: string, preview = 'hi'): SocialConversationRow =>
    ({ channel, peers: [], lastMessageAt: at, lastMessagePreview: preview, lastMessageUserId: 'bea' });
  let rows: SocialConversationRow[];
  beforeEach(() => {
    rows = [
      row('assessment:dm:ana:bea', '2026-10-05T10:00:00Z', 'newer'),
      row('assessment:dm:ana:cy', '2026-10-05T11:00:00Z'), // cy holds no assessment grant
      row('orgiq:dm:ana:bea', '2026-10-05T12:00:00Z'), // other tenant
      row('assessment:dm:bea:dee', '2026-10-05T12:00:00Z'), // caller is not a member
    ];
    const msgs = [{ id: 'm1', channel: 'assessment:dm:ana:bea', userId: 'bea', message: 'newer', timestamp: '2026-10-05T10:00:00Z' }];
    setSocialChatBackend({
      ready: Promise.resolve(), conversations: { listForUser: async () => rows },
      recentMessages: async (c: string) => msgs.filter(m => m.channel === c), readReceiptStore: { listReceipts: async () => [] },
    } as unknown as SocialChatBackend);
  });
  afterAll(() => setSocialChatBackend(null));

  it('returns only the caller\'s own conversations in the active tenant, with preview and unread', async () => {
    const res = await request(app).get('/api/people/conversations');
    expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ tenant: 'assessment', conversations: [{ channel: 'assessment:dm:ana:bea',
      peers: [{ userId: 'bea', displayName: 'bea Dir', avatarUrl: null }], lastMessageAt: '2026-10-05T10:00:00Z', lastMessagePreview: 'newer', unreadCount: 1 }] });
  });

  it('refuses a revoked session, including one revoked during the read', async () => {
    users.get('ana')!.epoch = 4;
    expect((await request(app).get('/api/people/conversations')).status).toBe(401);
    users.get('ana')!.epoch = 3;
    jest.mocked(listUsers).mockImplementation(async () => { users.get('ana')!.epoch = 9; return [...users.values()]; });
    const res = await request(app).get('/api/people/conversations');
    expect(res.status).toBe(401); expect(res.body.conversations).toBeUndefined();
  });
});
