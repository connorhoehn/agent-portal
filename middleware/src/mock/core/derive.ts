// Selectors. See contract.ts for the rules — the relevant one is the first:
// a fixture may not export a number that could have been counted from rows it
// also exports. These helpers are what "could have been counted" means in
// practice, so the honest version is never more work than the typed one.
//
// Bug #1 in that header is not a fixture that got its arithmetic wrong; it is
// a fixture that got the arithmetic RIGHT on the day it was written, and then
// one side changed. "5 bots" over an empty table, "New · 17/17" on a team of
// nine, a banner reading "6 pending" above 5 cards. Nothing here can drift,
// because nothing here is stored.

import { DAY_MS, utcDayStartMs } from './clock.js';

/**
 * A field name or a function. Field names keep the common case short
 * (`countBy(runs, 'status')`); functions cover everything else. Every helper
 * takes both, and infers the same result type either way.
 */
export type Accessor<Row, Value> = ((row: Row) => Value) | (keyof Row & string);

/** The string field names of `Row` whose value fits `Value`. */
export type FieldOfType<Row, Value> = {
  [K in keyof Row]-?: Row[K] extends Value ? (K extends string ? K : never) : never;
}[keyof Row];

function read(row: unknown, accessor: unknown): unknown {
  return typeof accessor === 'function'
    ? (accessor as (r: unknown) => unknown)(row)
    : (row as Record<string, unknown>)[accessor as string];
}

/**
 * Rows per key. A `Map`, not an object: keys come from data, and an object
 * would let a row whose key is `__proto__` or `constructor` corrupt or silently
 * vanish from the result. Insertion order is first-seen order.
 */
export function groupBy<Row, K extends keyof Row & string>(rows: readonly Row[], key: K): Map<Row[K], Row[]>;
export function groupBy<Row, Key>(rows: readonly Row[], key: (row: Row) => Key): Map<Key, Row[]>;
export function groupBy(rows: readonly unknown[], key: unknown): Map<unknown, unknown[]> {
  const out = new Map<unknown, unknown[]>();
  for (const row of rows) {
    const k = read(row, key);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/** How many rows per key. Same `Map` reasoning as `groupBy`. */
export function countBy<Row, K extends keyof Row & string>(rows: readonly Row[], key: K): Map<Row[K], number>;
export function countBy<Row, Key>(rows: readonly Row[], key: (row: Row) => Key): Map<Key, number>;
export function countBy(rows: readonly unknown[], key: unknown): Map<unknown, number> {
  const out = new Map<unknown, number>();
  for (const row of rows) {
    const k = read(row, key);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/**
 * Sum a numeric field. `null`/`undefined`/`NaN` contribute nothing — a missing
 * cost is unknown, and unknown is not zero-with-a-different-name, but a total
 * that silently becomes `NaN` is worse than one that skips the row.
 *
 * `digits` rounds the result, for money: 0.1 + 0.2 renders as 0.30000000000000004
 * on a spend tile otherwise.
 */
export function sumBy<Row>(
  rows: readonly Row[],
  value: ((row: Row) => number | null | undefined) | FieldOfType<Row, number | null | undefined>,
  opts?: { digits?: number },
): number {
  let total = 0;
  for (const row of rows) {
    const v = read(row, value);
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  if (opts?.digits === undefined) return total;
  const factor = 10 ** opts.digits;
  return Math.round(total * factor) / factor;
}

/** What a timestamp may be spelled as in a fixture row. */
export type TimestampValue = string | number | Date | null | undefined;

/** A timestamp field name, or a function producing one. */
export type TimestampAccessor<Row> =
  | ((row: Row) => TimestampValue)
  | FieldOfType<Row, TimestampValue>;

function toMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
}

/**
 * The row with the newest timestamp, or `undefined` for no usable row. Rows
 * with a missing or unparseable timestamp are skipped rather than treated as
 * epoch 0, so one bad row cannot become "last run: 1970". Ties keep the first.
 */
export function latestBy<Row>(rows: readonly Row[], tsField: TimestampAccessor<Row>): Row | undefined {
  let best: Row | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    const ms = toMs(read(row, tsField));
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = row;
    }
  }
  return best;
}

/**
 * The rows that fall on today — **the one place "today" is defined.**
 *
 * Today is a UTC day, because every "today" number this mock stands in for is
 * produced by Aurora's `date_trunc('day', NOW())` in a UTC session. Bucketing
 * in local time agrees with that only on a UTC host: at UTC-4 a row stamped
 * 00:30Z today is "yesterday" to a local bucket, and the count the mock reports
 * differs from the count the real query would have returned — on a laptop, for
 * a few hours a day, silently. providers/bots.ts shipped that bug once already.
 *
 * The window is half-open — `[UTC midnight, next UTC midnight)` — matching
 * `>= date_trunc('day', NOW()) AND < date_trunc('day', NOW()) + interval '1 day'`.
 * The upper bound matters: a row stamped in the future (a scheduled next run, a
 * clock-skewed import) is not something that happened today, and an unbounded
 * `>=` would quietly inflate every "today" count with it.
 *
 * `now` defaults to the current instant, which under `freezeClock` is the
 * frozen one; pass it explicitly only when comparing two moments in one call.
 */
export function todayInUtc<Row>(
  rows: readonly Row[],
  tsField: TimestampAccessor<Row>,
  opts?: { now?: Date },
): Row[] {
  const dayStart = utcDayStartMs(opts?.now ?? undefined);
  return rows.filter((row) => {
    const ms = toMs(read(row, tsField));
    return !Number.isNaN(ms) && ms >= dayStart && ms < dayStart + DAY_MS;
  });
}

/**
 * `Map` → plain object, for the moment an aggregate has to become JSON. Keeps
 * the counting itself on the safe side of the wire boundary.
 */
export function toRecord<Key extends string | number, Value>(
  map: Map<Key, Value>,
): Record<string, Value> {
  const out: Record<string, Value> = Object.create(null) as Record<string, Value>;
  for (const [k, v] of map) out[String(k)] = v;
  return out;
}
