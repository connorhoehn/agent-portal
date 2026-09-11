// The reconcile page's sync state under `dev:mock`.
//
// `syncState`'s mock branch was four literals: `dataSourceCount: 1`,
// `lastSyncStatus: 'COMPLETE'`, a timestamp, and `lastSyncScanned: 6`. That is
// contract rule 1 twice over — both counts are countable from fixtures the same
// module already exports — but the cost was not tidiness.
//
// `kbIngestionJobRows`' newest row is IN_PROGRESS, and its `empty` scenario
// exists (its own comment says so) precisely so the page can be seen saying
// "never synced" rather than "sync failed". The literal `COMPLETE` overrode all
// of it: no scenario could move the reconcile page off "synced this morning", so
// a *running* sync and a *failed* sync were both unreachable offline — and those
// were exactly the two states the Knowledge page had no rendering for. The mock
// was not merely imprecise; it hid the states it already modelled, which is how
// the gap survived long enough to ship.
//
// So the property under test is that the reconcile page's sync figures TRACK the
// ingestion-job fixture. If a future edit reintroduces a literal, the scenario
// assertions below stop moving and this file fails.

const send = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: class { send = (...a: unknown[]) => send(...a); },
  ListKnowledgeBasesCommand: class { constructor(public readonly input: unknown) {} },
  GetKnowledgeBaseCommand: class { constructor(public readonly input: unknown) {} },
  ListDataSourcesCommand: class { constructor(public readonly input: unknown) {} },
  ListIngestionJobsCommand: class { constructor(public readonly input: unknown) {} },
}));

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
// `agentcore` and `knowledgeBase` are here for `startIngestionJob`, which the
// journey case below drives: `kb-reconcile.ts` keys its own mock branch on
// `aurora`, but the knowledge-base provider keys on `agentcore`.
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: true, agentcore: true },
    knowledgeBase: { id: 'KBMOCK0001AB', serviceRoleArn: '' },
    foundation: { documentsBucket: '', artifactsBucket: '' },
  },
}));

import { fixtureRegistry } from '../../mock/core/index.js';
import { kbDataSourceRows, kbDocumentRows, kbIngestionJobRows } from '../../mock/knowledge-base.js';
import { reconcileKnowledgeBases } from '../kb-reconcile.js';
import { startIngestionJob } from '../knowledge-base.js';

afterEach(() => fixtureRegistry.resetAll('default'));

/** The row the page's "Sync now" button acts on — live, in sync, has a source. */
async function syncTarget() {
  const { entries } = await reconcileKnowledgeBases();
  const target = entries.find((e) => e.drift === 'ok' && e.liveKbId && (e.dataSourceCount ?? 0) > 0);
  expect(target).toBeDefined();
  return target!;
}

/** Newest by `startedAt` — the only job `syncState` reports on. */
function newestJob() {
  return [...kbIngestionJobRows.rows()]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

describe('the reconcile page\'s sync state in dev:mock', () => {
  it('reports the newest job rather than a hardcoded COMPLETE', async () => {
    const target = await syncTarget();
    const newest = newestJob();

    expect(target.lastSyncStatus).toBe(newest!.status);
    expect(target.lastSyncAt).toBe(newest!.finishedAt ?? newest!.startedAt);
    expect(target.syncStateKnown).toBe(true);
    // The seeded head is COMPLETE, which on its own is indistinguishable from
    // the literal this replaced — so the discriminator is the coverage figure.
    // The literal said 6; the corpus holds more than that, and only a derived
    // answer tracks it.
    expect(target.lastSyncScanned).toBe(kbDocumentRows.rows().length);
    expect(target.lastSyncScanned).not.toBe(6);
  });

  it('a sync started through the provider becomes the state the page reports',
    async () => {
      // The journey, not a scenario: the default world is *behind* (two uploads
      // landed after the last COMPLETE job), so "Sync now" is the action the
      // page offers and it has to succeed. Doing it must move the page to the
      // running state — that state is exactly what the read side had no
      // rendering for, and reaching it by using the app is the point.
      const before = await syncTarget();
      expect(before.lastSyncStatus).toBe('COMPLETE');

      const started = await startIngestionJob('DSMOCK0001AB', 'journey sync');
      expect(started.ok).toBe(true);

      const after = await syncTarget();
      expect(after.lastSyncStatus).toBe('STARTING');
      // A job that has not settled reports no coverage, and null is what makes
      // "a sync is in flight" distinguishable from "the index is behind". A
      // number here would put the page back to computing a gap against a run
      // that has not finished.
      expect(after.lastSyncScanned).toBeNull();
      expect(after.lastSyncAt).not.toBeNull();
      expect(after.syncStateKnown).toBe(true);

      // And pressing it again conflicts rather than queueing a duplicate — the
      // second half of the same fix, since the old page invited exactly that.
      const again = await startIngestionJob('DSMOCK0001AB', 'journey sync 2');
      expect(again.ok).toBe(false);
      if (again.ok) throw new Error('unreachable');
      expect(again.status).toBe(409);
      expect(again.conflict).toBe(true);
    });

  it('counts data sources instead of asserting one', async () => {
    const target = await syncTarget();
    expect(target.dataSourceCount).toBe(kbDataSourceRows.rows().length);
  });

  it('scopes each row to its OWN data source, so a KB that never synced does not borrow a history',
    async () => {
      // Deriving the figures from the fixture fixed the literals but not the
      // scope: the branch read EVERY ingestion-job row regardless of which data
      // source they belonged to, while the live path lists jobs for the one
      // source it found under `kbId`. So every reachable row on the page
      // reported the default knowledge base's history — `orgiq-onboarding`,
      // which has no jobs at all, claimed the same COMPLETE run, and so did an
      // unregistered knowledge base that by definition has no fixture. Same
      // class of defect as the literals: a confident answer nobody counted, and
      // one that made two panels of the same page disagree.
      const { entries } = await reconcileKnowledgeBases();
      const bySlug = (slug: string) => entries.find((e) => e.slug === slug);

      // The fixture's ingestion history belongs to this one.
      const seeded = bySlug('orgiq-default');
      expect(seeded!.registryKbId).toBe('KBMOCK0001AB');
      expect(seeded!.lastSyncStatus).toBe(newestJob()!.status);
      expect(seeded!.lastSyncScanned).toBe(kbDocumentRows.rows().length);

      // This one is live and has a data source; it has never run a job. Three
      // nulls plus `syncStateKnown: true` is the honest answer, and the count
      // is a fact rather than the null that means "could not look".
      const never = bySlug('orgiq-onboarding');
      expect(never!.drift).toBe('ok');
      expect(never!.dataSourceCount).toBe(1);
      expect(never!.lastSyncStatus).toBeNull();
      expect(never!.lastSyncAt).toBeNull();
      expect(never!.lastSyncScanned).toBeNull();
      expect(never!.syncStateKnown).toBe(true);

      // And no reachable row may share the seeded row's timestamp — that
      // collision IS the bug, in the form it would come back in.
      const borrowers = entries.filter(
        (e) => e.slug !== 'orgiq-default' && e.lastSyncAt === seeded!.lastSyncAt,
      );
      expect(borrowers).toEqual([]);
    });

  it('the error scenario puts a FAILED job at the head, so the page can render it',
    async () => {
      fixtureRegistry.resetAll('error');
      const target = await syncTarget();
      const newest = newestJob();

      expect(newest!.status).toBe('FAILED');
      expect(target.lastSyncStatus).toBe('FAILED');
      // A failed run reports no coverage — the page must say "the last sync
      // failed", not "the index is behind by N documents".
      expect(target.lastSyncScanned).toBeNull();
      // And it is emphatically not "never synced": there IS a timestamp.
      expect(target.lastSyncAt).not.toBeNull();
      // The job names its own reasons, which is what the failure banner points
      // the operator at instead of a retry.
      expect(newest!.failureReasons.length).toBeGreaterThan(0);
    });

  it('an empty history reads as "never synced", not as a failure', async () => {
    // One fixture pinned to `empty`, not `resetAll('empty')`: the latter also
    // empties `kbDataSourceRows`, and a knowledge base with no data source has
    // nothing to sync — a different state, and the one that would make this
    // assertion vacuous. The state worth pinning is "a source is attached and
    // nothing has ever run against it", which is what a fresh deploy looks like.
    //
    // Wrapping `rows` is how the control plane pins a single fixture too
    // (`routes/mock-control.ts`: "the contract has no per-fixture pin ... so the
    // plane pins by wrapping the fixture's own `rows`"), because the active
    // scenario is registry-global and `reset` only drops materialized rows.
    const spy = jest.spyOn(kbIngestionJobRows, 'rows').mockReturnValue([]);
    try {
      const target = await syncTarget();
      expect(target.lastSyncStatus).toBeNull();
      expect(target.lastSyncAt).toBeNull();
      expect(target.lastSyncScanned).toBeNull();
      expect(target.dataSourceCount).toBeGreaterThan(0);
      // Not degraded — these nulls were established, not failed to read, and
      // the page renders the two cases completely differently.
      expect(target.syncStateKnown).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a COMPLETE newest job scans the whole corpus, never a magic number', async () => {
    // An S3 sync scans the entire data source every run, so the only honest
    // coverage figure is the corpus size — the literal it replaced said 6 while
    // the corpus held 14.
    const docs = kbDocumentRows.rows().length;
    expect(docs).toBeGreaterThan(0);
    expect(docs).not.toBe(6);

    // Reach the branch by making the settled job the head.
    const settled = [...kbIngestionJobRows.rows()]
      .filter((j) => j.status === 'COMPLETE')
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
    expect(settled).toBeDefined();

    const spy = jest.spyOn(kbIngestionJobRows, 'rows').mockReturnValue([settled!]);
    try {
      const target = await syncTarget();
      expect(target.lastSyncStatus).toBe('COMPLETE');
      expect(target.lastSyncScanned).toBe(docs);
    } finally {
      spy.mockRestore();
    }
  });
});
