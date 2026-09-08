// In-process event broker for the assessment tenant's Workspace/knowledge and
// agent-run surfaces. Mirrors `canary-broker.ts` exactly — three sinks:
//   1. stdout (JSON lines) — Docker / ECS picks them up for log shipping
//   2. in-memory ring buffer — last BUFFER_CAPACITY events, queried for SSE
//      catch-up replay (routes/assessment.ts GET /events, Last-Event-ID aware)
//   3. live subscribers — SSE consumers receive each event as it happens
//
// The buffer is process-local — if middleware is scaled horizontally, swap
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
  | { type: 'knowledge.comment.created'; id: string; doc_id: string; by: string; body: string; ts: string }
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

const BUFFER_CAPACITY = 500;

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
 *    the gap — but only up to `maxAgeMs` old. Buffer retention is sized by
 *    EVENT COUNT (`BUFFER_CAPACITY`), not age, so on a quiet tenant it can
 *    hold something from hours ago; replaying that to a client reconnecting
 *    after a real gap (laptop sleep, flaky wifi) would be exactly the same
 *    "just now" lie, just reached via a different path. Events older than
 *    `maxAgeMs` are dropped from the reply, and dropping any (whether from
 *    capacity eviction or the age bound) marks the result `gapped` so the
 *    route can tell the client something was missed rather than silently
 *    under-delivering.
 */
export function decideReplay(
  buffer: readonly BufferedAssessmentEvent[],
  afterSeq: number | undefined,
  nowMs: number,
  maxAgeMs: number = REPLAY_MAX_AGE_MS,
): { events: BufferedAssessmentEvent[]; gapped: boolean } {
  if (afterSeq === undefined) return { events: [], gapped: false };

  const missed = buffer.filter((b) => b.seq > afterSeq);
  const floorMs = nowMs - maxAgeMs;
  const events = missed.filter((b) => eventTs(b.event) >= floorMs);

  // Capacity eviction: afterSeq is behind the slot immediately before the
  // oldest held entry, i.e. at least one event between what the client last
  // saw and the current floor was shifted out of the ring buffer entirely.
  const oldest = buffer[0]?.seq;
  const evicted = oldest !== undefined && afterSeq < oldest - 1;
  // Age eviction: some of what's still held between afterSeq and now was
  // excluded for being older than maxAgeMs — a real miss even though the
  // ring buffer never dropped it.
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
  leaving?: boolean;
  leaveTimer?: ReturnType<typeof setTimeout>;
}

type Subscriber = (buffered: BufferedAssessmentEvent) => void;

class AssessmentBroker {
  private readonly buffer: BufferedAssessmentEvent[] = [];
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
  // docId -> tabId -> viewer. Process-local, same caveat as the ring buffer
  // above — a horizontally-scaled middleware needs a shared store instead.
  private readonly presence = new Map<string, Map<string, PresenceEntry>>();

  publish(event: AssessmentEvent): BufferedAssessmentEvent {
    this.seq += 1;
    const buffered: BufferedAssessmentEvent = { seq: this.seq, event };

    // 1. stdout JSON line — picked up by log shippers.
    process.stdout.write(JSON.stringify(buffered) + '\n');

    // 2. ring buffer.
    this.buffer.push(buffered);
    if (this.buffer.length > BUFFER_CAPACITY) this.buffer.shift();

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
   * Raw snapshot of the buffer in insertion order (oldest-first), with no
   * client-facing policy applied. With `afterSeq` given, only events with
   * `seq > afterSeq` are returned. GET /events does NOT call this directly
   * any more — it calls `catchUp`, which applies the no-Last-Event-ID and
   * age-bound rules on top of exactly this filter (see `decideReplay`).
   * Kept as the low-level primitive other callers/tests build on.
   */
  replay(afterSeq?: number): BufferedAssessmentEvent[] {
    if (afterSeq === undefined) return [...this.buffer];
    return this.buffer.filter((b) => b.seq > afterSeq);
  }

  /**
   * The client-facing catch-up decision for GET /events — see `decideReplay`
   * for the policy and its rationale. Wraps the pure function with this
   * broker's own buffer/clock so the route only has to call one thing.
   */
  catchUp(afterSeq: number | undefined, nowMs = Date.now()): { events: BufferedAssessmentEvent[]; gapped: boolean } {
    return decideReplay(this.buffer, afterSeq, nowMs, REPLAY_MAX_AGE_MS);
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

  touch(docId: string, tabId: string, sub: string, name: string, nowMs = Date.now()): void {
    const purged = this.purgeStale(docId, nowMs);
    const doc = this.presence.get(docId) ?? new Map<string, PresenceEntry>();
    const existing = doc.get(tabId);
    const isNewTab = !existing;
    // Cancel a pending grace-period delete for this tab — this `touch` IS
    // the remount's `enter`/heartbeat that proves the tab never really left.
    // Drop the old entry object (with its timer reference) rather than
    // mutating it, so nothing schedules against a stale closure.
    if (existing?.leaveTimer) clearTimeout(existing.leaveTimer);
    doc.set(tabId, {
      sub, name, tabId,
      since: existing?.since ?? new Date(nowMs).toISOString(),
      lastSeenMs: nowMs,
    });
    this.presence.set(docId, doc);
    // Cancelling a pending leave is not itself a roster change (the viewer
    // was listed throughout the grace window) — only a brand-new tab or a
    // purge of OTHER stale entries warrants a publish here.
    if (isNewTab || purged) this.publishPresence(docId, nowMs);
  }

  leave(docId: string, tabId: string, nowMs = Date.now()): void {
    const purged = this.purgeStale(docId, nowMs);
    const doc = this.presence.get(docId);
    const entry = doc?.get(tabId);
    if (!entry || entry.leaving) {
      // No such tab, or a leave already staged (duplicate sendBeacon) — the
      // roster itself doesn't change here either way.
      if (purged) this.publishPresence(docId, nowMs);
      return;
    }
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
