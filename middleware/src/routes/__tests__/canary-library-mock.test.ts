// Prompt Studio's list/versions/version-detail routes (routes/canary-library.ts)
// under MOCK_AURORA (dev:mock).
//
// Every GET on this router used to call Bedrock unconditionally, so offline
// dev 503'd with `{"error":"Bedrock unavailable","detail":"…"}"` on every
// load — which PromptsPage.tsx then rendered as raw JSON alongside its own
// "No prompts yet" empty state at the same time (DEFECTS.md #8). This pins:
// dev:mock serves the fixture in mock/canary-library.ts instead of ever
// constructing a BedrockAgentClient, so Prompt Studio always has a
// real-looking library to browse offline.

const mockFlag = { value: true };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.value, agentcore: true, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

const listPromptsMock = jest.fn();
const getPromptMock = jest.fn();

jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({
    send: (cmd: unknown) => {
      // Route by constructor name so both commands share one client mock.
      const name = (cmd as { constructor: { name: string } }).constructor.name;
      if (name === 'ListPromptsCommand') return listPromptsMock(cmd);
      if (name === 'GetPromptCommand') return getPromptMock(cmd);
      return Promise.reject(new Error(`unexpected command ${name}`));
    },
  })),
  ListPromptsCommand: jest.fn().mockImplementation((input) => ({ constructor: { name: 'ListPromptsCommand' }, input })),
  GetPromptCommand: jest.fn().mockImplementation((input) => ({ constructor: { name: 'GetPromptCommand' }, input })),
  UpdatePromptCommand: jest.fn(),
  CreatePromptCommand: jest.fn(),
  CreatePromptVersionCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(),
  ConverseStreamCommand: jest.fn(),
}));

jest.mock('@aws-sdk/client-bedrock-agent-runtime', () => ({
  BedrockAgentRuntimeClient: jest.fn(),
  OptimizePromptCommand: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { canaryLibraryRouter } from '../canary-library.js';
import { errorHandler } from '../../lib/async-handler.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { role: 'admin', tenant: 'orgiq', sub: 'u-1' }; next(); });
  app.use('/api/observability/canary', canaryLibraryRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockFlag.value = true;
  listPromptsMock.mockReset();
  getPromptMock.mockReset();
});

describe('GET /library (mock)', () => {
  it('serves the mock library without ever calling Bedrock', async () => {
    const res = await request(buildApp()).get('/api/observability/canary/library');
    expect(res.status).toBe(200);
    expect(listPromptsMock).not.toHaveBeenCalled();
    expect(Array.isArray(res.body.prompts)).toBe(true);
    // One system prompt per deployed agent — matches CLAUDE.md's six OrgIQ
    // agents (the assessment scorer/drafter are a separate tenant).
    expect(res.body.prompts.length).toBeGreaterThanOrEqual(6);
    for (const p of res.body.prompts) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(p.version).toBe('DRAFT');
    }
  });
});

describe('GET /library/:promptId/versions (mock)', () => {
  it('returns a DRAFT version for a known mock prompt', async () => {
    const list = await request(buildApp()).get('/api/observability/canary/library');
    const promptId = list.body.prompts[0].id as string;

    const res = await request(buildApp()).get(`/api/observability/canary/library/${promptId}/versions`);
    expect(res.status).toBe(200);
    expect(listPromptsMock).not.toHaveBeenCalled();
    expect(res.body.versions.length).toBeGreaterThanOrEqual(1);
    expect(res.body.versions[0].version).toBe('DRAFT');
    expect(res.body.versions[0].isDraft).toBe(true);
  });

  it('404s for an unknown prompt id rather than leaking a Bedrock error', async () => {
    const res = await request(buildApp()).get('/api/observability/canary/library/does-not-exist/versions');
    expect(res.status).toBe(404);
  });
});

describe('GET /library/:promptId/version/:version (mock)', () => {
  it('returns real template text for the DRAFT version', async () => {
    const list = await request(buildApp()).get('/api/observability/canary/library');
    const promptId = list.body.prompts[0].id as string;

    const res = await request(buildApp()).get(`/api/observability/canary/library/${promptId}/version/DRAFT`);
    expect(res.status).toBe(200);
    expect(getPromptMock).not.toHaveBeenCalled();
    expect(res.body.variant.templateText.length).toBeGreaterThan(0);
    expect(res.body.variant.modelId).toBe('amazon.nova-pro-v1:0');
  });
});
