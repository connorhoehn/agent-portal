// In-process event broker for the assessment tenant's Workspace/knowledge and
// agent-run surfaces. Mirrors `canary-broker.ts` exactly — three sinks:
//   1. stdout (JSON lines) — Docker / ECS picks them up for log shipping
//   2. in-memory replay store — a PARTITIONED set of small rings, queried for
//      SSE catch-up replay (routes/assessment.ts GET /events, Last-Event-ID
//      aware); see `ReplayStore` below
//   3. live subscribers — SSE consumers receive each event as it happens
//
// The store is process-local — if middleware is scaled horizontally, swap
// for Redis pub/sub or DynamoDB Streams, same as canary-broker's note.
//
// Unlike canary-broker, each buffered event carries a monotonic `seq` so a
// reconnecting EventSource (browser sets the `Last-Event-ID` request header
// to the last `id:` line it saw) can replay only what it missed instead of
// the whole buffer — see routes/assessment.ts's `/events` handler.

export interface PresenceViewer {
  sub: string;
  name: string;
  tab_id: string;
  /** ISO timestamp of this viewer's (tab's) first `enter` — stable across
   *  heartbeats, so the client can show "viewing since". */
  since: string;
}

export type AssessmentEvent =
  | { type: 'knowledge.pulled'; section: string; pages: number; files_pulled: number; ts: string }
  | { type: 'knowledge.published'; id: string; page_id: string; version: number; ts: string }
  | { type: 'knowledge.doc.saved'; id: string; stamp: string; by: string; ts: string }
  | { type: 'knowledge.moved'; id: string; parent_id: string | null; position: number; by: string; ts: string }
  | { type: 'knowledge.renamed'; id: string; title: string; by: string; ts: string }
  | { type: 'knowledge.comment.created'; id: string; doc_id: string; by: string; body: string; ts: string }
  | { type: 'knowledge.comment.edited'; id: string; doc_id: string; by: string; body: string; ts: string }
  | { type: 'knowledge.comment.deleted'; id: string; doc_id: string; by: string; ts: string }
  | { type: 'knowledge.reaction.toggled'; doc_id: string; target_id: string; emoji: string; by: string; reacted: boolean; ts: string }
  | { type: 'knowledge.presence'; doc_id: string; viewers: PresenceViewer[]; ts: string }
  | { type: 'run.started'; run_id: string; command: string; team_id: string | null; ts: string }
  | { type: 'run.progress'; run_id: string; command: string; team_id: string | null; percent: number; ts: string }
  | { type: 'run.completed'; run_id: string; command: string; team_id: string | null; summary: string; ts: string }
  | { type: 'run.failed'; run_id: string; command: string; team_id: string | null; reason: string; ts: string };

/** Sent to a single reconnecting client when its Last-Event-ID predates the
 *  ring buffer's retention — see `gapFrameFor`. Never published/buffered. */
export interface StreamGapEvent {
  type: 'stream.gap';
  ts: string;
}

export interface BufferedAssessmentEvent {
  seq: number;
  event: AssessmentEvent;
}

// ─── Replay partitioning (REVIEW-2026-09-05 finding #7) ────────────────────
//
// This used to be ONE module-level array of 500 entries backing presence,
// knowledge saves, comments, pulls and run progress for the whole process.
// `decideReplay` + `REPLAY_MAX_AGE_MS` made it survivable — nothing was ever
// lost while being reported as delivered — but the loudest event type
// (`knowledge.presence`, republished on every roster change across every doc)
// shared one FIFO with the quietest and most valuable (`knowledge.doc.saved`),
// so a busy tenant evicted a save behind roster churn and the reconnecting
// client got an honest `stream.gap` for something it need never have lost.
//
// The store is now a `Map<partitionKey, ring>`. The key is
// `<channel>:<resource-id>`:
//
//   knowledge.presence          -> presence:<doc_id>
//   knowledge.doc.saved         -> doc:<id>
//   knowledge.published         -> doc:<id>
//   knowledge.moved             -> doc:<id>
//   knowledge.renamed           -> doc:<id>
//   knowledge.comment.created   -> doc:<doc_id>
//   knowledge.comment.edited    -> doc:<doc_id>
//   knowledge.comment.deleted   -> doc:<doc_id>
//   knowledge.pulled            -> pull:<section>
//   run.progress                -> run-progress:<run_id>
//   run.started/completed/failed-> run:<run_id>
//
// Two axes, both load-bearing:
//
//   * The CHANNEL separates cadence classes. Machine-cadence, full-state
//     snapshots (`presence`, `run-progress`) are `superseding`: the ring holds
//     exactly ONE entry per key, because a newer roster/percent completely
//     replaces the older one for that resource — the portal reads only the
//     newest of each (`presenceForDoc`, `applyRunEvent` in
//     portal/src/pages/assessment/knowledge/knowledgeFormat.ts). Human-cadence
//     business events (`doc`, `run`, `pull`) get a real ring and real history.
//   * The RESOURCE ID keeps one hot doc/run/section from starving another.
//     It is the finest discriminator the events actually carry.
//
// TENANCY: the key deliberately carries NO tenant segment. Every event on this
// broker is an assessment-tenant event by construction — the only publishers
// are providers/assessment.ts and the only reader is `assessmentRouter`, which
// is mounted behind `requireTenant('assessment')` — so a tenant segment would
// be a constant, buying no isolation and costing a key explosion. It would
// also be security theatre: the SSE stream is not tenant-filtered per
// subscriber, every subscriber already sees every event on the broker, and
// partitioning RETENTION could not change that; `requireTenant` is what keeps
// another tenant off this route. If a second tenant is ever published here,
// `partitionKeyFor` is the one place to prepend the tenant — and the resource
// ids would have to be made tenant-unique at the same time.
export type ReplayChannel = 'presence' | 'doc' | 'pull' | 'run' | 'run-progress';

export interface ChannelPolicy {
  /** Max entries held for ONE key in this channel. */
  capacity: number;
  /**
   * True when a newer event for the same key is a complete replacement for
   * the older one, so displacing the older one loses nothing a client could
   * observe — and therefore must NOT raise the gap watermark. Only ever true
   * for full-state snapshots (`capacity: 1`).
   */
  superseding: boolean;
}

export const REPLAY_CHANNELS: Readonly<Record<ReplayChannel, ChannelPolicy>> = {
  // One roster per doc. Superseding: a `knowledge.presence` frame is the
  // complete viewer list as of `ts`; the previous one carries strictly less
  // truth. Replaying forty stale rosters helps nobody.
  presence: { capacity: 1, superseding: true },
  // One percent per run, same argument (`applyRunEvent` overwrites the row).
  'run-progress': { capacity: 1, superseding: true },
  // Saves / publishes / comments for one doc. Saves are user-initiated (the
  // Save button — DocPane does NOT autosave), comments are typed, so 64 in a
  // 30-minute window is well past any realistic burst on a single doc.
  doc: { capacity: 64, superseding: false },
  // A run emits started + exactly one terminal event; 16 covers retries.
  run: { capacity: 16, superseding: false },
  // Section sync progress; a pull emits one per page batch.
  pull: { capacity: 32, superseding: false },
};

// Backstop against key explosion. Retirement is age-first (see `sweep`); this
// LRU cap only fires if more than this many DISTINCT resources are active
// inside one `REPLAY_MAX_AGE_MS` window. Worst-case retained events is
// MAX_PARTITIONS x the largest capacity above = 256 x 64 = 16,384 tiny
// objects, and only if every partition is a saturated `doc:` ring; the real
// steady state is "whatever was published in the last 30 minutes", which on
// this tenant is orders of magnitude smaller than the old flat 500.
export const MAX_PARTITIONS = 256;

/** The replay partition an event belongs to. */
export function partitionKeyFor(event: AssessmentEvent): string {
  switch (event.type) {
    case 'knowledge.presence': return `presence:${event.doc_id}`;
    case 'knowledge.doc.saved': return `doc:${event.id}`;
    case 'knowledge.published': return `doc:${event.id}`;
    case 'knowledge.moved': return `doc:${event.id}`;
    case 'knowledge.renamed': return `doc:${event.id}`;
    case 'knowledge.comment.created': return `doc:${event.doc_id}`;
    case 'knowledge.comment.edited': return `doc:${event.doc_id}`;
    case 'knowledge.comment.deleted': return `doc:${event.doc_id}`;
    case 'knowledge.reaction.toggled': return `doc:${event.doc_id}`;
    case 'knowledge.pulled': return `pull:${event.section}`;
    case 'run.progress': return `run-progress:${event.run_id}`;
    case 'run.started':
    case 'run.completed':
    case 'run.failed': return `run:${event.run_id}`;
  }
  // Unreachable for a well-typed event; a malformed one must not be able to
  // take `publish` down, so it lands in a shared catch-all rather than
  // dereferencing an undefined channel policy.
  return 'doc:__unknown__';
}

/** The channel half of a partition key. */
export function channelOf(key: string): ReplayChannel {
  return key.slice(0, key.indexOf(':')) as ReplayChannel;
}

/**
 * The partitioned replay store.
 *
 * Every drop is accounted for. `droppedThroughSeq` is a single monotonic
 * watermark: the highest `seq` this store has discarded in a way a client
 * could notice. `decideReplay` gaps a reconnect exactly when
 * `afterSeq < droppedThroughSeq` — which is precisely "at least one event the
 * client had not seen was thrown away". That is O(1), never itself leaks, and
 * is strictly MORE accurate than the flat buffer's `afterSeq < oldest - 1`
 * heuristic, which was only ever valid because a single ring had contiguous
 * seqs. With partitions the merged view has legitimate holes (other keys'
 * events still held elsewhere), so the old heuristic would have cried gap on
 * every reconnect; the watermark is why partitioning does NOT quietly retire
 * the `stream.gap` signal.
 *
 * The ONE drop that does not raise the watermark is in-place supersession in a
 * `superseding` channel, and that is provably lossless: the entry that
 * displaced it has a strictly higher seq, is for the same resource, and
 * carries the same state newer — so it is in the same replay whenever the
 * displaced one would have been. (If the replacement is itself too old to
 * replay, the age filter in `decideReplay` gaps the client anyway.)
 */
class ReplayStore {
  /** Insertion-ordered; re-inserted on every push so iteration order is LRU. */
  private readonly parts = new Map<string, BufferedAssessmentEvent[]>();
  private dropped = 0;

  constructor(
    private readonly maxAgeMs: number,
    private readonly maxPartitions: number,
  ) {}

  private note(seq: number): void {
    if (seq > this.dropped) this.dropped = seq;
  }

  push(buffered: BufferedAssessmentEvent, nowMs: number): void {
    const key = partitionKeyFor(buffered.event);
    const policy = REPLAY_CHANNELS[channelOf(key)] ?? REPLAY_CHANNELS.doc;
    const ring = this.parts.get(key) ?? [];
    // Delete-then-set moves this key to the tail of the Map's iteration
    // order, which is what makes `retireLru` an LRU rather than a FIFO.
    this.parts.delete(key);
    ring.push(buffered);
    while (ring.length > policy.capacity) {
      const out = ring.shift();
      if (out && !policy.superseding) this.note(out.seq);
    }
    this.parts.set(key, ring);
    this.sweep(nowMs);
    this.retireLru();
  }

  /**
   * Key retirement, part 1 — AGE. Anything older than `maxAgeMs` is dropped
   * and a partition left empty is deleted outright. This is safe because
   * `decideReplay` refuses to deliver an event older than that bound: a
   * partition whose newest entry has aged out cannot contribute a single
   * frame to any future replay, so retiring it costs a client nothing it
   * could have received. It is the primary bound on the map's size — a doc
   * nobody has touched in 30 minutes stops occupying a key at all.
   *
   * Dropping here DOES raise the watermark (superseding channels included):
   * with the events still held, `decideReplay`'s `agedOut` branch would have
   * gapped exactly the clients whose `afterSeq` sat behind them, so the
   * watermark reproduces the pre-existing signal rather than silencing it.
   */
  private sweep(nowMs: number): void {
    const floorMs = nowMs - this.maxAgeMs;
    for (const [key, ring] of this.parts) {
      while (ring.length > 0 && eventTs(ring[0]!.event) < floorMs) this.note(ring.shift()!.seq);
      if (ring.length === 0) this.parts.delete(key);
    }
  }

  /**
   * Key retirement, part 2 — the LRU BACKSTOP. Age retirement alone bounds
   * the map only if resource ids are reused; a pathological burst of distinct
   * doc/run ids inside one window would still grow it without limit. The
   * least-recently-published partition goes first, and every event it still
   * held raises the watermark, so a client that needed one of them is told
   * `stream.gap` rather than quietly under-served.
   */
  private retireLru(): void {
    while (this.parts.size > this.maxPartitions) {
      const oldest = this.parts.keys().next().value;
      if (oldest === undefined) return;
      const ring = this.parts.get(oldest);
      const last = ring?.[ring.length - 1];
      if (last) this.note(last.seq);
      this.parts.delete(oldest);
    }
  }

  /** Merged, seq-ordered view across every partition — global publish order,
   *  minus whatever was dropped. Age-swept first so an idle process never
   *  serves something the age bound would reject anyway. */
  snapshot(nowMs = Date.now()): BufferedAssessmentEvent[] {
    this.sweep(nowMs);
    const all: BufferedAssessmentEvent[] = [];
    for (const ring of this.parts.values()) all.push(...ring);
    return all.sort((a, b) => a.seq - b.seq);
  }

  get droppedThroughSeq(): number { return this.dropped; }
  get partitionCount(): number { return this.parts.size; }
  get size(): number {
    let n = 0;
    for (const ring of this.parts.values()) n += ring.length;
    return n;
  }
  keys(): string[] { return [...this.parts.keys()]; }
}

// How far back a RECONNECTING client (one presenting a Last-Event-ID) is
// allowed to catch up. Fixed for DEFECTS #5/#8/#7 (see decideReplay): the
// ring buffer is sized by EVENT COUNT, not age, so on a quiet tenant it can
// hold events from hours ago — a genuine reconnect after a real gap (a
// laptop sleep, a slow network blip) should be told "you missed things,
// here's the gap", not silently fed an hour-old save framed as brand new.
// 30 minutes comfortably covers a coffee-break reconnect while still being
// short enough that nothing past it is worth replaying as if it just
// happened; DocPane's own notice always renders the event's real age via
// `relativeTime` regardless, so this bound is a courtesy, not the only
// guard against "just now" on a stale event.
export const REPLAY_MAX_AGE_MS = 30 * 60 * 1000;

/** Every `AssessmentEvent` variant carries `ts` — pull it out generically. */
function eventTs(event: AssessmentEvent): number {
  return new Date(event.ts).getTime();
}

/**
 * The pure replay/age policy behind GET /events (DEFECTS #5 assessor / #8
 * lead-assessor / #7 program-lead+admin: a freshly opened tab was told an
 * hours-old edit happened "just now"). Two decisions, each independently
 * justified:
 *
 * 1. NO Last-Event-ID (`afterSeq === undefined`) means a genuinely fresh
 *    connection — there is no prior view of this stream to catch up. The old
 *    code replayed the whole ring buffer here, which is how a brand-new tab
 *    ended up being told about a save from 101 minutes ago. A fresh
 *    connection has nothing to miss yet, so it gets nothing: `events: []`,
 *    never gapped. It starts seeing the stream from whatever is published
 *    from this moment on (the route's live `subscribe` picks up immediately
 *    after this returns). This is a deliberate behavior change from
 *    "replay everything held" to "replay nothing" for this one case —
 *    presence's next heartbeat (<=15s) republishes the current roster to
 *    every subscriber including this one, so the one surface that depends on
 *    "current state, not history" self-heals quickly rather than needing its
 *    own snapshot endpoint.
 *
 * 2. A Last-Event-ID present (`afterSeq` defined) IS a reconnect that wants
 *    the gap — but only up to `maxAgeMs` old. Retention is sized by EVENT
 *    COUNT per partition, not age, so on a quiet tenant it can hold something
 *    from hours ago; replaying that to a client reconnecting after a real gap
 *    (laptop sleep, flaky wifi) would be exactly the same "just now" lie, just
 *    reached via a different path. Events older than `maxAgeMs` are dropped
 *    from the reply, and dropping any (whether from eviction or the age
 *    bound) marks the result `gapped` so the route can tell the client
 *    something was missed rather than silently under-delivering.
 *
 * `droppedThroughSeq` is how eviction is detected. Pass the store's watermark
 * (the highest seq it has discarded) and the answer is exact: the client
 * missed a discarded event iff `afterSeq < droppedThroughSeq`. Omit it — as
 * the pure unit tests do, and as any caller holding a genuinely CONTIGUOUS
 * buffer may — and it falls back to the flat-ring heuristic "afterSeq sits
 * further back than the slot before the oldest held entry". That heuristic is
 * only sound when seqs are contiguous, which is exactly what partitioning
 * gives up, so `ReplayStore`-backed callers must pass the watermark.
 */
export function decideReplay(
  buffer: readonly BufferedAssessmentEvent[],
  afterSeq: number | undefined,
  nowMs: number,
  maxAgeMs: number = REPLAY_MAX_AGE_MS,
  droppedThroughSeq?: number,
): { events: BufferedAssessmentEvent[]; gapped: boolean } {
  if (afterSeq === undefined) return { events: [], gapped: false };

  const missed = buffer.filter((b) => b.seq > afterSeq);
  const floorMs = nowMs - maxAgeMs;
  const events = missed.filter((b) => eventTs(b.event) >= floorMs);

  // Eviction: at least one event the client had not seen was discarded.
  const oldest = buffer[0]?.seq;
  const evicted = droppedThroughSeq !== undefined
    ? afterSeq < droppedThroughSeq
    : oldest !== undefined && afterSeq < oldest - 1;
  // Age eviction: some of what's still held between afterSeq and now was
  // excluded for being older than maxAgeMs — a real miss even though the
  // store never dropped it.
  const agedOut = events.length < missed.length;

  return { events, gapped: evicted || agedOut };
}

// A tab that stops heartbeating (closed without a `leave` — a crash, a
// killed tab, a lost network) ages out after this long. DocPane heartbeats
// every 15s, so 45s tolerates two missed beats before dropping the viewer.
const PRESENCE_TTL_MS = 45_000;

// A `leave` doesn't delete the entry outright — it stages the delete this
// far out. `enter`'s `touch` for the same tab_id (StrictMode's guaranteed
// mount->unmount->mount, or a fast navigate-away-and-back) is a fire-and-
// forget request racing the unmount's own `leave`; when the stale `leave`
// lands just after the remount's `touch`, an unconditional delete dropped
// the viewer from their own roster for up to PRESENCE_TTL_MS. A short grace
// gives the remount's `touch` a chance to cancel the pending delete first.
const PRESENCE_LEAVE_GRACE_MS = 2_000;

interface PresenceEntry {
  sub: string;
  name: string;
  tabId: string;
  since: string;
  lastSeenMs: number;
  /** Set while a `leave` is staged and not yet finalized. The entry stays in
   *  `presence` (and therefore in `viewersFor`'s output) the whole time — a
   *  viewer in grace must not flicker out of anyone's roster. */
  sequence?: number;
  leaving?: boolean;
  leaveTimer?: ReturnType<typeof setTimeout>;
}

type Subscriber = (buffered: BufferedAssessmentEvent) => void;

class AssessmentBroker {
  private readonly store = new ReplayStore(REPLAY_MAX_AGE_MS, MAX_PARTITIONS);
  private readonly subscribers = new Set<Subscriber>();
  private seq = 0;
  // Boot epoch, part of every SSE frame id (`<epoch>-<seq>`). `seq` restarts
  // at 1 whenever the process restarts; a tab that lived through the restart
  // reconnects with its old Last-Event-ID and dedupes incoming frames by id,
  // so without the epoch every new event collided with an id it had already
  // seen and was dropped in silence — the tab looked "Live" and never
  // updated again (the BFF-mode two-tab proof caught exactly this after a
  // dev restart). The epoch makes ids unique across restarts and tells the
  // catch-up path when a client's seq belongs to a previous life.
  readonly epoch: string = `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
  // docId -> tabId -> viewer. Process-local, same caveat as the replay store
  // above — a horizontally-scaled middleware needs a shared store instead.
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();

  publish(event: AssessmentEvent): BufferedAssessmentEvent {
    this.seq += 1;
    const buffered: BufferedAssessmentEvent = { seq: this.seq, event };

    // 1. stdout JSON line — picked up by log shippers.
    process.stdout.write(JSON.stringify(buffered) + '\n');

    // 2. partitioned replay store. Retention only; the live fan-out below is
    //    unconditional, so an event dropped here (backdated past the age
    //    bound, say) still reaches every connected client.
    this.store.push(buffered, Date.now());

    // 3. fan out to live subscribers; don't let a bad subscriber kill the emit.
    for (const sub of this.subscribers) {
      try {
        sub(buffered);
      } catch {
        // swallow
      }
    }
    return buffered;
  }

  subscribe(cb: Subscriber): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Raw merged snapshot of the replay store in seq (publish) order, with no
   * client-facing policy applied. With `afterSeq` given, only events with
   * `seq > afterSeq` are returned. GET /events does NOT call this directly
   * any more — it calls `catchUp`, which applies the no-Last-Event-ID and
   * age-bound rules on top of exactly this filter (see `decideReplay`).
   * Kept as the low-level primitive other callers/tests build on.
   */
  replay(afterSeq?: number): BufferedAssessmentEvent[] {
    const all = this.store.snapshot();
    if (afterSeq === undefined) return all;
    return all.filter((b) => b.seq > afterSeq);
  }

  /**
   * The client-facing catch-up decision for GET /events — see `decideReplay`
   * for the policy and its rationale. Wraps the pure function with this
   * broker's own store/clock so the route only has to call one thing. The
   * store's `droppedThroughSeq` watermark is what keeps `gapped` honest now
   * that the merged snapshot legitimately has holes in it.
   */
  catchUp(afterSeq: number | undefined, nowMs = Date.now()): { events: BufferedAssessmentEvent[]; gapped: boolean } {
    return decideReplay(this.store.snapshot(nowMs), afterSeq, nowMs, REPLAY_MAX_AGE_MS, this.store.droppedThroughSeq);
  }

  /** Retention introspection for tests/diagnostics — never a client surface. */
  replayStats(): { partitions: number; events: number; droppedThroughSeq: number; keys: string[] } {
    return {
      partitions: this.store.partitionCount,
      events: this.store.size,
      droppedThroughSeq: this.store.droppedThroughSeq,
      keys: this.store.keys(),
    };
  }

  /**
   * Builds the SSE frame a reconnecting client should be told about a gap.
   * Not stored in the ring buffer (it's synthesized per-reconnect, not a
   * tenant event), so it never appears in `replay`/`catchUp` output; its id
   * still comes from `frameId` so a client's Last-Event-ID bookkeeping
   * treats it like any other frame. The route calls this only when
   * `catchUp(...).gapped` is true — see routes/assessment.ts's `/events`.
   */
  gapFrame(nowMs = Date.now()): { id: string; event: StreamGapEvent } {
    return { id: this.frameId(this.seq), event: { type: 'stream.gap', ts: new Date(nowMs).toISOString() } };
  }

  /** The SSE frame id for a buffered event: unique across process restarts. */
  frameId(seq: number): string {
    return `${this.epoch}-${seq}`;
  }

  /**
   * Turn a client's Last-Event-ID back into a catch-up floor. Only an id
   * minted by THIS process life yields a seq; an id from a previous epoch
   * (or a bare number from before ids carried one) means "replay everything
   * still held" — the client's seq is meaningless against a restarted counter.
   */
  afterSeqFromLastEventId(lastEventId: string | undefined): number | undefined {
    if (!lastEventId) return undefined;
    const dash = lastEventId.lastIndexOf('-');
    if (dash <= 0) return undefined;
    if (lastEventId.slice(0, dash) !== this.epoch) return undefined;
    const n = Number(lastEventId.slice(dash + 1));
    return Number.isFinite(n) ? n : undefined;
  }

  // ─── Presence ──────────────────────────────────────────────────────────
  //
  // `touch` backs both the `enter` and `heartbeat` actions on
  // POST /knowledge/presence — a fresh tab_id is registered, a known one
  // just gets its clock reset. Either way stale entries (silently dead
  // tabs) are purged first, and a `knowledge.presence` event is published
  // only when the VISIBLE roster actually changed (a join, a purge) — a
  // plain heartbeat that changes nothing stays quiet, so two tabs
  // heartbeating every 15s don't spam every viewer's SSE stream forever.

  /** Removes tab entries idle past PRESENCE_TTL_MS for one doc. Returns
   *  whether it removed anything (the caller decides whether that alone
   *  warrants a publish). No publish here — batched with the caller's own
   *  change so a touch+purge in the same call only emits once. */
  private purgeStale(docId: string, nowMs: number): boolean {
    const doc = this.presence.get(docId);
    if (!doc) return false;
    let changed = false;
    for (const [tabId, entry] of doc) {
      if (nowMs - entry.lastSeenMs > PRESENCE_TTL_MS) {
        if (entry.leaveTimer) clearTimeout(entry.leaveTimer);
        doc.delete(tabId);
        changed = true;
      }
    }
    if (doc.size === 0) this.presence.delete(docId);
    return changed;
  }

  touch(docId: string, tabId: string, sub: string, name: string, nowMs = Date.now(), sequence?: number): void {
    const purged = this.purgeStale(docId, nowMs);
    const doc = this.presence.get(docId) ?? new Map<string, PresenceEntry>();
    const existing = doc.get(tabId);
    if (existing?.sequence !== undefined && (sequence === undefined || sequence <= existing.sequence)) return;
    const isNewTab = !existing;
    // Cancel a pending grace-period delete for this tab — this `touch` IS
    // the remount's `enter`/heartbeat that proves the tab never really left.
    // Drop the old entry object (with its timer reference) rather than
    // mutating it, so nothing schedules against a stale closure.
    if (existing?.leaveTimer) clearTimeout(existing.leaveTimer);
    doc.set(tabId, {
      sub, name, tabId,
      since: existing?.since ?? new Date(nowMs).toISOString(),
      lastSeenMs: nowMs, sequence,
    });
    this.presence.set(docId, doc);
    // Cancelling a pending leave is not itself a roster change (the viewer
    // was listed throughout the grace window) — only a brand-new tab or a
    // purge of OTHER stale entries warrants a publish here.
    if (isNewTab || purged) this.publishPresence(docId, nowMs);
  }

  leave(docId: string, tabId: string, nowMs = Date.now(), sequence?: number): void {
    const purged = this.purgeStale(docId, nowMs);
    const doc = this.presence.get(docId);
    const entry = doc?.get(tabId);
    if (entry?.sequence !== undefined && (sequence === undefined || sequence <= entry.sequence)) return;
    if (!entry || entry.leaving) {
      // No such tab, or a leave already staged (duplicate sendBeacon) — the
      // roster itself doesn't change here either way.
      if (purged) this.publishPresence(docId, nowMs);
      return;
    }
    entry.sequence = sequence;
    entry.leaving = true;
    entry.leaveTimer = setTimeout(() => this.finalizeLeave(docId, tabId), PRESENCE_LEAVE_GRACE_MS);
    entry.leaveTimer.unref?.();
    // No publish: the viewer stays listed (in grace) until the timer fires
    // or a `touch` cancels it — this is the flicker fix.
    if (purged) this.publishPresence(docId, nowMs);
  }

  /** Fires PRESENCE_LEAVE_GRACE_MS after an uncancelled `leave`. A `touch`
   *  in the meantime clears this timer, so by the time it runs the entry is
   *  either gone (never happens — clearTimeout prevents that) or still
   *  genuinely `leaving`; finalize the delete and publish the shrunk roster. */
  private finalizeLeave(docId: string, tabId: string): void {
    const doc = this.presence.get(docId);
    const entry = doc?.get(tabId);
    if (!doc || !entry || !entry.leaving) return;
    doc.delete(tabId);
    if (doc.size === 0) this.presence.delete(docId);
    this.publishPresence(docId, Date.now());
  }

  /** Current viewers for one doc, TTL-purged as of `nowMs`. Read-only — does
   *  not publish (the route only needs this for tests / debugging; clients
   *  get the roster over SSE). */
  viewersFor(docId: string, nowMs = Date.now()): PresenceViewer[] {
    this.purgeStale(docId, nowMs);
    const doc = this.presence.get(docId);
    if (!doc) return [];
    return [...doc.values()].map(({ sub, name, tabId, since }) => ({ sub, name, tab_id: tabId, since }));
  }

  private publishPresence(docId: string, nowMs: number): void {
    this.publish({ type: 'knowledge.presence', doc_id: docId, viewers: this.viewersFor(docId, nowMs), ts: new Date(nowMs).toISOString() });
  }
}

export const assessmentBroker = new AssessmentBroker();
