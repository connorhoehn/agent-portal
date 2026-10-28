// DE-3: the BFF's reader for the central model registry. Offline it reads the
// checked-in file and never calls SSM; online it reads the parameter (pinned
// when asked) and falls back to the caller's literal on any failure.

const mockMock = { agentcore: true };
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: mockMock },
}));

const mockSend = jest.fn();
jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getModelRegistry,
  isAllowedModelId,
  modelChainForRole,
  modelForRole,
  resetModelRegistryCache,
  stripInferenceProfilePrefix,
  validateModelRegistry,
} from '../model-registry.js';

const REPO_FILE = resolve(__dirname, '..', '..', '..', '..', 'infra', 'config', 'model-registry.json');
const checkedIn = JSON.parse(readFileSync(REPO_FILE, 'utf8'));

beforeEach(() => {
  resetModelRegistryCache();
  mockSend.mockReset();
  mockMock.agentcore = true;
  process.env.MODEL_REGISTRY_FILE = REPO_FILE;
  delete process.env.MODEL_REGISTRY_PARAM;
  delete process.env.MODEL_REGISTRY_VERSION;
});

afterAll(() => {
  delete process.env.MODEL_REGISTRY_FILE;
});

describe('offline', () => {
  it('reads the checked-in file and never calls SSM', async () => {
    process.env.MODEL_REGISTRY_PARAM = '/orgiq/models/registry';
    const got = await getModelRegistry();
    expect(got.source).toBe('file');
    expect(got.registry).toEqual(checkedIn);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('answers a role from the file and the literal for an unknown role', async () => {
    expect(await modelForRole('eval-judge', 'x')).toBe(checkedIn.roles['eval-judge'].primary);
    expect(await modelForRole('no-such-role', 'amazon.nova-micro-v1:0')).toBe('amazon.nova-micro-v1:0');
    expect(await modelChainForRole('supervisor', 'x')).toEqual(
      [checkedIn.roles.supervisor.primary, ...checkedIn.roles.supervisor.fallbacks],
    );
  });
});

describe('online', () => {
  beforeEach(() => {
    mockMock.agentcore = false;
    process.env.MODEL_REGISTRY_PARAM = '/orgiq/models/registry';
  });

  it('reads the parameter, honouring a version pin', async () => {
    process.env.MODEL_REGISTRY_VERSION = '3';
    mockSend.mockResolvedValue({ Parameter: { Value: JSON.stringify(checkedIn), Version: 3 } });
    const got = await getModelRegistry();
    expect(mockSend.mock.calls[0][0].input).toEqual({ Name: '/orgiq/models/registry:3' });
    expect(got).toMatchObject({ source: 'ssm', version: '3' });
  });

  it('falls back to the literal when SSM fails', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await modelForRole('search', 'amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
    warn.mockRestore();
  });

  it('refuses a registry naming a non-AWS-native model', async () => {
    const bad = structuredClone(checkedIn);
    bad.roles.search.primary = 'anthropic.claude-3-5-sonnet-20240620-v1:0';
    mockSend.mockResolvedValue({ Parameter: { Value: JSON.stringify(bad), Version: 9 } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await modelForRole('search', 'amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
    warn.mockRestore();
  });
});

describe('validation and normalisation', () => {
  it('rejects non-AWS ids and a widened allow list', () => {
    expect(() => validateModelRegistry(checkedIn)).not.toThrow();
    const widened = { ...checkedIn, allow: [...checkedIn.allow, 'anthropic.'] };
    expect(() => validateModelRegistry(widened)).toThrow(/widens/);
    expect(isAllowedModelId('us.amazon.nova-pro-v1:0')).toBe(true);
    expect(isAllowedModelId('us.anthropic.claude-sonnet-4')).toBe(false);
  });

  it('strips the cross-region profile prefix for price lookups', () => {
    expect(stripInferenceProfilePrefix('us.amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
    expect(stripInferenceProfilePrefix('apac.amazon.nova-lite-v1:0')).toBe('amazon.nova-lite-v1:0');
    expect(stripInferenceProfilePrefix('amazon.nova-pro-v1:0')).toBe('amazon.nova-pro-v1:0');
  });
});
