// GET /api/conversations/agent/waiting on an access request thread
// (`access:req:<id>`, docs/access-tenant-design.md A8). Request threads carry
// no agent, so nothing can wait there: a reader the thread's read rule admits
// (lib/access/thread.ts) gets `{ runs: [] }` — the record page's generic poll
// no longer logs a 400 — and anyone else the usual 403. The directory is the
// real memory identity provider (MOCK_AURORA) and the access fixtures.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/authz.js', () => ({ resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { conversationAgentRouter } from '../agent-loop.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../../lib/social-chat.js';
import type { Session } from '../../lib/session.js';

const VIEW = new Set(['requester', 'approver', 'access-admin']);
const app = express();
app.use(express.json());
app.use(async (req, _res, next) => {
  const raw = req.headers['x-as'];
  if (typeof raw === 'string') {
    const [sub, tenant, role] = raw.split('/');
    const u = await getUser(sub!);
    req.session = { sub, tenant, role, epoch: u?.epoch ?? 0, iat: Math.floor(Date.now() / 1000), grants: structuredClone(u?.grants ?? {}) } as Session;
  }
  next();
});
app.use('/api/conversations', conversationAgentRouter);
app.use(errorHandler);

const waiting = (as: string, channel: string) => request(app).get('/api/conversations/agent/waiting').query({ channel }).set('x-as', as);

beforeEach(() => {
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'access' && action === 'ViewAccess' && VIEW.has(p.role));
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { setSocialChatBackend(null); jest.restoreAllMocks(); });

it('a reader of the request gets an empty waiting list, not a 400', async () => {
  // req-0002: Rhea's own request; Omar is her manager (and decided step 1).
  for (const as of ['u-rhea/access/requester', 'u-omar/access/approver', 'u-priya/access/access-admin']) {
    const res = await waiting(as, 'access:req:req-0002');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runs: [] });
  }
});

it('someone outside the request\'s read rule is refused, as on any conversation', async () => {
  // req-0003 is Omar's; Rhea is neither a party nor an approver of it.
  expect((await waiting('u-rhea/access/requester', 'access:req:req-0003')).status).toBe(403);
  // A session standing in another tenant does not read access threads either.
  expect((await waiting('u-theo/orgiq/member', 'access:req:req-0002')).status).toBe(403);
});
