// `/agent` creation steps in Social (routes/agent-loop-create.ts): a plan of document:create +
// meeting:create, run as the member's fresh session. The document is a stored file in the thread's
// upload store; the meeting is a room made by the "New room" path (ManageChannels).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
process.env['GATEWAY_UPLOAD_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-create-'));
const mockCaps = { current: ['ViewSocial', 'PostMessage', 'ManageChannels'] };
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' },
    cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => ['participant', 'moderator', 'community-admin']
    .map(id => ({ id, tenant: 'social', capabilities: mockCaps.current })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { chatPinsRouter } from '../chat-pins.js';
import { socialAgentRouter } from '../agent-loop.js';
import { errorHandler } from '../../lib/async-handler.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../lib/social-chat.js';
import * as authz from '../../lib/authz.js';
import { getUser } from '../../providers/identity.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { socialRoomsFixture } from '../../mock/social-platform.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { agentPlansFixture } from '../../mock/agent-plans.js';
import { gatewayUploadBackend, resetGatewayUploadBackendForTests } from '../../lib/gateway-attachments.js';
import { gatewayUploadsFixture } from '../../mock/gateway-attachments.js';
import { pendingFlowRuns } from '../../lib/flow-runs/index.js';
import { createDocumentStep, createMeetingStep } from '../agent-loop-create.js';
import type { Request } from 'express';
import type { Session } from '../../lib/session.js';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';

const app = express();
app.use(express.json());
app.use(async (req, _res, next) => {
  const sub = req.headers['x-as'];
  if (typeof sub === 'string') {
    const user = await getUser(sub);
    req.session = { sub, name: user?.displayName, role: 'participant', tenant: 'social', epoch: user?.epoch ?? 0, grants: user?.grants ?? {}, iat: 1 } as Session;
  }
  next();
});
app.use('/api/chat', chatPinsRouter);
app.use('/api/chat/commands', socialAgentRouter);
app.use(errorHandler);

const CHANNEL = 'social:ch:general';
const base = '/api/chat/commands/agent';
const msg = (id: string, text: string, timestamp: string, userId: string): ChatMessage =>
  ({ id, channel: CHANNEL, clientId: 'c', userId, message: text, timestamp, metadata: { displayName: userId } });
const settle = async (): Promise<void> => { while (pendingFlowRuns.size) await Promise.all([...pendingFlowRuns]); };
const start = (as: string, text = 'plan the kickoff') => request(app).post(`${base}/run`).set('x-as', as).send({ channel: CHANNEL, text });
const status = (as: string, id: string) => request(app).get(`${base}/runs/${id}`).set('x-as', as);
const approve = (as: string, id: string) => request(app).post(`${base}/runs/${id}/approve`).set('x-as', as);
const stepOf = (body: { steps: { status: string; link?: { kind: string; href?: string } }[] }, i: number) => body.steps[i]!;

beforeEach(async () => {
  mockCaps.current = ['ViewSocial', 'PostMessage', 'ManageChannels'];
  agentPlansFixture.reset(); socialRoomsFixture.reset(); gatewayUploadsFixture.reset(); resetGatewayUploadBackendForTests();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  await socialChat().chatStore.putMessage(msg('a1', 'Kickoff is Thursday.', '2026-10-01T10:00:00.000Z', 'u-mira'));
});
afterEach(() => {
  socialChannelMembersFixture.reset(); socialChannelMessagesFixture.reset(); flowRunsFixture.reset(); socialRoomsFixture.reset();
  gatewayUploadsFixture.reset(); agentPlansFixture.reset(); jest.restoreAllMocks(); setSocialChatBackend(null);
});

describe('/agent document:create + meeting:create in Social', () => {
  it('plans both kinds, and Approve stores the document in the thread and creates a room, each linked from its step', async () => {
    const started = await start('u-sana'); await settle();
    const plan = (await status('u-sana', started.body.runId)).body.plan;
    expect(plan.steps.map((s: { kind: string }) => s.kind)).toEqual(['document:create', 'meeting:create']);
    expect(plan.steps[0].body).toContain('## Agenda');
    expect((await approve('u-sana', started.body.runId)).status).toBe(202); await settle();
    const got = (await status('u-sana', started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'done', phase: 'completed', error: null });
    expect(got.steps.map((s: { status: string }) => s.status)).toEqual(['completed', 'completed']);
    const doc = stepOf(got, 0).link!; const room = stepOf(got, 1).link!;
    expect(doc).toMatchObject({ kind: 'document', href: expect.stringMatching(/^\/api\/uploads\/[0-9a-f-]{36}$/) });
    expect(room).toMatchObject({ kind: 'room', href: '/social/rooms?room=meeting-plan-the-kickoff', lobbyName: 'social:room:meeting-plan-the-kickoff' });
    // The file is in the conversation's upload store, owned by the requester, with the planner's body.
    const row = gatewayUploadsFixture.rows().find(r => doc.href!.endsWith(r.uploadId))!;
    expect(row).toMatchObject({ channel: CHANNEL, uploader: 'u-sana', status: 'completed', contentType: 'text/markdown', filename: 'Notes plan the kickoff.md' });
    const chunks: Buffer[] = [];
    for await (const chunk of gatewayUploadBackend().blobStore.createReadStream(row.uploadId)!) chunks.push(Buffer.from(chunk as Buffer));
    expect(Buffer.concat(chunks).toString('utf8')).toContain('## Agenda');
    // The room is the "New room" path's: org-visible, created by the requester.
    expect(socialRoomsFixture.rows().find(r => r.slug === 'meeting-plan-the-kickoff')).toMatchObject({ name: 'Meeting: plan the kickoff', createdBy: 'u-sana', visibility: 'org' });
  });

  it('a requester without ManageChannels is refused at the room step: the document stands, the loop stops with the reason', async () => {
    const started = await start('u-sana'); await settle();
    jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'ManageChannels');
    await approve('u-sana', started.body.runId); await settle();
    const got = (await status('u-sana', started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'stopped', phase: 'failed', error: expect.stringContaining('Step 2 stopped the loop: 403') });
    expect(got.steps.map((s: { status: string }) => s.status)).toEqual(['completed', 'failed']);
    expect(socialRoomsFixture.rows().some(r => r.slug === 'meeting-plan-the-kickoff')).toBe(false);
  });

  it('a member who lost the posting right before Approve is refused 403 there, and nothing is created', async () => {
    const started = await start('u-sana'); await settle();
    jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage' && action !== 'ManageChannels');
    expect((await approve('u-sana', started.body.runId)).status).toBe(403);
    expect((await status('u-sana', started.body.runId)).body.stage).toBe('awaiting-approval');
    expect(gatewayUploadsFixture.rows()).toHaveLength(0);
    expect(socialRoomsFixture.rows().some(r => r.slug === 'meeting-plan-the-kickoff')).toBe(false);
  });

  it('a removed member fails closed at the step and creates nothing', async () => {
    const started = await start('u-sana'); await settle();
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect((await approve('u-sana', started.body.runId)).status).toBe(403);
    expect(gatewayUploadsFixture.rows()).toHaveLength(0);
  });

  it('the steps refuse another tenant\'s session and a conversation the caller is not in', async () => {
    const step = { kind: 'document:create', title: 'T', instruction: '', acceptance: 'Done.' } as const;
    const orgiq = { sub: 'u-sana', tenant: 'orgiq', role: 'member', epoch: 0, grants: {}, iat: 1 } as unknown as Session;
    const req = (s: Session) => ({ method: 'POST', session: s, headers: {}, get: () => undefined }) as unknown as Request;
    await expect(createDocumentStep(req(orgiq), orgiq, 'social', CHANNEL, step)).rejects.toMatchObject({ status: 403 });
    await expect(createMeetingStep(req(orgiq), orgiq, 'social', CHANNEL, { ...step, kind: 'meeting:create' })).rejects.toMatchObject({ status: 403 });
    const social = { sub: 'u-sana', tenant: 'social', role: 'participant', epoch: 0, grants: { social: ['participant'] }, iat: 1 } as unknown as Session;
    await expect(createDocumentStep(req(social), social, 'social', 'social:ch:moderators', step)).rejects.toMatchObject({ status: 403 });
    expect(gatewayUploadsFixture.rows()).toHaveLength(0);
  });

  it('a room name that is not a valid name stops the loop at that step', async () => {
    agentPlansFixture.rows().splice(0, agentPlansFixture.rows().length, { id: 'p', keywords: [], summary: 'S', steps: [
      { kind: 'meeting:create', title: '!!!', instruction: '', acceptance: 'A meeting is open.' }] });
    const started = await start('u-sana'); await settle();
    await approve('u-sana', started.body.runId); await settle();
    const got = (await status('u-sana', started.body.runId)).body;
    expect(got).toMatchObject({ stage: 'stopped', error: expect.stringContaining('400') });
    expect(socialRoomsFixture.rows().filter(r => r.createdBy === 'u-sana')).toHaveLength(0);
  });
});

afterAll(() => { gatewayUploadBackend(); fs.rmSync(process.env['GATEWAY_UPLOAD_DIR']!, { recursive: true, force: true }); });
