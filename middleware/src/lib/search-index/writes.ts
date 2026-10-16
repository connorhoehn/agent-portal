// Update on write (docs/user-search-goal.md, decision 1): every orgiq writer
// that changes a searchable record calls `noteSearchWrite` AFTER its source
// commit, naming the records it changed. The record is re-read from its
// provider (lib/search-index/orgiq.ts projectOrgiqRecord) and put — or removed
// when it no longer exists — in the partition the request is writing to (a
// mock scope's own partition inside a scope). A partition that has not been
// built yet is left alone: its first build reads the committed rows.
//
// It never fails the write it follows: the source of truth committed, so an
// index error is logged and the partition is marked for a rebuild instead.
// `scripts/check-search-writers.mjs` (run by scripts/validate-user-search.sh)
// fails when an exported orgiq writer neither calls this nor is exempted with
// a reason in that script's EXEMPT table.
//
// A store change stream can replace this hook later: the stream consumer would
// call the same `projectOrgiqRecord` + put/remove.

// Writers (providers/projects.ts, work-items.ts…) import this module, and the
// projection imports those providers back: the projection and registry are
// loaded on first use, never at import, so the providers' load order is untouched.
import type { IndexedTenant } from './tenants.js';
import { docKey } from './types.js';

/** A changed record. `tenant` defaults to orgiq; the other tenants name theirs (lib/search-index/<tenant>.ts types). */
export interface SearchWriteRef { type: string; id: string; tenant?: IndexedTenant }

export async function noteSearchWrite(...refs: Array<SearchWriteRef | null | undefined>): Promise<void> {
  const wanted = [...new Map(refs.filter((r): r is SearchWriteRef => !!r && !!r.id).map(r => [`${r.tenant ?? 'orgiq'}|${docKey(r.type, r.id)}`, r])).values()];
  if (!wanted.length) return;
  let registry: typeof import('./registry.js');
  try { registry = await import('./registry.js'); } catch { return; } // no index in this process (a unit test's module graph)
  const { isIndexed, partitionFor, searchIndex } = registry;
  const tenants = [...new Set(wanted.map(r => r.tenant ?? 'orgiq'))];
  for (const tenant of tenants) {
    const mine = wanted.filter(r => (r.tenant ?? 'orgiq') === tenant);
    const partition = partitionFor(tenant);
    try {
      if (!(await isIndexed(tenant))) continue;
      const project = tenant === 'orgiq'
        ? (await import('./orgiq.js')).projectOrgiqRecord as (p: string, type: string, id: string) => Promise<import('./types.js').SearchDoc | null>
        : (await (await import('./tenants.js')).tenantSpec(tenant)).project;
      const index = searchIndex();
      for (const ref of mine) {
        const doc = await project(partition, ref.type, ref.id);
        if (doc) await index.put(doc); else await index.remove(partition, docKey(ref.type, ref.id));
      }
    } catch (error) {
      console.warn(`[search-index] update after write failed for ${mine.map(r => docKey(r.type, r.id)).join(', ')} in ${partition}; marking the partition for rebuild:`, error instanceof Error ? error.message : error);
      try {
        const index = searchIndex();
        const meta = await index.getMeta(partition);
        if (meta) await index.setMeta(partition, { ...meta, retryAfter: new Date().toISOString() });
      } catch { /* the next read rebuilds when it can */ }
    }
  }
}

/** For synchronous writers (a simulated ingest tick): the same update, not awaited. */
export function noteSearchWriteSoon(...refs: Array<SearchWriteRef | null | undefined>): void {
  void noteSearchWrite(...refs);
}
