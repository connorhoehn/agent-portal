// "No data source attached. Never indexed." — about a knowledge base holding
// 157 documents behind an AVAILABLE data source with two COMPLETE sync jobs.
//
// `syncState` wrapped BOTH Bedrock reads in one try/catch that returned four
// bare nulls. On the deployed ECS middleware the task role held
// `bedrock:ListDataSources` but not `bedrock:ListIngestionJobs`, so the first
// call succeeded, the second threw AccessDenied, and the catch threw away the
// data source count it had already read along with the history it hadn't. The
// reconcile page then reported the *vaguer, wronger* of two facts — "there is
// no data source" instead of "we cannot read the sync history" — offered a Sync
// button that needed a third ungranted action, and named no permission
// anywhere. Nothing logged. The reason sat in the discarded exception.
//
// Two properties are under test, and they are the two halves of the same rule:
// a failed read must not erase a successful one, and a failure must say so.
// The IAM half is fixed in infra/lib/middleware-service-stack.ts; this is the
// half that makes the next missing permission diagnose itself instead of
// rendering as a confident lie.

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

/** The real AccessDenied shape, so the assertion is about a real failure. */
function accessDenied(action: string): Error {
  return new Error(
    `User: arn:aws:sts::647757222309:assumed-role/orgiq-middleware-task-role/x ` +
    `is not authorized to perform: ${action} because no identity-based policy ` +
    `allows the ${action} action`,
  );
}

/**
 * The live account. `dataSources` and `jobs` fail independently — which is the
 * whole point: the deployed failure was exactly one of them.
 */
function account(opts: {
  dataSources: 'ok' | 'none' | 'denied';
  jobs: 'ok' | 'denied';
}): void {
  send.mockReset();
  send.mockImplementation(async (cmd: { input?: Record<string, unknown> }) => {
    const input = cmd.input ?? {};
    // ListKnowledgeBases — the only call with no knowledgeBaseId.
    if (!('knowledgeBaseId' in input)) {
      return { knowledgeBaseSummaries: [{ knowledgeBaseId: 'KB123', name: 'OrgIQ KB', status: 'ACTIVE' }] };
    }
    // ListIngestionJobs — the only call carrying a dataSourceId.
    if ('dataSourceId' in input) {
      if (opts.jobs === 'denied') throw accessDenied('bedrock:ListIngestionJobs');
      return {
        ingestionJobSummaries: [{
          status: 'COMPLETE',
          updatedAt: new Date('2026-09-11T14:12:58.321Z'),
          statistics: { numberOfDocumentsScanned: 157 },
        }],
      };
    }
    // ListDataSources.
    if (opts.dataSources === 'denied') throw accessDenied('bedrock:ListDataSources');
    if (opts.dataSources === 'none') return { dataSourceSummaries: [] };
    return { dataSourceSummaries: [{ dataSourceId: 'MPN4OWT61U' }] };
  });
}

beforeEach(() => {
  exec.mockReset();
  exec
    .mockResolvedValueOnce([REGISTRY_ROW])            // the registry read
    .mockResolvedValueOnce([{ slug: 'default', n: 157 }]);  // document counts
});

describe('reconcileKnowledgeBases — sync state', () => {
  it('reports the newest job when both reads land', async () => {
    account({ dataSources: 'ok', jobs: 'ok' });
    const e = (await reconcileKnowledgeBases()).entries[0]!;
    expect(e.dataSourceCount).toBe(1);
    expect(e.lastSyncStatus).toBe('COMPLETE');
    expect(e.lastSyncAt).toBe('2026-09-11T14:12:58.321Z');
    expect(e.lastSyncScanned).toBe(157);
  });

  it('keeps the data source count when the ingestion history is DENIED', async () => {
    // The regression. This is the deployed failure exactly: ListDataSources
    // allowed, ListIngestionJobs denied. Losing `dataSourceCount` here is what
    // made the page say "no data source attached" about a source it had just
    // been told was AVAILABLE.
    account({ dataSources: 'ok', jobs: 'denied' });
    const e = (await reconcileKnowledgeBases()).entries[0]!;
    expect(e.dataSourceCount).toBe(1);
    expect(e.lastSyncStatus).toBeNull();
    expect(e.lastSyncAt).toBeNull();
  });

  it('names the permission it could not use, instead of swallowing it', async () => {
    account({ dataSources: 'ok', jobs: 'denied' });
    const out = await reconcileKnowledgeBases();
    expect(out.problem).toMatch(/ingestion history unreadable/);
    // The operator's actual next action is in the message, not in a log they
    // would have to know to go read.
    expect(out.problem).toMatch(/bedrock:ListIngestionJobs/);
  });

  it('distinguishes "no data source" from "could not list data sources"', async () => {
    // A real zero is a fact we counted; a denied list is not. If both rendered
    // as the same value the marker would be worthless in both directions —
    // the same bug as documentCount's confident 0.
    account({ dataSources: 'none', jobs: 'ok' });
    const none = await reconcileKnowledgeBases();
    expect(none.entries[0]!.dataSourceCount).toBe(0);
    expect(none.problem).toBeUndefined();

    exec.mockReset();
    exec.mockResolvedValueOnce([REGISTRY_ROW]).mockResolvedValueOnce([{ slug: 'default', n: 157 }]);
    account({ dataSources: 'denied', jobs: 'ok' });
    const denied = await reconcileKnowledgeBases();
    expect(denied.entries[0]!.dataSourceCount).toBeNull();
    expect(denied.problem).toMatch(/data sources unreadable/);
  });

  it('still reconciles drift and the document count — a blind sync is not a blind page', async () => {
    // Why this degrades rather than throws: the drift verdict and the document
    // count are what the page is for, and neither depends on sync history.
    account({ dataSources: 'ok', jobs: 'denied' });
    const e = (await reconcileKnowledgeBases()).entries[0]!;
    expect(e.drift).toBe('ok');
    expect(e.liveKbId).toBe('KB123');
    expect(e.documentCount).toBe(157);
  });
});
