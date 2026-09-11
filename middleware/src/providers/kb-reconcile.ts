// Reconcile the knowledge-base registry against what AWS actually has.
//
// The registry is an Aurora table describing Bedrock knowledge bases. Nothing
// kept it honest, and a seeded row is still a row: on a rebuilt account the
// registry reported `EJYAXQAMHQ` with status ACTIVE — an id that came from a
// seed file and had never existed — while the knowledge base the agents were
// actually querying was absent from the registry entirely. The page rendered
// that fiction as fact.
//
// A registry that describes external resources has to be checkable against
// them. This lists the real knowledge bases, matches them to registry rows,
// and names every way the two disagree. It changes nothing on its own —
// adoption is a decision, because the right fix differs per case: a row whose
// id is wrong should be repointed, a knowledge base nobody registered might be
// someone else's.

import {
  BedrockAgentClient,
  ListKnowledgeBasesCommand,
  GetKnowledgeBaseCommand,
  ListDataSourcesCommand,
  ListIngestionJobsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { mockKbRegistry } from '../mock/kb-registry.js';
import { kbDataSourceRows, kbDocumentRows, kbIngestionJobRows } from '../mock/knowledge-base.js';
import { clock } from '../mock/core/index.js';
import { attempt, problemFrom, reached, unreachable, type Upstream } from '../lib/upstream.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

let _client: BedrockAgentClient | null = null;
const client = (): BedrockAgentClient => (_client ??= new BedrockAgentClient({ region: config.region }));

/** How a registry row and the live account relate. */
export type DriftKind =
  /** Registry row points at a knowledge base that does not exist. */
  | 'missing'
  /** A live knowledge base no registry row claims. */
  | 'unregistered'
  /** Row has no id at all — never provisioned. */
  | 'unprovisioned'
  /** Row and reality agree on identity but not on status. */
  | 'status-drift'
  | 'ok';

export interface ReconciledKb {
  /** Registry row id, so a UI can link to the row's own page to act on it. */
  id: string | null;
  /** Registry identity, when there is a row. */
  slug: string | null;
  name: string;
  tenant: string | null;
  /** What the registry claims. */
  registryKbId: string | null;
  registryStatus: string | null;
  /** What AWS reports. */
  liveKbId: string | null;
  liveStatus: string | null;
  dataSourceCount: number | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  /** Documents the last completed sync actually scanned. */
  lastSyncScanned: number | null;
  /**
   * Whether the three fields above are an *answer*. False means the read
   * failed, so their nulls carry no information.
   *
   * Without this the wire shape is ambiguous in the one way that matters: a
   * knowledge base that has genuinely never synced and one whose history we
   * were denied both arrive as three nulls, and a UI cannot help but pick a
   * story. It picked "never indexed" — about a knowledge base with two
   * COMPLETE jobs. `problem` says *that* something failed but not *which row*,
   * so the distinction has to live on the row.
   */
  syncStateKnown: boolean;
  documentCount: number | null;
  drift: DriftKind;
  /** Plain sentence naming the disagreement, for a UI to show verbatim. */
  detail: string;
}

async function liveKnowledgeBases(): Promise<Array<{ id: string; name: string; status: string }>> {
  const out: Array<{ id: string; name: string; status: string }> = [];
  let nextToken: string | undefined;
  do {
    const page = await client().send(new ListKnowledgeBasesCommand({
      maxResults: 50, ...(nextToken ? { nextToken } : {}),
    }));
    for (const k of page.knowledgeBaseSummaries ?? []) {
      if (k.knowledgeBaseId) {
        out.push({
          id: k.knowledgeBaseId,
          name: k.name ?? k.knowledgeBaseId,
          status: k.status ?? 'UNKNOWN',
        });
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

interface SyncState {
  dataSourceCount: number | null; lastSyncStatus: string | null; lastSyncAt: string | null;
  lastSyncScanned: number | null;
}

/** Nothing known yet — the shape a caller renders when a read did not land. */
const NO_SYNC_STATE: SyncState = {
  dataSourceCount: null, lastSyncStatus: null, lastSyncAt: null, lastSyncScanned: null,
};

/**
 * Sync state for one knowledge base — and whether it could be read.
 *
 * This used to be one try/catch returning four bare nulls, which is how a
 * missing IAM permission became a confident, wrong answer. The task role held
 * `bedrock:ListDataSources` but not `bedrock:ListIngestionJobs`, so the first
 * call succeeded, the second threw AccessDenied, and the catch discarded BOTH —
 * including the data source count it had already read. Against a knowledge base
 * with an AVAILABLE data source and two COMPLETE jobs the page then said "no
 * data source attached" and "never indexed", named no permission, and offered a
 * Sync button that needed a third missing action. The reason was in the
 * exception the whole time.
 *
 * So: two reads, caught separately, each keeping what the other learned, and
 * the reason returned rather than swallowed. `Upstream` is this module's
 * existing convention (see `documentCounts`) — the caller folds `error` into
 * the envelope's `problem` field, which the route already passes through.
 */
export async function syncState(kbId: string): Promise<Upstream<SyncState>> {
  if (config.mock.aurora) {
    // Derived from the same registered fixtures `/api/ingest/*` reads, not
    // stated. This branch used to be four literals — `dataSourceCount: 1`,
    // `lastSyncStatus: 'COMPLETE'`, `lastSyncScanned: 6` — which broke contract
    // rule 1 twice over and cost more than tidiness.
    //
    // `kbIngestionJobRows`' newest row is IN_PROGRESS and its `empty` scenario
    // exists precisely so the page can be seen saying "never synced" rather
    // than "sync failed" (its own comment says so). The literal `COMPLETE`
    // overrode both: no scenario could move the reconcile page off "synced this
    // morning", so a running sync and a failed one were unreachable offline —
    // the two states the page had no rendering for. A fixture that hides the
    // state it already models is worse than one that omits it.
    //
    // SCOPED TO THIS KNOWLEDGE BASE'S OWN DATA SOURCE, because the live branch
    // below is: it calls ListDataSources on `kbId` and lists jobs for the data
    // source it finds. Offline this read every job row regardless of which KB
    // they belonged to, so all three registry rows reported the default KB's
    // history — `orgiq-onboarding`, which has never synced, claimed a COMPLETE
    // run, and so did an unregistered knowledge base that by definition has no
    // fixture at all. Same class of answer as the literals it replaced: a
    // confident one nobody counted. A KB whose registry row names no data
    // source now returns the same "nothing to fail to read" answer the live
    // path gives, with `dataSourceCount: 0` — a fact, not the null that means
    // we could not look.
    const row = mockKbRegistry.find((k) => k.bedrockKbId === kbId);
    const dsId = row?.dataSourceId ?? null;
    // The fixture's data-source rows model the default knowledge base; a
    // registry row that names a data source the fixture does not carry still
    // has one, and `1` is what the account would report for it.
    const owned = kbDataSourceRows.rows().filter((d) => d.id === dsId);
    const dataSourceCount = owned.length || (dsId ? 1 : 0);
    if (!dsId) return reached({ ...NO_SYNC_STATE, dataSourceCount: 0 });
    const jobs = kbIngestionJobRows.rows()
      .filter((j) => j.dataSourceId === dsId)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    const latest = jobs[0];
    return reached({
      dataSourceCount,
      lastSyncStatus: latest?.status ?? null,
      lastSyncAt: latest ? (latest.finishedAt ?? latest.startedAt) : null,
      // Bedrock reports coverage when a job settles, so only a COMPLETE run has
      // a scanned count — and an S3 sync scans the whole data source, which is
      // the corpus. A running or failed run reports null, which is what makes
      // "a sync is in flight" distinguishable from "the index is behind".
      lastSyncScanned: latest?.status === 'COMPLETE' ? kbDocumentRows.rows().length : null,
    });
  }

  const sources = await attempt(
    async () => {
      const ds = await client().send(
        new ListDataSourcesCommand({ knowledgeBaseId: kbId, maxResults: 20 }),
      );
      return ds.dataSourceSummaries ?? [];
    },
    [],
    `${kbId}: data sources unreadable`,
  );
  if (sources.degraded) {
    return { items: { ...NO_SYNC_STATE }, degraded: true, error: sources.error };
  }

  const dataSourceCount = sources.items.length;
  const first = sources.items[0]?.dataSourceId;
  // A knowledge base with no data source has no sync history to fail to read.
  // That is a complete answer, not a degraded one — and `dataSourceCount: 0`
  // here is a fact we counted, which is why it must not share a shape with the
  // null that means "we could not count".
  if (!first) return reached({ ...NO_SYNC_STATE, dataSourceCount });

  const latest = await attempt(
    async () => {
      // Newest first, explicitly. ListIngestionJobs does not promise an order,
      // and unsorted `maxResults: 1` returned the *oldest* job — so after a
      // second sync the page still reported the first one's coverage and went
      // on claiming the index was behind when it had just caught up.
      const jobs = await client().send(new ListIngestionJobsCommand({
        knowledgeBaseId: kbId,
        dataSourceId: first,
        maxResults: 1,
        sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
      }));
      return (jobs.ingestionJobSummaries ?? [])[0];
    },
    undefined,
    `${kbId}: ingestion history unreadable`,
  );
  if (latest.degraded) {
    // Keep the count that WAS read. Losing it here is what turned "we cannot
    // see the sync history" into the flatly false "there is no data source".
    return {
      items: { ...NO_SYNC_STATE, dataSourceCount },
      degraded: true,
      error: latest.error,
    };
  }

  const job = latest.items;
  return reached({
    dataSourceCount,
    lastSyncStatus: job?.status ?? null,
    lastSyncAt: job?.updatedAt ? new Date(job.updatedAt).toISOString() : null,
    // What the last run covered. Comparing this with what is in storage is
    // the only way to tell a current index from one that ran once and has
    // been behind ever since — both report a recent, successful sync.
    lastSyncScanned: job?.statistics?.numberOfDocumentsScanned ?? null,
  });
}

/**
 * Documents attributed to a registry slug — and whether they could be counted.
 *
 * This returned a bare `{}` on a failed query, and the caller then wrote
 * `documentCount: docs[slug] ?? 0`. So an unreadable `documents` table became
 * a confident **0 documents** on every row of a page whose entire job is to
 * find knowledge bases that are not holding what they claim to hold — the
 * failure and the finding are the same number. `documentCount` is already
 * `number | null` on the wire, so the honest answer costs nothing: null, plus
 * a sentence in `problem`.
 */
async function documentCounts(): Promise<Upstream<Record<string, number>>> {
  // Not degraded: offline there is no documents table to read, which is a fact
  // about this process rather than a failure to report on the page.
  if (config.mock.aurora) return reached({});
  try {
    const rows = await exec(
      `SELECT COALESCE(kb_registry_slug, 'default') AS slug, count(*)::int AS n
         FROM documents GROUP BY 1`,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[toStr(r['slug'])] = Number(r['n'] ?? 0);
    return reached(out);
  } catch (err) {
    return unreachable({} as Record<string, number>, err, 'document counts unavailable');
  }
}

/**
 * Compare registry rows with the live account.
 *
 * Never throws for an unreachable AWS or database — a reconciliation that
 * cannot see one side reports that it could not, rather than declaring
 * everything missing, which would be the most alarming possible lie.
 */
export async function reconcileKnowledgeBases(): Promise<{
  entries: ReconciledKb[];
  /** Set when one side could not be read; entries are then partial. */
  problem?: string;
}> {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = config.mock.aurora
      ? mockKbRegistry
          .slice()
          .sort((a, b) => a.slug.localeCompare(b.slug))
          .map((k) => ({
            id: k.id, slug: k.slug, name: k.name, tenant: k.tenant,
            bedrock_kb_id: k.bedrockKbId, status: k.status,
          }))
      : await exec(
        `SELECT id, slug, name, tenant, bedrock_kb_id, status FROM knowledge_bases ORDER BY slug`,
      );
  } catch (err) {
    return { entries: [], problem: `registry unreadable: ${(err as Error).message}` };
  }

  // Offline: skip the real Bedrock call (no credentials to make it mean
  // anything) and synthesize what the live account would report — every
  // mock KB except the deliberately-drifted KBMOCK-GONE row, which is the
  // whole point of the reconcile page's fixture.
  let live: Array<{ id: string; name: string; status: string }>;
  if (config.mock.aurora) {
    live = mockKbRegistry
      .filter((k) => k.bedrockKbId && k.bedrockKbId !== 'KBMOCK-GONE')
      .map((k) => ({ id: k.bedrockKbId!, name: k.name, status: 'ACTIVE' }));
  } else {
    try {
      live = await liveKnowledgeBases();
    } catch (err) {
      // Report the registry as-is rather than marking every row "missing" —
      // we cannot see AWS, which is not the same as AWS being empty.
      return {
        entries: rows.map((r) => ({
          id: toStr(r['id']) || null,
          slug: toStr(r['slug']), name: toStr(r['name']), tenant: toStr(r['tenant']) || null,
          registryKbId: r['bedrock_kb_id'] ? toStr(r['bedrock_kb_id']) : null,
          registryStatus: toStr(r['status']) || null,
          liveKbId: null, liveStatus: null, dataSourceCount: null,
          lastSyncStatus: null, lastSyncAt: null, lastSyncScanned: null,
          // We never got as far as asking, so no row here knows its sync state.
          syncStateKnown: false,
          documentCount: null,
          drift: 'ok' as DriftKind,
          detail: 'Could not read the account to compare.',
        })),
        problem: `could not list knowledge bases: ${(err as Error).message}`,
      };
    }
  }

  const counted = await documentCounts();
  // Reasons the per-KB sync reads did not land, folded into `problem` below.
  // A page that shows "—" for last sync now also says why it is a dash.
  const syncProblems: string[] = [];
  const docs = counted.items;
  const liveById = new Map(live.map((k) => [k.id, k]));
  const claimed = new Set<string>();
  const entries: ReconciledKb[] = [];

  for (const r of rows) {
    const slug = toStr(r['slug']);
    const registryKbId = r['bedrock_kb_id'] ? toStr(r['bedrock_kb_id']) : null;
    const registryStatus = toStr(r['status']) || null;
    const match = registryKbId ? liveById.get(registryKbId) : undefined;
    if (registryKbId && match) claimed.add(registryKbId);

    let drift: DriftKind = 'ok';
    let detail = 'Registry matches the account.';
    if (!registryKbId) {
      drift = 'unprovisioned';
      detail = 'No knowledge base has been created for this entry yet.';
    } else if (!match) {
      drift = 'missing';
      detail = `Registry points at ${registryKbId}, which does not exist in this account.`;
    } else if (registryStatus === 'ACTIVE' && match.status !== 'ACTIVE') {
      drift = 'status-drift';
      detail = `Registry says ACTIVE; the account reports ${match.status}.`;
    }

    const sync = match ? await syncState(match.id) : reached({ ...NO_SYNC_STATE });
    if (sync.degraded) syncProblems.push(sync.error);
    entries.push({
      id: toStr(r['id']) || null,
      slug, name: toStr(r['name']), tenant: toStr(r['tenant']) || null,
      registryKbId, registryStatus,
      liveKbId: match?.id ?? null,
      liveStatus: match?.status ?? null,
      ...sync.items,
      syncStateKnown: !sync.degraded,
      // Null, not 0, when the count could not be read — "we did not count" is
      // not "there are none", and on this page the difference is the diagnosis.
      documentCount: counted.degraded ? null : docs[slug] ?? 0,
      drift, detail,
    });
  }

  // Knowledge bases nobody registered. Worth surfacing rather than ignoring:
  // this is how the real one showed up as invisible while a fictional id sat
  // in its place.
  for (const k of live) {
    if (claimed.has(k.id)) continue;
    const sync = await syncState(k.id);
    if (sync.degraded) syncProblems.push(sync.error);
    entries.push({
      id: null, slug: null, name: k.name, tenant: null,
      registryKbId: null, registryStatus: null,
      liveKbId: k.id, liveStatus: k.status,
      ...sync.items,
      syncStateKnown: !sync.degraded,
      documentCount: null,
      drift: 'unregistered',
      detail: 'This knowledge base exists in the account but no registry entry claims it.',
    });
  }

  // `problem` is this surface's existing marker and routes/kb-admin.ts already
  // passes the whole envelope through with `res.json(await
  // reconcileKnowledgeBases())`, so a partial reconciliation reaches the wire
  // with no route change at all.
  const problem = problemFrom(counted.error, ...syncProblems);
  return { entries, ...(problem ? { problem } : {}) };
}

/**
 * Point a registry row at a knowledge base that really exists.
 *
 * Deliberately narrow: it repoints and re-reads status, and does not create,
 * delete or sync anything. Adoption is the one safe automatic repair — every
 * other kind of drift needs someone to decide what the right answer is.
 */
export async function adoptKnowledgeBase(slug: string, kbId: string): Promise<{
  ok: boolean; status?: string; dataSourceId?: string | null; error?: string;
}> {
  if (config.mock.aurora) return { ok: false, error: 'Aurora is mocked' };
  try {
    const live = await client().send(new GetKnowledgeBaseCommand({ knowledgeBaseId: kbId }));
    const status = live.knowledgeBase?.status ?? 'UNKNOWN';

    // Capture the data source too. Sync needs both ids, so adopting the
    // knowledge base alone would leave a row that looks repaired and still
    // rejects every sync with "not yet provisioned" — a second, subtler
    // version of the drift this whole thing exists to remove.
    let dataSourceId: string | null = null;
    try {
      const ds = await client().send(new ListDataSourcesCommand({ knowledgeBaseId: kbId, maxResults: 5 }));
      dataSourceId = ds.dataSourceSummaries?.[0]?.dataSourceId ?? null;
    } catch { /* leave null — the row is still better off pointing at a real KB */ }

    await exec(
      `UPDATE knowledge_bases
          SET bedrock_kb_id = :kb,
              data_source_id = COALESCE(:ds, data_source_id),
              status = :status, error_message = NULL, updated_at = NOW()
        WHERE slug = :slug`,
      [
        s('kb', kbId),
        dataSourceId
          ? s('ds', dataSourceId)
          : { name: 'ds', value: { isNull: true }, typeHint: undefined } as SqlParameter,
        s('status', status), s('slug', slug),
      ],
    );
    return { ok: true, status, dataSourceId };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
