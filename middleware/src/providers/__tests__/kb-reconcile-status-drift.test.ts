// The registry can drift stuck, not just stuck wrong.
//
// `resolve_kb_id` (agents/_shared/kb_resolver.py) resolves a knowledge base
// with `WHERE status = 'ACTIVE'` — the registry row's OWN status column, not
// whether a matching Bedrock knowledge base exists. A row that names a real,
// healthy knowledge base but whose own `status` never advanced past PENDING
// (the provisioning callback that flips it never ran, or ran against the
// wrong row) is therefore invisible to every agent, which falls through to
// the `KB_ID` env var — usually still pointing somewhere that works, so
// nothing on the surface looks broken (see CLAUDE.md's KB registry gotcha).
//
// The reconcile pass already caught the mirror case — registry says ACTIVE,
// the account disagrees — but fell through every `if` to `drift: 'ok'` for
// this one: registryKbId set, a live match found, registryStatus something
// other than ACTIVE, and the first status check (`registryStatus === 'ACTIVE'`)
// never fires because it isn't. This is the direction that actually bites.

const send = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send = (...a: unknown[]) => send(...a); },
  ListKnowledgeBasesCommand: class { constructor(public readonly input: unknown) {} },
  GetKnowledgeBaseCommand: class { constructor(public readonly input: unknown) {} },
  ListDataSourcesCommand: class { constructor(public readonly input: unknown) {} },
  ListIngestionJobsCommand: class { constructor(public readonly input: unknown) {} },
}));

const exec = jest.fn();
jest.mock('../aurora.js', () => ({ exec: (...a: unknown[]) => exec(...a) }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { reconcileKnowledgeBases } from '../kb-reconcile.js';

function account(): void {
  send.mockReset();
  send.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
    const input = cmd.input ?? {};
    if (!('knowledgeBaseId' in input)) {
      return { knowledgeBaseSummaries: [{ knowledgeBaseId: 'KB123', name: 'OrgIQ KB', status: 'ACTIVE' }] };
    }
    if ('dataSourceId' in input) return { ingestionJobSummaries: [] };
    return { dataSourceSummaries: [{ dataSourceId: 'DS1' }] };
  });
}

function registryRow(status: string) {
  return { id: 'kb-row-1', slug: 'default', name: 'OrgIQ KB', tenant: 'orgiq', bedrock_kb_id: 'KB123', status };
}

beforeEach(() => { exec.mockReset(); });

describe('reconcileKnowledgeBases — the registry stuck behind a healthy account', () => {
  it('flags a PENDING row whose knowledge base is actually ACTIVE, instead of reporting ok', async () => {
    exec.mockResolvedValueOnce([registryRow('PENDING')]).mockResolvedValueOnce([{ slug: 'default', n: 0 }]);
    account();
    const e = (await reconcileKnowledgeBases()).entries[0]!;
    expect(e.drift).toBe('status-drift');
    expect(e.detail).toMatch(/account reports ACTIVE/);
    expect(e.detail).toMatch(/PENDING/);
    expect(e.detail).toMatch(/status = ACTIVE/);
  });

  it('still flags CREATING and UPDATING the same way — any non-ACTIVE row against a live ACTIVE account', async () => {
    for (const status of ['CREATING', 'UPDATING']) {
      exec.mockReset();
      exec.mockResolvedValueOnce([registryRow(status)]).mockResolvedValueOnce([{ slug: 'default', n: 0 }]);
      account();
      const e = (await reconcileKnowledgeBases()).entries[0]!;
      expect(e.drift).toBe('status-drift');
    }
  });

  it('does not flag a row whose status genuinely matches the account', async () => {
    exec.mockResolvedValueOnce([registryRow('ACTIVE')]).mockResolvedValueOnce([{ slug: 'default', n: 0 }]);
    account();
    const e = (await reconcileKnowledgeBases()).entries[0]!;
    expect(e.drift).toBe('ok');
  });
});
