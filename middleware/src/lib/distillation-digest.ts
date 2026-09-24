// Per-tier content digests: the root of a distributed-core MerkleTree over
// `(id, updated_at)` of the tier's rows.
//
// The property the portal relies on, and the tests pin: a digest changes when
// and only when the tier's content changes. A row added, removed, or edited
// (which bumps its updated_at) moves the root; a read, a reorder, or a second
// computation over the same rows does not. That is what lets a client compare
// digests instead of refetching a tier, and what makes "replica in sync" a
// comparison of two strings rather than a claim.
//
// Built fresh per call over an in-memory KVStore — the tiers are small (tens
// to a few hundred rows in the mock corpus), and a cached tree would be one
// more thing that can disagree with the rows.

import { MerkleTree } from 'distributed-core/replication';
import { MemoryKVStore } from 'distributed-core/persistence';

/** Total order on string keys, shared by every store and tree in this domain
 *  so two trees over the same rows are built identically. */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The whole key space — a tier is one partition. */
export const FULL_RANGE = { lo: null, hi: null } as const;

export interface DigestRow {
  id: string;
  /** updated_at where the row has one; created_at for append-only L0. */
  stamp: string;
}

export async function tierDigest(rows: readonly DigestRow[]): Promise<string> {
  const store = new MemoryKVStore<string, string>({ compare: compareIds });
  for (const row of rows) await store.put(row.id, row.stamp);
  const tree = await MerkleTree.build({ store, range: FULL_RANGE, compare: compareIds });
  return tree.hash;
}
