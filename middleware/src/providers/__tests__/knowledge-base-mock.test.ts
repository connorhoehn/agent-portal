// The knowledge-base provider's dev:mock branch.
//
// Two things are worth pinning here, and only one of them is "the route
// returns rows".
//
//   1. Nothing is a stored total. Every headline number the Ingest and
//      Knowledge pages render — documents indexed, objects, bytes, pending
//      since last sync — is counted from the same rows the list underneath it
//      shows. That is contract rule 1, and it is the rule that produced "5
//      bots" over an empty table.
//   2. The failure modes stay distinguishable. Before this branch existed
//      `/api/ingest/kb` said "KNOWLEDGE_BASE_ID is not set" offline, which is
//      the sentence for a middleware that was never configured — not for a
//      knowledge base that exists. The `empty` scenario has to produce the
//      OTHER sentence ("deleted upstream"), because they call for different
//      operator action.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true, cloudwatch: true, guardrails: false },
    knowledgeBase: { id: '', serviceRoleArn: '' },
    foundation: { documentsBucket: '', artifactsBucket: '' },
  },
}));

import { fixtureRegistry, sumBy } from '../../mock/core/index.js';
import { kbDocumentRows, kbObjectRows } from '../../mock/knowledge-base.js';
import {
  countS3Documents,
  getIngestStats,
  getStorageBreakdown,
  listDataSourcesWithStatus,
  listIngestedDocs,
  listIngestionJobs,
  lookupKb,
  startIngestionJob,
  uploadDocument,
} from '../knowledge-base.js';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('the knowledge base in dev:mock', () => {
  it('answers with the corpus rather than an empty shape', async () => {
    const docs = await listIngestedDocs({ limit: 100 });
    expect(docs.length).toBeGreaterThan(0);
    // Newest first, the ORDER BY the SQL path uses.
    const stamps = docs.map((d) => d.ingestedAt ?? '');
    expect([...stamps].sort().reverse()).toEqual(stamps);
    // Ids follow schema/synth's naming, so a reader can find the generator.
    expect(docs.some((d) => d.id.startsWith('adr-d-'))).toBe(true);
  });

  it('names the knowledge base instead of blaming the config for it', async () => {
    const found = await lookupKb();
    expect(found.state).toBe('ok');
    expect(found.kb?.id).toBe('KBMOCK0001AB');

    // A knowledge base that is gone is a DIFFERENT problem from one that was
    // never configured, and the two need different operator action.
    fixtureRegistry.resetAll('empty');
    const missing = await lookupKb();
    expect(missing.state).toBe('missing');
    expect(missing.problem).toMatch(/deleted upstream/);
  });

  it('counts a job\'s documents from the corpus, so no tile can outrun its list', async () => {
    const docs = await listIngestedDocs({ limit: 500 });
    const jobs = await listIngestionJobs(undefined, 20);
    const lastComplete = jobs.find((j) => j.status === 'COMPLETE');

    expect(lastComplete).toBeDefined();
    // The newest COMPLETE sync re-indexed the whole corpus: the "documents
    // indexed" number and the document list are the same rows.
    expect(lastComplete!.documentsIndexed).toBe(docs.length);
    expect(lastComplete!.documentsScanned).toBe(docs.length);

    // A job reports exactly the failures it can name.
    for (const job of jobs) {
      expect(job.documentsFailed).toBe(job.failureReasons.length);
    }
    // A running job has not scanned anything yet.
    const running = jobs.find((j) => j.status === 'IN_PROGRESS');
    expect(running?.documentsScanned).toBe(0);
  });

  it('sums storage from the object rows, never from a stored total', async () => {
    const objects = kbObjectRows.rows();
    const breakdown = await getStorageBreakdown();

    expect(breakdown.totalObjects).toBe(objects.length);
    expect(breakdown.totalBytes).toBe(sumBy(objects, 'sizeBytes'));
    expect(sumBy(breakdown.byType, 'count')).toBe(objects.length);
    expect(sumBy(breakdown.byPrefix, 'bytes')).toBe(breakdown.totalBytes);
    expect(breakdown.bucket).not.toBe('');

    const stats = await getIngestStats();
    expect(stats.s3.total).toBe(objects.length);
    expect(stats.s3.totalSizeBytes).toBe(breakdown.totalBytes);
    // The KB tile and the job history agree, because one is read off the other.
    expect(stats.lastSync.documentsIndexed).toBe(breakdown.kb.totalDocuments);
  });

  it('counts the queue as the objects newer than the last sync', async () => {
    const lastComplete = (await listIngestionJobs(undefined, 20))
      .find((j) => j.status === 'COMPLETE')!;
    const queue = await countS3Documents(lastComplete.updatedAt);

    const expected = kbObjectRows.rows()
      .filter((o) => Date.parse(o.lastModified) > Date.parse(lastComplete.updatedAt)).length;
    expect(queue.pendingSinceLastSync).toBe(expected);
    expect(queue.total).toBe(kbObjectRows.rows().length);

    // Never synced means everything is pending — the rule the real S3 scan uses.
    expect((await countS3Documents()).pendingSinceLastSync).toBe(queue.total);
  });

  it('makes a sync and an upload visible to the next read', async () => {
    const before = (await listIngestionJobs(undefined, 50)).length;
    const started = await startIngestionJob('DSMOCK0001AB', 'test sync');
    expect(started).not.toBeNull();

    const after = await listIngestionJobs(undefined, 50);
    expect(after.length).toBe(before + 1);
    expect(after[0]!.jobId).toBe(started!.jobId);
    // The data-source row picks the new job up as its latest.
    const sources = await listDataSourcesWithStatus('');
    expect(sources[0]!.lastJobStatus).toBe(started!.status);

    const objectsBefore = kbObjectRows.rows().length;
    const uploaded = await uploadDocument('team charter.md', Buffer.from('# charter'), 'text/markdown');
    expect(uploaded.key).toMatch(/^uploads\/\d{4}-\d{2}-\d{2}\/team_charter\.md$/);
    expect(kbObjectRows.rows().length).toBe(objectsBefore + 1);
    expect((await getStorageBreakdown()).totalObjects).toBe(objectsBefore + 1);
  });

  it('renders an unsynced knowledge base without pretending it is broken', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listIngestedDocs()).toEqual([]);
    expect(await listIngestionJobs()).toEqual([]);
    expect((await getStorageBreakdown()).totalObjects).toBe(0);
    expect(kbDocumentRows.rows()).toEqual([]);
  });
});
