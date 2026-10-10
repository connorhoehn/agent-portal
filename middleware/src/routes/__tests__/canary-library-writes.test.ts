// Prompt Studio's write and run routes (routes/canary-library.ts) under
// MOCK_AURORA, with the REAL ManageCanary gate in front of them.
//
// canary-library-mock.test.ts covers the ungated reads. These five routes all
// sit behind requireAction('ManageCanary') — create, save draft, publish,
// invoke, optimize — and offline each answers from the registered
// `canary-prompt-library` fixture (or, for optimize, refuses honestly). So
// each is pinned on: anonymous 401 / member 403 with the fixture unmoved,
// body validation, unknown-id 404, and a write that a following read can see.
//
// Cognito is configured so the dev demo-user fallback is off and a request
// with no session is genuinely anonymous.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
    auth: { policyStoreId: undefined },
    cognito: {
      userPoolId: 'us-east-1_test', clientId: 'cid', clientSecret: 'csec',
      domain: 'example.auth', callbackUrl: 'http://localhost/cb',
    },
  },
}));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'org-leader', tenant: 'orgiq', label: 'Org Leader', summary: '',
      capabilities: ['ViewObservability', 'ManageCanary'] },
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '',
      capabilities: ['ViewObservability'] },
  ],
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

// The contract lookup on invoke is the one Data API read on this router with
// no mock branch of its own; it degrades to the empty contract on any failure.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn(async () => []) }));

// Offline, no Bedrock client may ever be sent a command.
const bedrockSend = jest.fn(() => Promise.reject(new Error('Bedrock reached offline')));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({ send: bedrockSend })),
  ListPromptsCommand: jest.fn(), GetPromptCommand: jest.fn(), UpdatePromptCommand: jest.fn(),
  CreatePromptCommand: jest.fn(), CreatePromptVersionCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn().mockImplementation(() => ({ send: bedrockSend })),
  ConverseStreamCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: jest.fn().mockImplementation(() => ({ send: bedrockSend })),
  OptimizePromptCommand: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { canaryLibraryRouter } from '../canary-library.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { fixtureRegistry } from '../../mock/core/fixture.js';
import { findMockPrompt, promptLibrary } from '../../mock/canary-library.js';
import { OFFLINE_RENDER_NOTICE, OFFLINE_OPTIMIZE_REFUSAL } from '../../mock/prompt-studio.js';
import type { Session } from '../../lib/session.js';

const leader: Session = { sub: 'u-lead', role: 'org-leader', tenant: 'orgiq', iat: 0, grants: { orgiq: ['org-leader'] } };
const member: Session = { sub: 'u-mem', role: 'member', tenant: 'orgiq', iat: 0, grants: { orgiq: ['member'] } };

function buildApp(session: Session | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (session) req.session = session; next(); });
  app.use('/api/observability/canary', canaryLibraryRouter);
  app.use(errorHandler);
  return app;
}

/** A seeded prompt whose template asks for {{user_query}}. */
function queryPrompt() {
  const p = promptLibrary.rows().find((x) => x.versions[0]!.variant.templateText.includes('{{user_query}}'));
  if (!p) throw new Error('fixture has no {{user_query}} prompt');
  return p;
}

beforeEach(() => {
  jest.clearAllMocks();
  fixtureRegistry.resetAll();
});
afterAll(() => fixtureRegistry.resetAll());

describe('POST /api/observability/canary/library (create)', () => {
  it('is ManageCanary: anonymous 401, member 403, nothing created', async () => {
    const before = promptLibrary.rows().length;
    expect((await request(buildApp(null)).post('/api/observability/canary/library').send({ name: 'x', template_text: 'y' })).status).toBe(401);
    const denied = await request(buildApp(member)).post('/api/observability/canary/library').send({ name: 'x', template_text: 'y' });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ action: 'ManageCanary' });
    expect(promptLibrary.rows()).toHaveLength(before);
  });

  it('400s a missing name or a blank template', async () => {
    const noName = await request(buildApp(leader)).post('/api/observability/canary/library').send({ template_text: 'Hi {{who}}' });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/name is required/);
    const blank = await request(buildApp(leader)).post('/api/observability/canary/library').send({ name: 'Greeter', template_text: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error).toMatch(/template_text is required/);
  });

  it('creates a DRAFT-only prompt the list and version reads then show, with derived variables and defaults', async () => {
    const res = await request(buildApp(leader)).post('/api/observability/canary/library')
      .send({ name: 'Greeter Prompt', template_text: 'Greet {{who}} in {{lang}}', inference_config: { temperature: 0.2 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: 'mock-greeter-prompt', name: 'Greeter Prompt', version: 'DRAFT' });
    expect(res.body.arn).toMatch(/prompt\/mock-greeter-prompt:DRAFT$/);
    const created = findMockPrompt('mock-greeter-prompt')!;
    expect(created.versions).toHaveLength(1);
    expect(created.versions[0]!.variant).toMatchObject({
      modelId: 'amazon.nova-pro-v1:0', inputVariables: ['who', 'lang'],
      inferenceConfig: { temperature: 0.2, maxTokens: 2048 },
    });
    const list = await request(buildApp(leader)).get('/api/observability/canary/library');
    expect(list.body.prompts.map((p: { id: string }) => p.id)).toContain('mock-greeter-prompt');
    expect(bedrockSend).not.toHaveBeenCalled();
  });
});

describe('PUT /api/observability/canary/library/:promptId/draft', () => {
  it('is ManageCanary: member 403 leaves the draft untouched', async () => {
    const p = queryPrompt();
    const before = p.versions[0]!.variant.templateText;
    expect((await request(buildApp(null)).put(`/api/observability/canary/library/${p.id}/draft`).send({ name: 'n', template_text: 't' })).status).toBe(401);
    expect((await request(buildApp(member)).put(`/api/observability/canary/library/${p.id}/draft`).send({ name: 'n', template_text: 't' })).status).toBe(403);
    expect(findMockPrompt(p.id)!.versions[0]!.variant.templateText).toBe(before);
  });

  it('400s a missing name or template', async () => {
    const p = queryPrompt();
    expect((await request(buildApp(leader)).put(`/api/observability/canary/library/${p.id}/draft`).send({ template_text: 't' })).status).toBe(400);
    expect((await request(buildApp(leader)).put(`/api/observability/canary/library/${p.id}/draft`).send({ name: 'n' })).status).toBe(400);
  });

  it('404s an unknown prompt instead of reporting a save that moved nothing', async () => {
    const res = await request(buildApp(leader)).put('/api/observability/canary/library/no-such-prompt/draft').send({ name: 'n', template_text: 't' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBeUndefined();
  });

  it('saves the draft so the DRAFT version read returns the new text and overrides', async () => {
    const p = queryPrompt();
    const res = await request(buildApp(leader)).put(`/api/observability/canary/library/${p.id}/draft`)
      .send({ name: 'Renamed', template_text: 'Answer {{question}} briefly', model_id: 'amazon.nova-lite-v1:0', inference_config: { maxTokens: 512 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: 'DRAFT' });
    const read = await request(buildApp(leader)).get(`/api/observability/canary/library/${p.id}/version/DRAFT`);
    expect(read.body.variant).toMatchObject({ templateText: 'Answer {{question}} briefly', modelId: 'amazon.nova-lite-v1:0' });
    expect(findMockPrompt(p.id)!.name).toBe('Renamed');
    expect(findMockPrompt(p.id)!.versions[0]!.variant.inferenceConfig.maxTokens).toBe(512);
  });
});

describe('POST /api/observability/canary/library/:promptId/publish', () => {
  it('is ManageCanary: member 403 freezes nothing', async () => {
    const p = queryPrompt();
    const before = p.versions.length;
    expect((await request(buildApp(null)).post(`/api/observability/canary/library/${p.id}/publish`).send({})).status).toBe(401);
    expect((await request(buildApp(member)).post(`/api/observability/canary/library/${p.id}/publish`).send({})).status).toBe(403);
    expect(findMockPrompt(p.id)!.versions).toHaveLength(before);
  });

  it('404s an unknown prompt', async () => {
    expect((await request(buildApp(leader)).post('/api/observability/canary/library/no-such-prompt/publish').send({})).status).toBe(404);
  });

  it('freezes the current DRAFT as the next numbered version; later draft edits do not change it', async () => {
    const p = queryPrompt();
    const draftText = p.versions[0]!.variant.templateText;
    const first = await request(buildApp(leader)).post(`/api/observability/canary/library/${p.id}/publish`).send({ description: 'v1 cut' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, version: '1' });
    expect(first.body.arn).toMatch(new RegExp(`prompt/${p.id}:1$`));
    const second = await request(buildApp(leader)).post(`/api/observability/canary/library/${p.id}/publish`).send({});
    expect(second.body.version).toBe('2');

    await request(buildApp(leader)).put(`/api/observability/canary/library/${p.id}/draft`).send({ name: p.name, template_text: 'changed after publish' });
    const v1 = await request(buildApp(leader)).get(`/api/observability/canary/library/${p.id}/version/1`);
    expect(v1.status).toBe(200);
    expect(v1.body.variant.templateText).toBe(draftText);
  });
});

describe('POST /api/observability/canary/library/:promptId/invoke', () => {
  it('is ManageCanary: anonymous 401, member 403', async () => {
    const p = queryPrompt();
    expect((await request(buildApp(null)).post(`/api/observability/canary/library/${p.id}/invoke`).send({})).status).toBe(401);
    expect((await request(buildApp(member)).post(`/api/observability/canary/library/${p.id}/invoke`).send({})).status).toBe(403);
    expect(exec).not.toHaveBeenCalled();
  });

  it('400s values that fail the stored contract, naming each issue, before anything renders', async () => {
    const p = queryPrompt();
    jest.mocked(exec).mockResolvedValueOnce([{ contract: JSON.stringify({
      kind: 'prompt', tier: 'sandbox',
      variables: [{ name: 'user_query', type: 'text', required: true, source: 'caller' }],
    }) }]);
    const res = await request(buildApp(leader)).post(`/api/observability/canary/library/${p.id}/invoke`).send({ variables: {} });
    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual([{ name: 'user_query', problem: 'required, but no value was supplied' }]);
  });

  it('streams the template rendered with the variables, labelled as an offline render, then done', async () => {
    const p = queryPrompt();
    const res = await request(buildApp(leader)).post(`/api/observability/canary/library/${p.id}/invoke`)
      .send({ variables: { user_query: 'Who knows Kubernetes?', ignored: 42 } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l) as { text?: string; done?: boolean });
    expect(frames.at(-1)).toEqual({ done: true });
    const text = frames.map((f) => f.text ?? '').join('');
    expect(text.startsWith(OFFLINE_RENDER_NOTICE)).toBe(true);
    expect(text).toContain('Who knows Kubernetes?');
    expect(text).not.toContain('{{user_query}}');
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it('503s an unknown prompt or version rather than streaming an invented answer', async () => {
    const p = queryPrompt();
    const unknown = await request(buildApp(leader)).post('/api/observability/canary/library/no-such-prompt/invoke').send({});
    expect(unknown.status).toBe(503);
    const badVersion = await request(buildApp(leader)).post(`/api/observability/canary/library/${p.id}/invoke`).send({ version: '99' });
    expect(badVersion.status).toBe(503);
    expect(badVersion.body.detail).toContain('"99"');
  });
});

describe('POST /api/observability/canary/library/:promptId/optimize', () => {
  it('is ManageCanary: anonymous 401, member 403', async () => {
    const p = queryPrompt();
    expect((await request(buildApp(null)).post(`/api/observability/canary/library/${p.id}/optimize`).send({ templateText: 'x' })).status).toBe(401);
    expect((await request(buildApp(member)).post(`/api/observability/canary/library/${p.id}/optimize`).send({ templateText: 'x' })).status).toBe(403);
  });

  it('400s a blank template', async () => {
    const p = queryPrompt();
    const res = await request(buildApp(leader)).post(`/api/observability/canary/library/${p.id}/optimize`).send({ templateText: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/templateText is required/);
  });

  it('refuses offline with 503 rather than returning the input as an "optimized" rewrite', async () => {
    const p = queryPrompt();
    const res = await request(buildApp(leader)).post(`/api/observability/canary/library/${p.id}/optimize`).send({ templateText: 'Make me better' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Bedrock unavailable', detail: OFFLINE_OPTIMIZE_REFUSAL });
    expect(res.body.optimizedText).toBeUndefined();
    expect(bedrockSend).not.toHaveBeenCalled();
  });
});
