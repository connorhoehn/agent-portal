// "0 documents" on the page whose job is to find empty knowledge bases.
//
// `documentCounts()` caught its Aurora read and returned `{}`, and the caller
// then wrote `documentCount: docs[slug] ?? 0`. So an unreadable `documents`
// table became a confident **0** on every row — on the one surface an operator
// opens precisely to find out whether a knowledge base is holding what it
// claims to hold. The failure and the finding were the same number.
//
// `documentCount` is already `number | null` on the wire, so the honest answer
// costs nothing: null, plus a sentence in the `problem` field this provider
// already has. routes/kb-admin.ts passes the whole envelope through with
// `res.json(await reconcileKnowledgeBases())`, so it reaches the wire with no
// route change — which is why this test lives at the provider.

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

const REGISTRY_ROW = {
  id: 'kb-row-1', slug: 'default', name: 'OrgIQ KB', tenant: 'orgiq',
  bedrock_kb_id: 'KB123', status: 'ACTIVE',
};

/**
 * Aurora answers the registry read, then whatever `documents` should do.
 * Order matters: `reconcileKnowledgeBases` reads the registry first.
 */
function aurora(opts: { documents: 'ok' | 'fails' }): void {
  exec.mockReset();
  exec
    .mockResolvedValueOnce([REGISTRY_ROW])
    .mockImplementationOnce(async () => {
      if (opts.documents === 'fails') throw new Error('relation "documents" does not exist');
      return [{ slug: 'default', n: 6 }];
    });
}

beforeEach(() => {
  send.mockReset();
  // The live account: one knowledge base, matching the registry row, with a
  // data source and a completed sync — so nothing else on the row is degraded
  // and the document count is the only thing under test.
  send.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
    if ('maxResults' in (cmd.input ?? {}) && !('knowledgeBaseId' in (cmd.input ?? {}))) {
      return { knowledgeBaseSummaries: [{ knowledgeBaseId: 'KB123', name: 'OrgIQ KB', status: 'ACTIVE' }] };
    }
    if ('dataSourceId' in (cmd.input ?? {})) {
      return { ingestionJobSummaries: [{ status: 'COMPLETE', updatedAt: new Date(0), statistics: {} }] };
    }
    return { dataSourceSummaries: [{ dataSourceId: 'DS1' }] };
  });
});

describe('reconcileKnowledgeBases — the document count', () => {
  it('reports a real count, and no problem', async () => {
    aurora({ documents: 'ok' });
    const out = await reconcileKnowledgeBases();
    expect(out.entries[0]!.documentCount).toBe(6);
    expect(out.problem).toBeUndefined();
  });

  it('reports NULL, not 0, when the documents table could not be read', async () => {
    aurora({ documents: 'fails' });
    const out = await reconcileKnowledgeBases();
    expect(out.entries[0]!.documentCount).toBeNull();
    expect(out.problem).toMatch(/document counts unavailable/);
  });

  it('still reconciles everything else — a failed count is not a failed page', async () => {
    // The whole reason this degrades rather than throws: the drift verdict,
    // which is what the page is for, is unaffected by not being able to count.
    aurora({ documents: 'fails' });
    const out = await reconcileKnowledgeBases();
    expect(out.entries[0]!.drift).toBe('ok');
    expect(out.entries[0]!.liveKbId).toBe('KB123');
  });

  it('a knowledge base with genuinely zero documents still reads 0', async () => {
    // The other half. If a failed count and a real zero both became null, the
    // marker would be just as useless in the opposite direction.
    exec.mockReset();
    exec.mockResolvedValueOnce([REGISTRY_ROW]).mockResolvedValueOnce([]);
    const out = await reconcileKnowledgeBases();
    expect(out.entries[0]!.documentCount).toBe(0);
    expect(out.problem).toBeUndefined();
  });
});
