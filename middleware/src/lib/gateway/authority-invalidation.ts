// The ONE invalidation seam for the gateway's authority verdict cache
// (realtime-modules 0.120 `withAuthorityCache`, contract V1–V7 in its
// src/server/authority/verdictCache.ts).
//
// The cache keeps POSITIVE channel verdicts per (connection, kind, channel,
// epoch). A refusal is never cached, so a GRANT is admitted on the next frame
// without help from here. What the cache cannot see on its own is a REMOVAL:
// every write that can turn a cached `true` into `false` must call one of the
// three functions below after it commits, or the old verdict keeps admitting
// frames until `maxAgeMs`. The list of such writes is pinned by
// lib/gateway/__tests__/authority-invalidation-coverage.test.ts, which fails
// when a known authority write stops calling this module.
//
//   invalidateForUser(userId)  grants, roles, session epoch, a deleted clone,
//                              a team roster removal: every verdict held by
//                              that user's connections, and every connection
//                              acting as that user (masquerade), on the next check;
//   invalidateChannel(channel) one conversation's membership, seats or row:
//                              every verdict on that name (all service
//                              prefixes) and the names derived from it;
//   invalidateAll(reason)      anything that cannot be scoped: a Cedar policy
//                              edit, an access delegation, a mock world switch.
//
// Each call does three things, in this order:
//   1. bumps a generation that `authorityEpoch` folds into the cache key, so a
//      host check that was in flight when the write committed cannot store its
//      (now stale) verdict, and a lookup under the old key is fenced (V1);
//   2. drops the matching entries in the bound cache now (V3);
//   3. tells the other gateway replicas over the Redis router's peer events
//      (`orgiq:authority`); they apply steps 1–2 locally and never re-publish.
// Membership writes on the Social chat store reach peers on the router's own
// membership topic (`social:membership`), whose verdict hook is `applyChannel`.
//
// This module imports nothing from the app, so any provider can call it
// without an import cycle. With no cache bound (the flag is off, or the
// gateway is not attached) the calls only bump generations.

/** The cache surface the seam drives (realtime-modules `AuthorityVerdictCache`). */
export interface AuthorityCacheTarget {
  invalidateChannel(channel: string): void;
  invalidateUser(userId: string): void;
  clear(): void;
}

/** The Redis router's peer events (`RedisRealtimeRouter.peerEvents`). */
export interface AuthorityPeerEvents {
  publish(topic: string, payload: string): Promise<void>;
  subscribe(topic: string, handler: (payload: string) => void): () => void;
}

export const AUTHORITY_PEER_TOPIC = 'orgiq:authority';

type Op = { op: 'user'; id: string } | { op: 'channel'; id: string } | { op: 'all' };

let target: AuthorityCacheTarget | null = null;
let peers: AuthorityPeerEvents | null = null;
let globalGeneration = 0;
const userGenerations = new Map<string, number>();
const MAX_NAME = 512;

const counters = { user: 0, channel: 0, all: 0, peerApplied: 0, peerRejected: 0, publishFailed: 0 };
type Listener = (event: Op & { reason: string; origin: 'local' | 'peer' }) => void;
const listeners = new Set<Listener>();

/** Names whose verdicts are derived from `channel`'s membership and must go with it. */
export function dependentChannels(channel: string): string[] {
  const out = [channel];
  // The Social work graph's per-conversation stream admits exactly the
  // conversation's readers (live-principal.ts authorizeSocialWorkGraphChannel).
  if (/^social:(?:ch|dm|team|room):/.test(channel)) out.push(`social:workgraph:conversation:${channel}`);
  return out;
}

function emit(event: Op, reason: string, origin: 'local' | 'peer'): void {
  for (const listener of listeners) {
    try { listener({ ...event, reason, origin }); } catch { /* observers never fail a write */ }
  }
}

function apply(event: Op): void {
  try {
    if (event.op === 'user') {
      userGenerations.set(event.id, (userGenerations.get(event.id) ?? 0) + 1);
      target?.invalidateUser(event.id);
    } else if (event.op === 'channel') {
      for (const name of dependentChannels(event.id)) target?.invalidateChannel(name);
    } else {
      globalGeneration += 1;
      // The global generation is part of every key, so per-user counters can
      // restart without any key repeating.
      userGenerations.clear();
      target?.clear();
    }
  } catch (error) {
    // A cache that throws must not keep serving: drop everything.
    console.warn('[authority-invalidation] cache invalidation failed; clearing', error);
    globalGeneration += 1;
    try { target?.clear(); } catch { /* nothing left to do */ }
  }
}

function publish(event: Op): void {
  if (!peers) return;
  void peers.publish(AUTHORITY_PEER_TOPIC, JSON.stringify(event)).catch((error: unknown) => {
    counters.publishFailed += 1;
    console.warn('[authority-invalidation] peer invalidation failed', error);
  });
}

function local(event: Op, reason: string): void {
  counters[event.op] += 1;
  apply(event);
  emit(event, reason, 'local');
  publish(event);
}

/** A user's grants, roles, session epoch or team membership changed (after commit). */
export function invalidateForUser(userId: string, reason = 'user'): void {
  if (typeof userId !== 'string' || !userId || userId.length > MAX_NAME) return;
  local({ op: 'user', id: userId }, reason);
}

/** A channel's membership, seats or resource row changed (after commit). */
export function invalidateChannel(channel: string, reason = 'channel'): void {
  if (typeof channel !== 'string' || !channel || channel.length > MAX_NAME) return;
  local({ op: 'channel', id: channel }, reason);
}

/** A change that cannot be scoped to a user or channel (after commit). */
export function invalidateAll(reason: string): void {
  local({ op: 'all' }, reason);
}

/**
 * The local half of `invalidateChannel` (no peer publish): the Redis router's
 * membership-event hook (`RedisRealtimeRouter({ authorityCache })`) and the
 * chat store's committed-write observer call this, because the router already
 * carries the event to the peers on its own topic.
 */
export function applyChannel(channel: string, reason = 'membership'): void {
  if (typeof channel !== 'string' || !channel || channel.length > MAX_NAME) return;
  counters.channel += 1;
  apply({ op: 'channel', id: channel });
  emit({ op: 'channel', id: channel }, reason, 'local');
}

/**
 * The cache key's epoch for one connection (verdictCache.ts V1): the signed
 * session epoch (and the masquerading actor's), plus this seam's generations
 * for both users and the global one. null (do not cache) for a context
 * without a user id or a well-formed epoch.
 */
export function authorityEpoch(ctx: Record<string, unknown> | null | undefined): string | null {
  if (!ctx || typeof ctx['userId'] !== 'string' || !ctx['userId']) return null;
  const userId = ctx['userId'];
  const epoch = ctx['epoch'] === undefined ? 0 : ctx['epoch'];
  if (!Number.isSafeInteger(epoch)) return null;
  let key = `${globalGeneration}|${String(epoch)}|${userGenerations.get(userId) ?? 0}`;
  const act = ctx['act'];
  if (act !== undefined) {
    if (!act || typeof act !== 'object') return null;
    const { sub, epoch: actEpoch } = act as { sub?: unknown; epoch?: unknown };
    if (typeof sub !== 'string' || !sub || !Number.isSafeInteger(actEpoch ?? 0)) return null;
    key += `|${sub}|${String(actEpoch ?? 0)}|${userGenerations.get(sub) ?? 0}`;
  }
  return key;
}

function parsePeer(payload: string): Op | null {
  let raw: unknown;
  try { raw = JSON.parse(payload); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const { op, id } = raw as { op?: unknown; id?: unknown };
  if (op === 'all') return { op };
  if ((op === 'user' || op === 'channel') && typeof id === 'string' && id && id.length <= MAX_NAME) return { op, id };
  return null;
}

/**
 * Bind the gateway's verdict cache (and, with Redis routing, the peers).
 * Returns the unbind. One binding at a time: a second bind replaces the first.
 */
export function bindAuthorityCache(cache: AuthorityCacheTarget, opts: { peers?: AuthorityPeerEvents | null } = {}): () => void {
  target = cache;
  peers = opts.peers ?? null;
  const stopPeers = peers?.subscribe(AUTHORITY_PEER_TOPIC, payload => {
    const event = parsePeer(payload);
    if (!event) { counters.peerRejected += 1; return; }
    counters.peerApplied += 1;
    apply(event);
    emit(event, 'peer', 'peer');
  }) ?? null;
  const bound = cache;
  return () => {
    stopPeers?.();
    if (target === bound) { target = null; peers = null; }
  };
}

/** Observe every invalidation (tests, the stats line). Returns the unsubscribe. */
export function onAuthorityInvalidation(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Counters since boot, for the stats line and tests. */
export function authorityInvalidationStats(): typeof counters & { bound: boolean; peers: boolean } {
  return { ...counters, bound: target !== null, peers: peers !== null };
}
