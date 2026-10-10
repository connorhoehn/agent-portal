// `/diagram` and `/doc` on tenant discussions (routes/conversation-artifact.ts,
// the /api/conversations mount): the same per-family authority matrix as
// /summarize, against the gateway's real channel authority and the chat store.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/authz.js', () => ({ resolveSession: (req: { session?: unknown }) => req.session, isAllowed: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { conversationArtifactRouter, pendingArtifacts } from '../conversation-artifact.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { agentcore } from '../../providers/index.js';
import { config } from '../../config.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import { knowledgeDocs } from '../../mock/assessment.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { parseFlowRunChannel } from '../../lib/flow-runs/index.js';
import type { Session } from '../../lib/session.js';

const POLICY: Record<string, string[]> = {
  member: [], sme: ['DispatchAgentRun'], assessor: ['ViewAssessment', 'ManageKnowledge'], 'assessment-reader': ['ViewAssessment'], author: ['ViewPipelines'],
};
let users: Map<string, UserInfo>;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: `${id} Directory`, email: null, personId: null, epoch: 1, grants });
const sessionFor = (sub: string, tenant: string, role: string): Session =>
  ({ sub, tenant, role, epoch: 1, iat: 1, grants: structuredClone(users.get(sub)?.grants ?? {}) }) as Session;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const raw = req.headers['x-as'];
  if (typeof raw === 'string') { const [sub, tenant, role] = raw.split('/'); req.session = sessionFor(sub!, tenant!, role!); }
  next();
});
app.use('/api/conversations', conversationArtifactRouter);
app.use(errorHandler);

type Cmd = 'diagram' | 'doc';
const settle = async (): Promise<void> => { await Promise.all([...pendingArtifacts]); };
const run = (cmd: Cmd, as: string, channel: string, text = '') => request(app).post(`/api/conversations/${cmd}/run`).set('x-as', as).send({ channel, text });
const status = (cmd: Cmd, as: string, id: string) => request(app).get(`/api/conversations/${cmd}/runs/${id}`).set('x-as', as);
const post = (as: string, id: string) => request(app).post(`/api/conversations/diagram/runs/${id}/post`).set('x-as', as);
const save = (as: string, id: string, body: object = {}) => request(app).post(`/api/conversations/doc/runs/${id}/save`).set('x-as', as).send(body);
const msg = (channel: string, id: string, userId: string, text: string, timestamp: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id, channel, clientId: `c-${userId}`, userId, message: text, timestamp, metadata: { displayName: 'Forged label' }, ...over });

const CASES = [
  { tenant: 'orgiq', letter: 'o', channel: 'orgiq:initiative:p-auth', reader: 'olu/orgiq/sme', readOnly: 'mia/orgiq/member', crossTenant: 'ana/assessment/assessor', target: null },
  { tenant: 'assessment', letter: 'a', channel: 'assessment:doc:d-1', reader: 'ana/assessment/assessor', readOnly: null, crossTenant: 'olu/orgiq/sme', target: 'document' },
  { tenant: 'pipelines', letter: 'p', channel: 'pipelines:run:r-7', reader: 'pat/pipelines/author', readOnly: null, crossTenant: 'ana/assessment/assessor', target: null },
] as const;
const subOf = (as: string) => as.split('/')[0]!;

beforeEach(async () => {
  flowRunsFixture.reset();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  users = new Map([
    ['olu', user('olu', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
    ['mia', user('mia', { orgiq: ['member'] })],
    ['ana', user('ana', { assessment: ['assessor'], orgiq: ['member'] })],
    ['pat', user('pat', { pipelines: ['author'], orgiq: ['member'] })],
    ['rae', user('rae', { assessment: ['assessment-reader'] })],
    ['zed', user('zed', { orgiq: ['sme'], assessment: ['assessor'], pipelines: ['author'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => (POLICY[p.role] ?? []).includes(action));
  const doc = { title: 'Draft', classification: 'internal', markdown: '', path: 'drafts/x.md', updated_at: '2026-10-01T00:00:00.000Z' };
  knowledgeDocs().push({ ...doc, id: 'draft:11111111-1111-1111-1111-111111111111', editable: true }, { ...doc, id: 'draft:22222222-2222-2222-2222-222222222222', editable: false });
  const store = socialChat().chatStore;
  for (const c of CASES) {
    await store.putMessage(msg(c.channel, `${c.channel}-1`, 'zed', 'We ship the cutover on Thursday.', '2026-10-01T10:00:00.000Z'));
    await store.putMessage(msg(c.channel, `${c.channel}-2`, 'olu', 'I will update the runbook first.', '2026-10-01T11:00:00.000Z'));
    await store.putMessage(msg(c.channel, `${c.channel}-3`, 'zed', 'Deleted line with a secret.', '2026-10-01T12:00:00.000Z', { deletedAt: '2026-10-01T12:05:00.000Z' }));
  }
});
afterEach(() => { flowRunsFixture.reset(); setSocialChatBackend(null); jest.clearAllMocks(); });

describe.each(CASES.flatMap(c => (['diagram', 'doc'] as const).map(cmd => ({ ...c, cmd }))))('/$cmd in $channel', (c) => {
  const prefix = `${c.letter}${c.cmd === 'diagram' ? 'dg' : 'dc'}`;

  it('a reader gets a private run of verbatim quotes, authors from the directory; nothing is posted', async () => {
    const before = (await socialChat().chatStore.listMessages(c.channel, 50)).length;
    const started = await run(c.cmd, c.reader, c.channel, 'cutover');
    expect(started.status).toBe(202);
    expect(started.body.runId).toMatch(new RegExp(`^${prefix}-`));
    expect(parseFlowRunChannel(`${c.tenant}:flowrun:${started.body.runId}`)).toMatchObject({ tenant: c.tenant });
    await settle();
    const got = await status(c.cmd, c.reader, started.body.runId);
    expect(got.body).toMatchObject({ phase: 'completed', posted: false, channel: c.channel, saveTarget: c.target });
    const quoted = JSON.stringify(got.body.result);
    expect(quoted).toContain('runbook');
    expect(quoted).not.toContain('secret');
    expect(quoted).toContain('olu Directory');
    expect(quoted).not.toContain('Forged label');
    expect((await socialChat().chatStore.listMessages(c.channel, 50)).length).toBe(before);
    expect(flowRunsFixture.rows()[0]).toMatchObject({ tenant: c.tenant, kind: `${c.tenant}.${c.cmd}`, requestedBy: subOf(c.reader) });
  });

  it('a cross-tenant caller is denied, and a membership-closed conversation refuses even its tenant reader', async () => {
    expect((await run(c.cmd, c.crossTenant, c.channel)).status).toBe(403);
    await socialChat().membershipStore.putMember({ channel: c.channel, userId: 'zed', role: 'member', joinedAt: '2026-10-01T00:00:00.000Z' } as never);
    expect((await run(c.cmd, c.reader, c.channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('a revocation during the transcript read denies and stores nothing', async () => {
    const sub = subOf(c.reader);
    const store = socialChat().chatStore;
    const list = store.listMessages.bind(store);
    jest.spyOn(store, 'listMessages').mockImplementation(async (...args) => { users.get(sub)!.grants = {}; return list(...args); });
    expect((await run(c.cmd, c.reader, c.channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('the run is the requester\'s alone, and the conversation is re-checked on every read', async () => {
    const started = await run(c.cmd, c.reader, c.channel); await settle();
    const other = 'zed/' + c.reader.split('/').slice(1).join('/');
    expect((await status(c.cmd, other, started.body.runId)).status).toBe(404);
    expect((await status(c.cmd, c.reader, `${prefix}-00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    users.get(subOf(c.reader))!.grants = {};
    expect((await status(c.cmd, c.reader, started.body.runId)).status).toBe(403);
  });

  it('the other command\'s routes do not see this run', async () => {
    const started = await run(c.cmd, c.reader, c.channel); await settle();
    expect((await status(c.cmd === 'diagram' ? 'doc' : 'diagram', c.reader, started.body.runId)).status).toBe(404);
  });

  if (c.cmd === 'diagram') {
    it('posting needs the conversation\'s post authority and returns the server-built message once', async () => {
      if (c.readOnly) {
        const ro = await run('diagram', c.readOnly, c.channel); await settle();
        expect((await status('diagram', c.readOnly, ro.body.runId)).status).toBe(200);
        expect((await post(c.readOnly, ro.body.runId)).status).toBe(403);
      }
      const started = await run('diagram', c.reader, c.channel); await settle();
      const posted = await post(c.reader, started.body.runId);
      expect(posted.status).toBe(200);
      expect(posted.body).toMatchObject({ channel: c.channel, metadata: { artifactOf: { command: 'diagram', runId: started.body.runId } } });
      expect((await post(c.reader, started.body.runId)).status).toBe(409);
      expect((await socialChat().chatStore.listMessages(c.channel, 50)).some(m => m.metadata?.['artifactOf'])).toBe(false);
    });
  } else {
    it(c.target ? 'Save needs the new page\'s id, returns a reference message once' : 'Save has no document store here and says so', async () => {
      const started = await run('doc', c.reader, c.channel, 'Runbook'); await settle();
      if (!c.target) {
        const refused = await save(c.reader, started.body.runId, { documentId: 'd-9' });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toMatch(/no document store/);
        return;
      }
      expect((await save(c.reader, started.body.runId)).status).toBe(400);
      expect((await save(c.reader, started.body.runId, { documentId: '../../etc passwd' })).status).toBe(400);
      const saved = await save(c.reader, started.body.runId, { documentId: 'draft:11111111-1111-1111-1111-111111111111' });
      expect(saved.status).toBe(200);
      expect(saved.body.metadata).toMatchObject({ documents: [{ id: 'draft:11111111-1111-1111-1111-111111111111', label: 'Runbook' }], artifactOf: { command: 'doc' } });
      expect(saved.body.text).not.toContain('runbook first'); // the body is never posted, only its reference
      expect((await save(c.reader, started.body.runId, { documentId: 'draft:11111111-1111-1111-1111-111111111111' })).status).toBe(409);
    });

    it('Save resolves the document against the actor\'s current authority: missing 404, read-only 403, no grant 403, cross-tenant refused', async () => {
      if (!c.target) return;
      const started = await run('doc', c.reader, c.channel, 'Runbook'); await settle();
      const missing = await save(c.reader, started.body.runId, { documentId: 'draft:99999999-9999-9999-9999-999999999999' });
      expect(missing.status).toBe(404);
      const readOnly = await save(c.reader, started.body.runId, { documentId: 'draft:22222222-2222-2222-2222-222222222222' });
      expect(readOnly.status).toBe(403);
      // A reader of the same conversation without ManageKnowledge cannot save into a document.
      const rd = await run('doc', 'rae/assessment/assessment-reader', c.channel, 'Runbook'); await settle();
      expect((await save('rae/assessment/assessment-reader', rd.body.runId, { documentId: 'draft:11111111-1111-1111-1111-111111111111' })).status).toBe(403);
      // Another tenant's session cannot reach the run at all, and a refusal claims nothing.
      expect((await save(c.crossTenant, started.body.runId, { documentId: 'draft:11111111-1111-1111-1111-111111111111' })).status).toBe(404);
      expect((await save(c.reader, started.body.runId, { documentId: 'draft:11111111-1111-1111-1111-111111111111' })).status).toBe(200);
    });
  }
});

describe('the route surface', () => {
  it('refuses anonymous callers, Social conversations and presence-only families', async () => {
    expect((await request(app).post('/api/conversations/diagram/run').send({ channel: 'orgiq:initiative:p-auth' })).status).toBe(401);
    for (const channel of ['social:ch:general', 'orgiq:deck:d1', 'orgiq:lobby', 'presence:orgiq:initiative:p-auth', 'orgiq:nope:1']) {
      expect((await run('doc', 'olu/orgiq/sme', channel)).status).toBe(400);
    }
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });
});

describe('the drafter', () => {
  const invoke = agentcore.invokeAgent as jest.Mock;
  beforeEach(() => { (config.mock as { agentcore: boolean }).agentcore = false; invoke.mockReset(); });
  afterEach(() => { (config.mock as { agentcore: boolean }).agentcore = true; });

  it('a tenant the drafter\'s guard refuses gets the deterministic result, flagged with the reason; assessment is asked with its tenant', async () => {
    invoke.mockResolvedValueOnce({ text: '', raw: { agent: 'orgiq-assessment-drafter', error: 'forbidden', detail: "only serves the 'assessment' tenant (got 'orgiq')" } });
    const refused = await run('doc', 'olu/orgiq/sme', 'orgiq:initiative:p-auth'); await settle();
    expect((await status('doc', 'olu/orgiq/sme', refused.body.runId)).body.result).toMatchObject({ fallback: true, unavailable: expect.stringContaining('assessment') });
    invoke.mockResolvedValueOnce({ text: JSON.stringify({ summary: 'A page.', content: '# P', format: 'markdown', source_spans: ['I will update the runbook first.'] }), toolCalls: [] });
    const ok = await run('doc', 'ana/assessment/assessor', 'assessment:doc:d-1'); await settle();
    expect((await status('doc', 'ana/assessment/assessor', ok.body.runId)).body.result).toMatchObject({ fallback: false });
    expect(invoke).toHaveBeenLastCalledWith('orgiq-assessment-drafter', expect.objectContaining({
      structuredInput: expect.objectContaining({ mode: 'draft-confluence-page', auth: { tenant: 'assessment', sub: 'ana' } }) }));
  });
});
