// Durable mirror of the devbox fleet registry (schema/devbox_fleet_schema.sql).
//
// The registry itself is two in-memory Maps in lib/devbox-fleet.ts and stays
// that way — it is read on every request and its mutators are synchronous. This
// module is the seam that lets it survive a restart: it hydrates the maps at
// boot and writes changes back, fire-and-forget.
//
// The bug it closes: a middleware restart dropped every box while the AgentCore
// sessions carried on. `devbox-reaper` sweeps only what `listBoxes()` returns,
// so a forgotten session was outside both the idle timeout and the lifetime
// ceiling — permanently, with no AgentCore API able to enumerate live runtime
// sessions to reconcile against. Under `tsx watch` that happened on every file
// save.
//
// Degradation is the design constraint. Aurora mocked, unconfigured, or simply
// down must leave the lab working exactly as it did before this file existed —
// so every call here is best-effort and nothing throws back into the registry.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import {
  setFleetStore, hydrateBoxes, _resetFleet, type FleetBox, type FleetStore,
} from '../lib/devbox-fleet.js';
import { rowToBox } from '../lib/devbox-fleet-rows.js';
import { devboxBoxes } from '../mock/devbox-fleet.js';

/**
 * How long a box's moved activity clock may sit unwritten.
 *
 * `touch` fires on EVERY fleet event — a short real run emits tens, and
 * `thinking_tokens` alone arrives several times a second — so writing through
 * per event would turn a chatty run into a write storm against the Data API.
 * Coalescing bounds staleness instead: after a crash a box's `last_activity_at`
 * can be at most this far behind, which is nothing against a 20-minute idle
 * timeout, and erring stale means erring toward reaping sooner rather than
 * never.
 */
const TOUCH_FLUSH_MS = Number(process.env['DEVBOX_FLEET_FLUSH_MS'] ?? 15_000);

function usable(): boolean {
  // A raw exec() reaches the RDS Data API whatever config.mock.aurora says, so
  // the mock flag has to be checked here rather than relied on downstream.
  return !config.mock.aurora && Boolean(config.aurora.clusterArn && config.aurora.secretArn);
}

const str = (name: string, value: string | null | undefined): SqlParameter =>
  value == null || value === ''
    ? { name, value: { isNull: true } }
    : { name, value: { stringValue: value } };

const num = (name: string, value: number | null | undefined): SqlParameter =>
  value == null || !Number.isFinite(value)
    ? { name, value: { isNull: true } }
    : { name, value: { doubleValue: value } };

/**
 * Every persisted box worth restoring. Empty (never throwing) when Aurora is
 * not available.
 *
 * Rows for STOPPED boxes are dropped rather than restored, and deleted on the
 * way past. A stopped box's runtime session is already gone, so bringing it
 * back would do nothing for the reaper — the thing this table exists for —
 * while making the Computers page accumulate every dead box the lab has ever
 * had, across every restart. That would trade one bad experience (computers
 * vanishing) for another (a fleet full of corpses).
 *
 * Boxes that are merely OLD are restored, deliberately, even past the lifetime
 * ceiling: an expired box whose session is still up is exactly the orphan this
 * work is about, and the reaper can only stop what it can see.
 */
export async function loadFleet(): Promise<FleetBox[]> {
  // OFFLINE. `usable()` is false whenever Aurora is mocked, so this used to
  // return [] and the whole microVM fleet was empty BY CONSTRUCTION in the
  // dev:mock demo — `GET /api/devbox/boxes` answered `{"boxes":[]}` and
  // Computer Lab, a nav item of its own, rendered "No computers to lab.
  // Provision at least one computer" in every demo. That empty state is
  // phrased as an instruction, so the surface did not read as unseeded, it
  // read as waiting for you.
  //
  // Seeded rows come from the registered `devboxBoxes` fixture, so
  // `POST /api/__mock/scenario {"scenario":"empty","fixture":"devbox-boxes"}`
  // still asks for a genuinely empty fleet by name — the one case where that
  // instruction is the honest screen.
  if (config.mock.aurora) return devboxBoxes.rows().map((b) => ({ ...b }));
  if (!usable()) return [];
  try {
    const rows = await exec(
      `SELECT id, session_id, label, owner_id, project_id, status,
              created_at, last_activity_at, spend_usd, tokens_used, active_model
         FROM devbox_boxes
        WHERE status <> 'stopped'`,
    );
    // Best-effort tidy of the rows we just declined to restore. Fire-and-forget:
    // failing to prune is untidy, never incorrect.
    void exec(`DELETE FROM devbox_boxes WHERE status = 'stopped'`).catch(() => { /* untidy, not wrong */ });
    return rows.map(rowToBox).filter((b) => b.id && b.sessionId);
  } catch (err) {
    // A cluster that never had devbox_fleet_schema.sql applied lands here. That
    // is the pre-existing behaviour, not a new failure, so it must not be loud
    // enough to look like one — but it must be visible, because the whole
    // reaper story silently reverts to leaking.
    console.warn('[devbox-fleet] could not load persisted boxes:', (err as Error).message);
    return [];
  }
}

async function upsertRow(box: FleetBox): Promise<void> {
  await exec(
    `INSERT INTO devbox_boxes
       (id, session_id, label, owner_id, project_id, status,
        created_at, last_activity_at, spend_usd, tokens_used, active_model)
     VALUES
       (:id, :session_id, :label, :owner_id, :project_id, :status,
        :created_at::timestamptz, :last_activity_at::timestamptz,
        :spend_usd, :tokens_used, :active_model)
     ON CONFLICT (id) DO UPDATE SET
       label            = EXCLUDED.label,
       owner_id         = EXCLUDED.owner_id,
       project_id       = EXCLUDED.project_id,
       status           = EXCLUDED.status,
       last_activity_at = EXCLUDED.last_activity_at,
       spend_usd        = EXCLUDED.spend_usd,
       tokens_used      = EXCLUDED.tokens_used,
       active_model     = EXCLUDED.active_model`,
    // created_at is deliberately absent from the UPDATE list: it is what the
    // lifetime ceiling measures from, and letting a later write move it forward
    // would hand a long-lived box a fresh ceiling every time it was touched.
    [
      str('id', box.id),
      str('session_id', box.sessionId),
      str('label', box.label),
      str('owner_id', box.ownerId ?? null),
      str('project_id', box.projectId ?? null),
      str('status', box.status),
      str('created_at', box.createdAt),
      str('last_activity_at', box.lastActivityAt),
      num('spend_usd', box.spendUsd ?? null),
      num('tokens_used', box.tokensUsed ?? null),
      str('active_model', box.activeModel ?? null),
    ],
  );
}

let flushTimer: NodeJS.Timeout | null = null;
const pending = new Map<string, FleetBox>();

/**
 * One write chain per box, so writes land in the order they were made.
 *
 * Every write here is fire-and-forget — the registry's mutators are
 * synchronous and must not wait on Aurora — which means two writes for the same
 * box can otherwise complete out of order. `DELETE /api/devbox/boxes/:id` does
 * exactly that: it calls `markStopped` (upsert) and then `removeBox` (delete),
 * back to back. Unserialized, the delete won the race, the upsert landed after
 * it, and the row came back from the dead as `stopped` — a computer the user
 * had removed, restored on the next boot. Observed before this chain existed.
 *
 * Chains are keyed by box id and dropped once drained, so this holds no state
 * for an idle fleet.
 */
const chains = new Map<string, Promise<void>>();

function enqueue(id: string, op: () => Promise<void>): void {
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev
    .then(op)
    .catch((err) => {
      console.warn(`[devbox-fleet] write failed for ${id}:`, (err as Error).message);
    });
  chains.set(id, next);
  void next.finally(() => {
    // Only clear if nothing else queued behind us in the meantime.
    if (chains.get(id) === next) chains.delete(id);
  });
}

function flushPending(): void {
  if (pending.size === 0) return;
  const batch = [...pending.values()];
  pending.clear();
  for (const box of batch) {
    // Through the chain as well: a flush must not overtake a delete queued
    // moments earlier and resurrect the row it removed.
    enqueue(box.id, () => upsertRow(box));
  }
}

/**
 * Build the store. Returns null when Aurora is unavailable, which leaves the
 * registry exactly as it was before persistence existed.
 */
export function createFleetStore(): FleetStore | null {
  if (!usable()) return null;

  const write = (box: FleetBox): void => {
    // Drop any queued touch for this box FIRST. A coalesced touch holds a
    // snapshot taken when it was queued, and a structural change always carries
    // newer state — so leaving one queued lets it replay stale fields over this
    // write when the flush lands.
    //
    // That is not theoretical; it is how the reaper's own stop got undone.
    // sweepOnce appends a `devbox_reaped` event (queuing a touch with the box
    // still `idle`), stops the session, then calls markStopped → upsert
    // `stopped`. Fifteen seconds later the flush wrote `idle` back over it, so
    // the row never reached the state the boot-time prune keys off, the box was
    // restored as live on the next restart, and the reaper reaped the same dead
    // ghost again — forever. Observed end-to-end before this line existed.
    pending.delete(box.id);
    // Snapshot: the registry hands out its live object, which will keep
    // mutating while this write is in flight.
    const snapshot = { ...box };
    enqueue(box.id, () => upsertRow(snapshot));
  };

  if (!flushTimer) {
    flushTimer = setInterval(() => { flushPending(); }, TOUCH_FLUSH_MS);
    // Never hold the process open for a flush.
    flushTimer.unref?.();
  }

  return {
    // Structural changes are rare and worth writing immediately — a box that
    // exists, was renamed, or has stopped should be true in the table now, not
    // up to a flush interval from now.
    upsert: write,
    remove(id: string): void {
      pending.delete(id);
      enqueue(id, async () => {
        await exec('DELETE FROM devbox_boxes WHERE id = :id', [str('id', id)]);
      });
    },
    // The hot path: coalesced, because this fires on every event.
    touch(box: FleetBox): void {
      pending.set(box.id, { ...box });
    },
  };
}

/**
 * Hydrate the registry from Aurora and start mirroring writes back.
 *
 * Order matters: load BEFORE the reaper starts, or its first sweep runs against
 * an empty fleet and the boxes it should have been watching are invisible for
 * one interval. Returns how many boxes were restored.
 */
export async function initFleetPersistence(): Promise<number> {
  const restored = hydrateBoxes(await loadFleet());
  const s = createFleetStore();
  setFleetStore(s);
  if (s) {
    console.warn(
      `[devbox-fleet] persistence active — ${restored} box(es) restored, `
      + `activity flushed every ${Math.round(TOUCH_FLUSH_MS / 1000)}s`,
    );
  }
  return restored;
}

/** Test hook — stop the flush timer and drop anything queued. */
export function _stopFleetPersistence(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  pending.clear();
  setFleetStore(null);
}

/**
 * Put the offline fleet back to its seed — the `clearDevPairings()` precedent
 * in routes/mock-control.ts, for the same reason it exists.
 *
 * The boxes live in an in-memory Map in lib/devbox-fleet.ts, NOT in the
 * fixture's rows, so `registry.resetAll()` cannot reach them: without this a
 * box renamed or stopped during a demo would survive the reset and
 * `POST /api/__mock/reset` would quietly mean "reset most of it". Re-reads the
 * fixture rather than caching a copy, so it follows a pinned `empty` scenario
 * instead of dragging the default fleet back over it.
 *
 * No-op when Aurora is real: there the rows are Aurora's and resetting them is
 * not this plane's business.
 */
export function rehydrateMockFleet(): number {
  if (!config.mock.aurora) return 0;
  _resetFleet();
  // `rows()` THROWS when the fixture is pinned to `error` — that is what an
  // error scenario is. This runs from the scenario plane's own POST handler,
  // so without the catch, pinning `devbox-boxes` to `error` made the pin
  // request itself answer 500 (measured: the throw surfaced from here, not
  // from any devbox route) and the plane could not serve a world it
  // advertises. The fleet is left EMPTY on a failed read, which is correct:
  // the in-memory Map is a mirror of rows nobody could read, and the devbox
  // routes surface the failure on their own reads. Swallowing it here hides
  // nothing — it only stops one fixture's error scenario from taking the
  // control plane down with it.
  try {
    return hydrateBoxes(devboxBoxes.rows().map((b) => ({ ...b })));
  } catch {
    return 0;
  }
}
