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
import { kbDocumentRows, kbIngestionJobRows, kbObjectRows } from '../../mock/knowledge-base.js';
import {
  countIngestedDocs,
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

  it('countIngestedDocs agrees with a full, unpaged listIngestedDocs — never a stored number', async () => {
    const all = await listIngestedDocs({ limit: 500 });
    expect(await countIngestedDocs()).toBe(all.length);
    // A capped page must not change the true count behind it.
    const page = await listIngestedDocs({ limit: 2 });
    expect(page.length).toBeLessThan(all.length);
    expect(await countIngestedDocs()).toBe(all.length);
    // The `since` filter narrows both the same way.
    const cutoff = all[Math.floor(all.length / 2)]!.ingestedAt!;
    const newer = all.filter((d) => d.ingestedAt != null && d.ingestedAt > cutoff);
    expect(await countIngestedDocs({ since: cutoff })).toBe(newer.length);
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
    // A Bedrock S3 sync scans the whole data source every run, so `scanned` is
    // the corpus.
    expect(lastComplete!.documentsScanned).toBe(docs.length);

    // `indexed` is what THIS run changed, and it is deliberately smaller.
    //
    // This used to assert `documentsIndexed === docs.length` — "the newest
    // COMPLETE sync re-indexed the whole corpus" — which is not what the field
    // means. The real statistics report new + modified documents only, so a
    // sync over an already-current corpus indexes 0. Because the mock said 14
    // where the account said 0, `getStorageBreakdown` reading the field as a
    // holdings count passed every test here and reported "0 documents" over 157
    // deployed. The fixture's corpus lands in two waves; the newest job covers
    // the later one.
    const startedMs = Date.parse(lastComplete!.startedAt);
    const wave = docs.filter((d) => Date.parse(String(d.ingestedAt ?? '')) >= startedMs);
    expect(wave.length).toBeGreaterThan(0);
    expect(wave.length).toBeLessThan(docs.length);
    expect(lastComplete!.documentsIndexed).toBe(wave.length);

    // A job reports exactly the failures it can name.
    for (const job of jobs) {
      expect(job.documentsFailed).toBe(job.failureReasons.length);
    }
    // A running job has not scanned anything yet. The seeded world has no job
    // in flight any more — the head settled deliberately, so that "Sync now"
    // is a legal action in the default world — so start one to get the state
    // rather than asserting against a row that is no longer there.
    const started = await startIngestionJob('DSMOCK0001AB', 'running-job probe');
    expect(started.ok).toBe(true);
    const running = (await listIngestionJobs(undefined, 50))
      .find((j) => ['STARTING', 'IN_PROGRESS'].includes(j.status));
    expect(running).toBeDefined();
    expect(running!.documentsScanned).toBe(0);
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

    // The KB tile counts the corpus, not the last run's delta.
    //
    // This assertion used to read `expect(stats.lastSync.documentsIndexed)
    // .toBe(breakdown.kb.totalDocuments)` — "one is read off the other" — and
    // it was pinning the bug in place. `documentsIndexed` is what a single run
    // NEWLY indexed, which is 0 for a knowledge base that is already current,
    // so the deployed page reported 0 documents over 157. The two numbers
    // answer different questions and must now be allowed to differ: the
    // fixture's second wave indexed 4 of a 14-document corpus.
    expect(breakdown.kb.totalDocuments).toBe(kbDocumentRows.rows().length);
    expect(stats.lastSync.documentsIndexed).not.toBe(breakdown.kb.totalDocuments);
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

  it('refuses a second sync while one is in flight, the way Bedrock does', async () => {
    // Reached by DOING it, which is also how an operator reaches it: the
    // default world is behind, so the first sync succeeds; pressing again while
    // that job is still STARTING is the state Bedrock answers ConflictException
    // for. The mock has to answer the same, or the 409 path is unreachable
    // offline — and an unreachable state is how the read-side half of this gap
    // shipped (see mock/knowledge-base.ts).
    const first = await startIngestionJob('DSMOCK0001AB', 'first sync');
    expect(first.ok).toBe(true);

    const before = (await listIngestionJobs(undefined, 50)).length;
    const outcome = await startIngestionJob('DSMOCK0001AB', 'second sync');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.status).toBe(409);
    expect(outcome.conflict).toBe(true);
    // The reason names the state, not the log file. "check middleware logs" was
    // the old answer and it is what made a working pipeline read as broken.
    expect(outcome.error).toMatch(/already running/i);
    expect(outcome.error).not.toMatch(/middleware logs/i);
    // And it started nothing: a refused sync must not leave a job behind.
    expect((await listIngestionJobs(undefined, 50)).length).toBe(before);
  });

  it('makes a sync and an upload visible to the next read', async () => {
    // Nothing is in flight in the default world — the newest job has settled,
    // which is why "Sync now" is a legal request here at all.
    expect(kbIngestionJobRows.rows().some(
      (j) => ['STARTING', 'IN_PROGRESS', 'STOPPING'].includes(j.status),
    )).toBe(false);

    const before = (await listIngestionJobs(undefined, 50)).length;
    const started = await startIngestionJob('DSMOCK0001AB', 'test sync');
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error(started.error);

    const after = await listIngestionJobs(undefined, 50);
    expect(after.length).toBe(before + 1);
    expect(after[0]!.jobId).toBe(started.jobId);
    // The data-source row picks the new job up as its latest.
    const sources = await listDataSourcesWithStatus('');
    expect(sources[0]!.lastJobStatus).toBe(started.status);

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
