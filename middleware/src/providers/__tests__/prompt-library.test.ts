// prompt-library.ts merges two sources that each know half the catalog:
// Bedrock Prompt Management (template/version, no type info) and Aurora's
// observability.prompt_version_meta (kind/tier/contract/owner/eval, keyed
// on prompt_id+version). These tests pin:
//   - mock mode is untouched and never talks to either live source
//   - a live merge pulls kind/tier/contract/owner/evalPassRate from Aurora
//   - a prompt with no Aurora row gets the documented name-based defaults
//   - ListPrompts pagination actually walks every page (the documented
//     "un-paginated call silently misses prompts" gotcha)
//   - each source degrades independently when the other is unreachable
//   - filters/facets still work over the merged set

const mockFlag = { aurora: false };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.aurora }; },
    region: 'us-east-1',
  },
}));

const bedrockSend = jest.fn();

jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send(cmd: unknown) { return bedrockSend(cmd); } },
  ListPromptsCommand: class { constructor(public input: Record<string, unknown>) {} },
}));

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import { exec } from '../aurora.js';
import { listAssets, getAsset, relatedAssets } from '../prompt-library.js';

const auroraExec = exec as unknown as jest.Mock;

beforeEach(() => {
  mockFlag.aurora = false;
  bedrockSend.mockReset();
  auroraExec.mockReset();
  auroraExec.mockResolvedValue([]); // no meta rows unless a test overrides
});

// ─── helpers ──────────────────────────────────────────────────────────────

function promptSummary(over: Record<string, unknown> = {}) {
  return {
    id: 'lib-custom-prompt',
    arn: 'arn:aws:bedrock:us-east-1:1:prompt/lib-custom-prompt',
    name: 'Custom Prompt',
    description: 'from bedrock',
    version: '2',
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  };
}

function onePage(promptSummaries: unknown[], nextToken?: string) {
  return Promise.resolve({ promptSummaries, ...(nextToken ? { nextToken } : {}) });
}

function metaRow(over: Record<string, unknown> = {}) {
  return {
    prompt_id: 'lib-custom-prompt',
    version: '2',
    kind: 'evaluator',
    tier: 'endpoint',
    contract: JSON.stringify({
      kind: 'evaluator', tier: 'endpoint',
      variables: [{ name: 'x', type: 'text', required: true, source: 'caller' }],
      guardrailId: 'gr-1',
    }),
    owner_email: 'owner@example.com',
    eval_pass_rate: 0.87,
    description: 'meta desc',
    lifecycle_status: 'deployed',
    published_at: '2026-08-01T00:00:00Z',
    ...over,
  };
}

// ─── mock mode ────────────────────────────────────────────────────────────

describe('mock mode', () => {
  it('returns the fixtures untouched and never calls Bedrock or Aurora', async () => {
    mockFlag.aurora = true;
    const { assets, total } = await listAssets();
    expect(total).toBeGreaterThan(5);
    expect(assets.some((a) => a.id === 'orgiq-supervisor-system-prompt')).toBe(true);
    expect(bedrockSend).not.toHaveBeenCalled();
    expect(auroraExec).not.toHaveBeenCalled();
  });

  it('getAsset returns a fixture by id untouched', async () => {
    mockFlag.aurora = true;
    const asset = await getAsset('orgiq-search-system-prompt');
    expect(asset?.name).toBe('Search · system prompt');
    expect(asset?.evalPassRate).toBe(0.91);
    expect(bedrockSend).not.toHaveBeenCalled();
  });
});

// ─── live merge ───────────────────────────────────────────────────────────

describe('live mode — merge', () => {
  it('merges a Bedrock prompt with its Aurora meta row', async () => {
    bedrockSend.mockReturnValueOnce(onePage([promptSummary()]));
    auroraExec.mockResolvedValueOnce([metaRow()]);

    const asset = await getAsset('lib-custom-prompt');
    expect(asset).not.toBeNull();
    expect(asset?.kind).toBe('evaluator');
    expect(asset?.tier).toBe('endpoint');
    expect(asset?.ownerName).toBe('owner@example.com');
    expect(asset?.evalPassRate).toBe(0.87);
    expect(asset?.lifecycleStatus).toBe('deployed');
    expect(asset?.contract.variables).toHaveLength(1);
    expect(asset?.contract.guardrailId).toBe('gr-1');
    // Aurora's description wins over Bedrock's when both exist.
    expect(asset?.description).toBe('meta desc');
  });

  it('a system-named prompt with no Aurora row gets kind system, tier sandbox, and the agent as usedBy', async () => {
    bedrockSend.mockReturnValueOnce(onePage([
      promptSummary({ id: 'orgiq-search-system-prompt', name: 'Search · system prompt', version: '4' }),
    ]));
    auroraExec.mockResolvedValueOnce([]);

    const asset = await getAsset('orgiq-search-system-prompt');
    expect(asset?.kind).toBe('system');
    expect(asset?.tier).toBe('sandbox');
    expect(asset?.ownerName).toBeNull();
    expect(asset?.evalPassRate).toBeNull();
    expect(asset?.contract.variables).toEqual([]);
    expect(asset?.usedBy).toEqual(['orgiq-search']);
  });

  it('a non-system-named prompt with no Aurora row defaults to kind prompt with no usedBy', async () => {
    bedrockSend.mockReturnValueOnce(onePage([promptSummary({ id: 'lib-standalone', name: 'Standalone' })]));
    auroraExec.mockResolvedValueOnce([]);

    const asset = await getAsset('lib-standalone');
    expect(asset?.kind).toBe('prompt');
    expect(asset?.usedBy).toEqual([]);
  });

  it('walks every ListPrompts page — a two-page response returns prompts from both pages', async () => {
    bedrockSend
      .mockReturnValueOnce(onePage([promptSummary({ id: 'lib-page-1' })], 'token-2'))
      .mockReturnValueOnce(onePage([promptSummary({ id: 'lib-page-2' })]));

    const { assets } = await listAssets();
    const ids = assets.map((a) => a.id);
    expect(ids).toContain('lib-page-1');
    expect(ids).toContain('lib-page-2');
    expect(bedrockSend).toHaveBeenCalledTimes(2);
  });
});

// ─── independent degrade paths ────────────────────────────────────────────

describe('live mode — degrade', () => {
  it('Bedrock throwing still returns Aurora-derived assets', async () => {
    bedrockSend.mockRejectedValueOnce(new Error('AccessDeniedException'));
    auroraExec.mockResolvedValueOnce([
      metaRow({ prompt_id: 'lib-a' }),
      metaRow({ prompt_id: 'lib-b', kind: 'evaluator', tier: 'internal' }),
    ]);

    const { assets } = await listAssets();
    const ids = assets.map((a) => a.id).sort();
    expect(ids).toEqual(['lib-a', 'lib-b']);
    const b = assets.find((a) => a.id === 'lib-b');
    expect(b?.kind).toBe('evaluator');
    expect(b?.tier).toBe('internal');
  });

  it('Aurora throwing still returns Bedrock-derived assets with defaults', async () => {
    bedrockSend.mockReturnValueOnce(onePage([promptSummary({ id: 'lib-live-only' })]));
    auroraExec.mockRejectedValueOnce(new Error('relation "observability.prompt_version_meta" does not exist'));

    const asset = await getAsset('lib-live-only');
    expect(asset).not.toBeNull();
    expect(asset?.kind).toBe('prompt');
    expect(asset?.tier).toBe('sandbox');
    expect(asset?.ownerName).toBeNull();
  });
});

// ─── filters / facets over merged data ─────────────────────────────────────

describe('live mode — filters and facets over merged data', () => {
  it('kind filter narrows to the matching kind', async () => {
    bedrockSend.mockReturnValueOnce(onePage([
      promptSummary({ id: 'lib-eval-1', name: 'CSRF evaluator', version: '1' }),
      promptSummary({ id: 'orgiq-advisor-system-prompt', name: 'Advisor · system prompt', version: '1' }),
    ]));
    auroraExec.mockResolvedValueOnce([metaRow({ prompt_id: 'lib-eval-1', kind: 'evaluator', tier: 'endpoint' })]);

    const { assets } = await listAssets({ kind: 'evaluator' });
    expect(assets.map((a) => a.id)).toEqual(['lib-eval-1']);
  });

  it('tier filter narrows to the matching tier', async () => {
    bedrockSend.mockReturnValueOnce(onePage([
      promptSummary({ id: 'lib-eval-1', name: 'CSRF evaluator', version: '1' }),
      promptSummary({ id: 'orgiq-advisor-system-prompt', name: 'Advisor · system prompt', version: '1' }),
    ]));
    auroraExec.mockResolvedValueOnce([metaRow({ prompt_id: 'lib-eval-1', kind: 'evaluator', tier: 'endpoint' })]);

    const { assets } = await listAssets({ tier: 'endpoint' });
    expect(assets.map((a) => a.id)).toEqual(['lib-eval-1']);
  });

  it('text search matches name and description', async () => {
    bedrockSend.mockReturnValueOnce(onePage([
      promptSummary({ id: 'lib-eval-1', name: 'CSRF evaluator', description: 'checks csrf risk', version: '1' }),
      promptSummary({ id: 'orgiq-advisor-system-prompt', name: 'Advisor · system prompt', description: 'advises', version: '1' }),
    ]));
    auroraExec.mockResolvedValueOnce([]);

    const { assets } = await listAssets({ q: 'csrf' });
    expect(assets.map((a) => a.id)).toEqual(['lib-eval-1']);
  });

  it('facets count the whole merged catalog, not the filtered slice', async () => {
    bedrockSend.mockReturnValueOnce(onePage([
      promptSummary({ id: 'lib-eval-1', name: 'CSRF evaluator', version: '1' }),
      promptSummary({ id: 'orgiq-advisor-system-prompt', name: 'Advisor · system prompt', version: '1' }),
    ]));
    auroraExec.mockResolvedValueOnce([metaRow({ prompt_id: 'lib-eval-1', kind: 'evaluator', tier: 'endpoint' })]);

    const { facets, assets } = await listAssets({ kind: 'evaluator' });
    expect(assets).toHaveLength(1);
    expect(facets.kind['evaluator']).toBe(1);
    expect(facets.kind['system']).toBe(1); // orgiq-advisor-system-prompt, inferred
  });
});

describe('relatedAssets over live data', () => {
  it('returns neighbours by shared kind without throwing when the asset is live-sourced', async () => {
    bedrockSend.mockReturnValueOnce(onePage([
      promptSummary({ id: 'lib-eval-1', name: 'CSRF evaluator', version: '1' }),
      promptSummary({ id: 'lib-eval-2', name: 'PII evaluator', version: '1' }),
    ]));
    auroraExec.mockResolvedValueOnce([
      metaRow({ prompt_id: 'lib-eval-1', kind: 'evaluator' }),
      metaRow({ prompt_id: 'lib-eval-2', kind: 'evaluator' }),
    ]);

    const related = await relatedAssets('lib-eval-1');
    expect(related.some((r) => r.asset.id === 'lib-eval-2')).toBe(true);
  });
});
