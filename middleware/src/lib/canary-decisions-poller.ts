// Tails observability.canary_decisions on a 5s interval and republishes new
// rows as `decision` events on canaryBroker. Without this bridge the controller
// state machine writes decisions to Aurora but the portal never sees them — the
// SFN has no path to push events into the in-memory broker.
//
// Cold start: fetch the last 20 rows so a freshly-booted middleware backfills
// its broker buffer for SSE replay. After that we track the last `id` seen and
// only pull rows above it.
//
// Disabled when:
//   - CANARY_DECISIONS_POLLER_DISABLED=1
//   - MOCK_AURORA=true (no real DB to read)
//   - aurora.clusterArn unset

import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import { canaryBroker } from './canary-broker.js';
import type { CanaryEvent } from './canary-types.js';

const POLL_INTERVAL_MS = 5_000;
const COLD_START_LIMIT = 20;
const PAGE_SIZE = 50;

type DecisionAction = Extract<CanaryEvent, { type: 'decision' }>['action'];
const KNOWN_ACTIONS: ReadonlySet<DecisionAction> = new Set([
  'PROMOTE',
  'ROLLBACK',
  'HOLD',
  'SKIPPED_OVERRIDE',
  'SKIPPED_COOLDOWN',
  'SKIPPED_NO_SAMPLES',
]);

let _client: RDSDataClient | null = null;
function client(): RDSDataClient {
  if (!_client) _client = new RDSDataClient({ region: config.region });
  return _client;
}

interface DecisionRow {
  id: number;
  decided_at: string;
  action: string;
  weight_b_before: number;
  weight_b_after: number;
  composite_a: number | null;
  composite_b: number | null;
  reason: string | null;
}

async function exec(sql: string, params: SqlParameter[] = []): Promise<DecisionRow[]> {
  const resp = await client().send(
    new ExecuteStatementCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
      sql,
      parameters: params,
      includeResultMetadata: true,
    }),
  );
  const cols = (resp.columnMetadata ?? []).map((c) => c.name ?? '');
  return (resp.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};
    record.forEach((cell, i) => {
      const k = cols[i] ?? `col${i}`;
      if (cell.isNull) row[k] = null;
      else if (cell.stringValue !== undefined) row[k] = cell.stringValue;
      else if (cell.longValue !== undefined) row[k] = cell.longValue;
      else if (cell.doubleValue !== undefined) row[k] = cell.doubleValue;
      else if (cell.booleanValue !== undefined) row[k] = cell.booleanValue;
      else row[k] = null;
    });
    return row as unknown as DecisionRow;
  });
}

function toAction(raw: string): DecisionAction | null {
  return KNOWN_ACTIONS.has(raw as DecisionAction) ? (raw as DecisionAction) : null;
}

function toIso(raw: string): string {
  // RDS Data API stringValue for timestamptz comes back like
  // "2026-05-19 18:42:01.123456+00". Normalize to ISO 8601.
  if (!raw) return new Date().toISOString();
  const trimmed = raw.replace(' ', 'T');
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function rowToEvent(row: DecisionRow): CanaryEvent | null {
  const action = toAction(row.action);
  if (!action) return null;
  const ev: CanaryEvent = {
    type: 'decision',
    action,
    weight_b_before: Number(row.weight_b_before),
    weight_b_after: Number(row.weight_b_after),
    reason: row.reason ?? '',
    ts: toIso(row.decided_at),
  };
  if (row.composite_a !== null) ev.composite_a = Number(row.composite_a);
  if (row.composite_b !== null) ev.composite_b = Number(row.composite_b);
  return ev;
}

let _lastId = 0;
let _intervalHandle: NodeJS.Timeout | null = null;

async function pollOnce(): Promise<{ published: number }> {
  if (_lastId === 0) {
    // Cold start — backfill the most recent N rows so SSE replay has context.
    const rows = await exec(
      `SELECT id, decided_at, action, weight_b_before, weight_b_after,
              composite_a, composite_b, reason
         FROM observability.canary_decisions
         ORDER BY id DESC
         LIMIT ${COLD_START_LIMIT}`,
    );
    // Publish in chronological order so the broker buffer ends up oldest-first.
    rows.reverse();
    let published = 0;
    for (const row of rows) {
      const ev = rowToEvent(row);
      if (ev) {
        canaryBroker.publish(ev);
        published += 1;
      }
      if (row.id > _lastId) _lastId = Number(row.id);
    }
    return { published };
  }

  const rows = await exec(
    `SELECT id, decided_at, action, weight_b_before, weight_b_after,
            composite_a, composite_b, reason
       FROM observability.canary_decisions
       WHERE id > :last_id
       ORDER BY id ASC
       LIMIT ${PAGE_SIZE}`,
    [{ name: 'last_id', value: { longValue: _lastId } }],
  );
  let published = 0;
  for (const row of rows) {
    const ev = rowToEvent(row);
    if (ev) {
      canaryBroker.publish(ev);
      published += 1;
    }
    if (row.id > _lastId) _lastId = Number(row.id);
  }
  return { published };
}

export function startCanaryDecisionsPoller(): void {
  if (_intervalHandle) return;
  if (process.env['CANARY_DECISIONS_POLLER_DISABLED'] === '1') {
    console.log('[canary-decisions] CANARY_DECISIONS_POLLER_DISABLED=1 — skipping start');
    return;
  }
  if (config.mock.aurora) {
    console.log('[canary-decisions] MOCK_AURORA=true — skipping start');
    return;
  }
  if (!config.aurora.clusterArn || !config.aurora.secretArn) {
    console.log('[canary-decisions] aurora ARNs unset — skipping start');
    return;
  }

  console.log(
    `[canary-decisions] starting poller, interval ${POLL_INTERVAL_MS / 1000}s`,
  );

  // Kick off an immediate poll so a freshly-booted middleware backfills its
  // buffer without waiting one tick.
  void pollOnce()
    .then((r) =>
      console.log(`[canary-decisions] cold-start published ${r.published} decision(s)`),
    )
    .catch((err) =>
      console.warn('[canary-decisions] cold-start failed:', (err as Error).message),
    );

  _intervalHandle = setInterval(() => {
    void pollOnce()
      .then((r) => {
        if (r.published > 0) {
          console.log(`[canary-decisions] published ${r.published} new decision(s)`);
        }
      })
      .catch((err) =>
        console.warn('[canary-decisions] poll failed:', (err as Error).message),
      );
  }, POLL_INTERVAL_MS);
}

export function stopCanaryDecisionsPoller(): void {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}
