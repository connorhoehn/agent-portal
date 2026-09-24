// The L2 read replica, kept in step by distributed-core anti-entropy.
//
// L2 (the distilled guides) is what the Library and every reader fetch most,
// so it gets a read replica: a `MemoryKVStore<artifactId, ArtifactRow>` fed
// from the source of truth (the artifacts store) and reconciled by a
// `MerkleSyncer`. The syncer builds a Merkle tree over each side, diffs them,
// and pulls only the divergent key ranges — in process here, through the
// `fetchSubtree`/`fetchValues` callbacks, which is the same API the library's
// HTTP transport implements for a replica on another node.
//
// Conflicts resolve last-writer-wins on `updated_at` through an HLCRegister.
// The primary's write carries logical counter 1 and the replica's 0, so on an
// exact `updated_at` tie the source of truth wins — the replica takes no
// writes of its own, so a tie can only mean the two copies disagree about the
// same edit. A key the primary no longer has is deleted from the replica.
//
// The replica holds deep COPIES. Sharing row objects with the primary would
// make every in-place edit (a publish flips `status` on the row) appear on
// the replica instantly, and "in sync" would be true by aliasing rather than
// by synchronisation — the sweep would never have anything to repair.
//
// Status (`GET /api/distillation/replication`) compares the replica's digest
// with the primary's, both computed by lib/distillation-digest.ts over
// `(id, updated_at)` — so the primary digest is exactly the L2 digest
// `/levels` reports, and "in sync" is a string comparison anyone can re-check.

import { MerkleSyncer, MerkleTree } from 'distributed-core/replication';
import { MemoryKVStore } from 'distributed-core/persistence';
import { HLCRegister } from 'distributed-core/crdt-primitives';
import type { ArtifactRow } from '../mock/distillation.js';
import { compareIds, FULL_RANGE, tierDigest } from './distillation-digest.js';

export const PRIMARY_NODE = 'l2-primary';
export const REPLICA_ID = 'l2-replica-1';

export interface ReplicaStatus {
  id: string;
  digest: string;
  /** How long the replica has disagreed with the primary; 0 when in sync. */
  lagMs: number;
  /** When the last anti-entropy sweep finished, or null before the first. */
  lastSync: string | null;
  /** Keys repaired across every sweep since boot (or since the last reset). */
  repaired: number;
}

export interface ReplicationStatus {
  primary: { id: string; digest: string };
  replicas: ReplicaStatus[];
  inSync: boolean;
}

export interface L2ReplicaOptions {
  /** The source of truth, read fresh on every sweep. */
  primaryRows: () => readonly ArtifactRow[];
  now: () => number;
  /** Sweep cadence for `start()`. */
  intervalMs?: number;
}

const stampOf = (row: ArtifactRow): number => {
  const ms = Date.parse(row.updated_at);
  return Number.isNaN(ms) ? 0 : ms;
};

/** LWW on updated_at via HLCRegister; primary wins an exact tie. */
export function resolveArtifact(local: ArtifactRow | undefined, remote: ArtifactRow | undefined): ArtifactRow | undefined {
  if (remote === undefined) return undefined;
  if (local === undefined) return remote;
  const register = new HLCRegister<ArtifactRow>({ v: local, ts: { l: stampOf(local), c: 0, nodeId: REPLICA_ID } });
  register.merge({ v: remote, ts: { l: stampOf(remote), c: 1, nodeId: PRIMARY_NODE } });
  return register.value() ?? remote;
}

export class L2Replica {
  readonly store = new MemoryKVStore<string, ArtifactRow>({ compare: compareIds });
  private readonly syncer: MerkleSyncer<string, ArtifactRow>;
  private repairedTotal = 0;
  private lastSyncMs: number | null = null;
  /** The last instant the two digests agreed; null = never observed agreeing. */
  private lastInSyncMs: number | null = null;
  private readonly createdMs: number;

  constructor(private readonly opts: L2ReplicaOptions) {
    this.createdMs = opts.now();
    this.syncer = new MerkleSyncer<string, ArtifactRow>({
      partition: {
        id: 'distillation-l2',
        keyRange: FULL_RANGE,
        owner: PRIMARY_NODE,
        replicas: [REPLICA_ID],
        replicationPolicy: { kind: 'single' },
        version: 1,
      },
      localNodeId: REPLICA_ID,
      localStore: this.store,
      resolve: { resolve: resolveArtifact },
      intervalMs: opts.intervalMs ?? 15_000,
      compare: compareIds,
      fetchSubtree: async (_replica: string, range: { lo: string | null; hi: string | null }) => MerkleTree.build({
        store: await this.primaryStore(), range, compare: compareIds,
      }),
      // Every primary key: the syncer filters to the divergent range itself,
      // and returning keys the replica lacks is how a missing row is learned
      // in the same sweep rather than on a later one.
      fetchValues: async () => {
        const out: Array<{ key: string; value: ArtifactRow }> = [];
        for await (const entry of (await this.primaryStore()).scan({ lo: null, hi: null, loInclusive: true, hiInclusive: true })) {
          out.push({ key: entry.key, value: entry.value });
        }
        return out;
      },
    });
  }

  /** A snapshot of the primary as a KVStore, copied so the replica never
   *  aliases a live row. */
  private async primaryStore(): Promise<MemoryKVStore<string, ArtifactRow>> {
    const store = new MemoryKVStore<string, ArtifactRow>({ compare: compareIds });
    for (const row of this.opts.primaryRows()) await store.put(row.id, structuredClone(row));
    return store;
  }

  private async replicaRows(): Promise<ArtifactRow[]> {
    const out: ArtifactRow[] = [];
    for await (const entry of this.store.scan({ lo: null, hi: null, loInclusive: true, hiInclusive: true })) out.push(entry.value);
    return out;
  }

  /** One anti-entropy sweep now. Returns the library's per-sweep result. */
  async sync(): Promise<{ keysCompared: number; keysRepaired: number; bytesExchanged: number }> {
    const result = await this.syncer.sync();
    this.repairedTotal += result.keysRepaired;
    this.lastSyncMs = this.opts.now();
    await this.status();
    return result;
  }

  async status(): Promise<ReplicationStatus> {
    const now = this.opts.now();
    const primaryDigest = await tierDigest(this.opts.primaryRows().map((r) => ({ id: r.id, stamp: r.updated_at })));
    const replicaDigest = await tierDigest((await this.replicaRows()).map((r) => ({ id: r.id, stamp: r.updated_at })));
    const inSync = primaryDigest === replicaDigest;
    if (inSync) this.lastInSyncMs = now;
    const since = this.lastInSyncMs ?? this.createdMs;
    return {
      primary: { id: PRIMARY_NODE, digest: primaryDigest },
      replicas: [{
        id: REPLICA_ID,
        digest: replicaDigest,
        lagMs: inSync ? 0 : Math.max(0, now - since),
        lastSync: this.lastSyncMs === null ? null : new Date(this.lastSyncMs).toISOString(),
        repaired: this.repairedTotal,
      }],
      inSync,
    };
  }

  /** Forget the replica's contents and counters — the mock reset's hook, so a
   *  reset world starts with an empty replica that the next sweep refills. */
  async clear(): Promise<void> {
    for (const row of await this.replicaRows()) await this.store.delete(row.id);
    this.repairedTotal = 0;
    this.lastSyncMs = null;
    this.lastInSyncMs = null;
  }
}
