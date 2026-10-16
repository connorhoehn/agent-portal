// Which SearchIndex serves this process, which partition a request reads, and
// when a partition is (re)built from the providers.
//
// SEARCH_INDEX_STORE=memory|kv (default memory; kv when
// SEARCH_INDEX_DYNAMODB_ENDPOINT or SEARCH_INDEX_TABLE is set). The kv store
// speaks the DynamoDB wire protocol (DynamoDB, DynamoDB Local, the
// managed-nosql-store).
//
// PARTITIONS. A partition is `<tenant>` in a real deployment. Under dev:mock a
// request may run inside a mock scope (its own copy-on-write world,
// mock/core/scope.ts): its partition is `<tenant>~<scope id>`, built from the
// scope's own rows, so a write made under a scope is indexed only there. The
// shared world's partition carries the world generation (`~w<n>`), which
// every fixture reset, pin and scenario switch bumps, so a world that was put
// back is never answered from a stale projection. Partitions of dead scopes
// and old generations are dropped as they are noticed.
//
// BUILD. The first read of a partition with no meta builds it from the
// providers (lib/search-index/orgiq.ts, or the tenant's spec in lib/search-index/<tenant>.ts) once — concurrent readers share the
// build — and records what was windowed or unreadable. A partition whose build
// hit an unreadable source is rebuilt after RETRY_MS. After that, writers keep
// it current (./writes.ts).

import { config } from '../../config.js';
import { currentMockScope, getMockScope, mockWorldGeneration } from '../../mock/core/index.js';
import { MemorySearchIndex } from './memory.js';
import { KvSearchIndex, createKvIndexClient, ensureKvIndexTable, kvIndexConfig } from './kv.js';
import { buildOrgiqDocs } from './orgiq.js';
import { tenantSpec, type IndexedTenant, type TenantBuild } from './tenants.js';
import type { IndexMeta, SearchIndex } from './types.js';

export type { IndexedTenant };
const RETRY_MS = 30_000;

export function searchIndexStore(env: NodeJS.ProcessEnv = process.env): 'memory' | 'kv' {
  const explicit = (env['SEARCH_INDEX_STORE'] ?? '').trim().toLowerCase();
  if (explicit === 'kv' || explicit === 'memory') return explicit;
  return env['SEARCH_INDEX_DYNAMODB_ENDPOINT']?.trim() || env['SEARCH_INDEX_TABLE']?.trim() ? 'kv' : 'memory';
}

let instance: SearchIndex | null = null;
let kvReady: Promise<void> | null = null;

export function searchIndex(): SearchIndex {
  if (instance) return instance;
  if (searchIndexStore() === 'kv') {
    const cfg = kvIndexConfig();
    const client = createKvIndexClient(cfg);
    // Local setups create their own table; in the cloud infrastructure owns it and this is a describe.
    kvReady = cfg.endpoint ? ensureKvIndexTable(client, cfg.table) : Promise.resolve();
    instance = new KvSearchIndex(client, cfg.table);
  } else instance = new MemorySearchIndex();
  return instance;
}

/** The partition the current request reads and writes for `tenant`. */
export function partitionFor(tenant: IndexedTenant): string {
  if (!config.mock.aurora) return tenant;
  const scope = currentMockScope();
  return scope ? `${tenant}~${scope.id}` : `${tenant}~w${mockWorldGeneration()}`;
}

/** Drop memory partitions whose mock scope is gone or whose world generation is old. */
function prune(index: SearchIndex, current: string): void {
  if (!(index instanceof MemorySearchIndex)) return;
  for (const p of index.partitions()) {
    if (p === current) continue;
    const suffix = p.slice(p.indexOf('~') + 1);
    if (/^w\d+$/.test(suffix) ? suffix !== `w${mockWorldGeneration()}` : !getMockScope(suffix)) void index.clear(p);
  }
}

const building = new Map<string, Promise<IndexMeta>>();

async function buildTenant(tenant: IndexedTenant, partition: string): Promise<TenantBuild> {
  return tenant === 'orgiq' ? buildOrgiqDocs(partition) : (await tenantSpec(tenant)).build(partition);
}

async function build(index: SearchIndex, tenant: IndexedTenant, partition: string): Promise<IndexMeta> {
  const result = await buildTenant(tenant, partition);
  await index.clear(partition);
  await index.putMany(result.docs);
  const meta: IndexMeta = { builtAt: new Date().toISOString(), partial: result.partial, retryAfter: result.failed ? new Date(Date.now() + RETRY_MS).toISOString() : null };
  await index.setMeta(partition, meta);
  return meta;
}

/** The partition for `tenant`, built if it has never been (or its last build hit an unreadable source). */
export async function ensureIndexed(tenant: IndexedTenant): Promise<{ index: SearchIndex; partition: string; meta: IndexMeta }> {
  const index = searchIndex();
  if (kvReady) await kvReady;
  const partition = partitionFor(tenant);
  prune(index, partition);
  const meta = await index.getMeta(partition);
  if (meta && !(meta.retryAfter && Date.parse(meta.retryAfter) <= Date.now())) return { index, partition, meta };
  let pending = building.get(partition);
  if (!pending) {
    pending = build(index, tenant, partition).finally(() => building.delete(partition));
    building.set(partition, pending);
  }
  return { index, partition, meta: await pending };
}

/** True when the partition has been built: a write before then needs no index update (the build reads it). */
export async function isIndexed(tenant: IndexedTenant): Promise<boolean> {
  const index = searchIndex();
  if (kvReady) await kvReady;
  return (await index.getMeta(partitionFor(tenant))) !== null;
}

/** Tests: forget the process index (a fresh memory index next time). */
export function __resetSearchIndex(): void { instance = null; kvReady = null; building.clear(); }
