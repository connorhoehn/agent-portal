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

/** Sync state for one knowledge base, or nulls when it cannot be read. */
async function syncState(kbId: string): Promise<{
  dataSourceCount: number | null; lastSyncStatus: string | null; lastSyncAt: string | null;
  lastSyncScanned: number | null;
}> {
  try {
    const ds = await client().send(new ListDataSourcesCommand({ knowledgeBaseId: kbId, maxResults: 20 }));
    const sources = ds.dataSourceSummaries ?? [];
    const first = sources[0]?.dataSourceId;
    if (!first) return { dataSourceCount: sources.length, lastSyncStatus: null, lastSyncAt: null, lastSyncScanned: null };

    const jobs = await client().send(new ListIngestionJobsCommand({
      knowledgeBaseId: kbId, dataSourceId: first, maxResults: 1,
    }));
    const job = (jobs.ingestionJobSummaries ?? [])[0];
    return {
      dataSourceCount: sources.length,
      lastSyncStatus: job?.status ?? null,
      lastSyncAt: job?.updatedAt ? new Date(job.updatedAt).toISOString() : null,
      // What the last run covered. Comparing this with what is in storage is
      // the only way to tell a current index from one that ran once and has
      // been behind ever since — both report a recent, successful sync.
      lastSyncScanned: job?.statistics?.numberOfDocumentsScanned ?? null,
    };
  } catch {
    return { dataSourceCount: null, lastSyncStatus: null, lastSyncAt: null, lastSyncScanned: null };
  }
}

/** Documents attributed to a registry slug. */
async function documentCounts(): Promise<Record<string, number>> {
  if (config.mock.aurora) return {};
  try {
    const rows = await exec(
      `SELECT COALESCE(kb_registry_slug, 'default') AS slug, count(*)::int AS n
         FROM documents GROUP BY 1`,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[toStr(r['slug'])] = Number(r['n'] ?? 0);
    return out;
  } catch {
    return {};
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
    rows = config.mock.aurora ? [] : await exec(
      `SELECT id, slug, name, tenant, bedrock_kb_id, status FROM knowledge_bases ORDER BY slug`,
    );
  } catch (err) {
    return { entries: [], problem: `registry unreadable: ${(err as Error).message}` };
  }

  let live: Array<{ id: string; name: string; status: string }>;
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
        lastSyncStatus: null, lastSyncAt: null, lastSyncScanned: null, documentCount: null,
        drift: 'ok' as DriftKind,
        detail: 'Could not read the account to compare.',
      })),
      problem: `could not list knowledge bases: ${(err as Error).message}`,
    };
  }

  const docs = await documentCounts();
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

    const sync = match
      ? await syncState(match.id)
      : { dataSourceCount: null, lastSyncStatus: null, lastSyncAt: null, lastSyncScanned: null };
    entries.push({
      id: toStr(r['id']) || null,
      slug, name: toStr(r['name']), tenant: toStr(r['tenant']) || null,
      registryKbId, registryStatus,
      liveKbId: match?.id ?? null,
      liveStatus: match?.status ?? null,
      ...sync,
      documentCount: docs[slug] ?? 0,
      drift, detail,
    });
  }

  // Knowledge bases nobody registered. Worth surfacing rather than ignoring:
  // this is how the real one showed up as invisible while a fictional id sat
  // in its place.
  for (const k of live) {
    if (claimed.has(k.id)) continue;
    const sync = await syncState(k.id);
    entries.push({
      id: null, slug: null, name: k.name, tenant: null,
      registryKbId: null, registryStatus: null,
      liveKbId: k.id, liveStatus: k.status,
      ...sync,
      documentCount: null,
      drift: 'unregistered',
      detail: 'This knowledge base exists in the account but no registry entry claims it.',
    });
  }

  return { entries };
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
