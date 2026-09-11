// Pure reshaping + formatting for the Tool Calls surface.
//
// Kept out of the page component for two reasons: the reshaping is the part
// that is easy to get wrong (three endpoints, three different groupings, one
// table) and it is the part worth pinning in a test. The page itself then
// only decides what to draw.
//
// The wire shapes these functions take are the ones the server actually
// sends — read off a running `dev:mock`, not off the route source:
//
//   GET /api/observability/tools/latency?windowHours=&agentId=
//     { byTool: [{ toolName, count, p50DurationMs, p99DurationMs,
//                  errorRate, totalCostUsd, withCost }] }
//   GET /api/observability/tools/timeseries?windowHours=&bucketMin=
//     { points: [{ bucketStart, toolName, count, p99DurationMs, errorRate,
//                  totalCostUsd }], bucketMin, windowHours }
//   GET /api/observability/tools/errors?limit=
//     { errors: [{ toolCallId, invocationId, agentId, toolName,
//                  errorMessage, ts }] }
//
// …and each of them may instead carry `degraded: true` + `error`, which is
// read by lib/degraded.ts, not here.

import { parsePgTimestamp } from '../../lib/pgTimestamp.ts';

export interface ToolLatencyRow {
  toolName: string;
  count: number;
  p50DurationMs: number | null;
  p99DurationMs: number | null;
  /** 0..1 */
  errorRate: number;
  totalCostUsd: number;
  /** How many of `count` carried a cost estimate at all. */
  withCost: number;
}

export interface ToolTimeseriesPoint {
  bucketStart: string;
  toolName: string;
  count: number;
  p99DurationMs: number | null;
  errorRate: number;
  totalCostUsd: number;
}

export interface ToolErrorRow {
  toolCallId: string;
  invocationId: string;
  agentId: string;
  toolName: string;
  errorMessage: string | null;
  ts: string;
}

// ── Windows ─────────────────────────────────────────────────────────────────

export interface ToolWindow {
  label: string;
  hours: number;
  /** Bucket width for /timeseries — kept small enough to draw a shape,
      large enough that a 14-day window is not 4,000 points. */
  bucket: number;
}

export const TOOL_WINDOWS: ToolWindow[] = [
  { label: '1h', hours: 1, bucket: 5 },
  { label: '24h', hours: 24, bucket: 60 },
  { label: '7d', hours: 168, bucket: 360 },
  { label: '14d', hours: 336, bucket: 360 },
];

/** The window whose `label` matches, else the 24h default. */
export function windowFor(label: string): ToolWindow {
  return TOOL_WINDOWS.find((w) => w.label === label) ?? TOOL_WINDOWS[1]!;
}

// ── Reshaping ───────────────────────────────────────────────────────────────

/**
 * One volume series per tool, in bucket order, for the per-row sparkline.
 *
 * The timeseries endpoint emits a row per (bucket, tool) and omits buckets in
 * which a tool did not run — so a naive `points.filter(...)` draws a tool that
 * ran twice as a flat two-point line, indistinguishable from one that ran in
 * every bucket. Every series is therefore laid out over the UNION of buckets
 * seen in the payload, with a real zero where the tool was idle.
 */
export function volumeSeriesByTool(points: ToolTimeseriesPoint[]): Map<string, number[]> {
  const buckets = Array.from(new Set(points.map((p) => p.bucketStart))).sort();
  const index = new Map(buckets.map((b, i) => [b, i] as const));
  const out = new Map<string, number[]>();
  for (const p of points) {
    let series = out.get(p.toolName);
    if (!series) {
      series = new Array<number>(buckets.length).fill(0);
      out.set(p.toolName, series);
    }
    const i = index.get(p.bucketStart);
    if (i !== undefined) series[i] = (series[i] ?? 0) + p.count;
  }
  return out;
}

/**
 * Case-insensitive substring match on the tool name — the filter row's search.
 * An empty query matches everything (it is not a filter yet).
 */
export function matchesQuery(toolName: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length === 0 || toolName.toLowerCase().includes(q);
}

/**
 * The error tail, narrowed to what the rest of the page is showing.
 *
 * `GET /tools/errors` takes only `limit` — no `agentId`, no `windowHours` —
 * so the agent selector and the tool search have to be applied here or the
 * error list would silently ignore both and contradict the table above it.
 * The page says so in the panel's subtitle rather than pretending the server
 * did the filtering.
 */
export function filterErrors(
  errors: ToolErrorRow[],
  opts: { agentId: string; query: string },
): ToolErrorRow[] {
  return errors.filter(
    (e) =>
      (opts.agentId === 'all' || e.agentId === opts.agentId) &&
      matchesQuery(e.toolName, opts.query),
  );
}

/** Totals for the one-line page description. */
export function summarize(rows: ToolLatencyRow[]): {
  tools: number;
  calls: number;
  failing: number;
  costUsd: number;
} {
  let calls = 0;
  let failing = 0;
  let costUsd = 0;
  for (const r of rows) {
    calls += r.count;
    if (r.errorRate > 0) failing += 1;
    costUsd += Number.isFinite(r.totalCostUsd) ? r.totalCostUsd : 0;
  }
  return { tools: rows.length, calls, failing, costUsd };
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return Number(n).toLocaleString();
}

export function fmtMs(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${(n / 60_000).toFixed(1)}m`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * Cost, with the distinction the `withCost` column exists to carry.
 *
 * Half these tools are graph/A2A calls that spend no model tokens, so their
 * `totalCostUsd` is a true `$0.00`. The other zero — a priced tool whose rows
 * carried no estimate — is not a reading, and rendering both as `$0.00` is the
 * same lie the degraded marker exists to stop. No priced rows at all → `—`.
 */
export function fmtToolCost(totalCostUsd: number, withCost: number): string {
  if (withCost === 0) return '—';
  if (!Number.isFinite(totalCostUsd)) return '—';
  const d = totalCostUsd >= 1 ? 2 : totalCostUsd >= 0.01 ? 3 : 4;
  return `$${totalCostUsd.toFixed(d)}`;
}

/**
 * `2026-09-08 08:19:23+00` (Postgres `timestamptz::text`) → local time.
 *
 * TWO NORMALISATIONS, both load-bearing. Postgres separates the date and time
 * with a space, and — the one that is easy to miss — writes the UTC offset as
 * `+00`, which is not valid ISO 8601: `new Date('2026-09-08T08:19:23+00')` is
 * `Invalid Date` in V8, so the naive version silently rendered the raw
 * database string in the WHEN column. Pad a bare-hour offset to `+00:00`.
 */
export function fmtTs(ts: string): string {
  if (!ts) return '—';
  const d = parsePgTimestamp(ts);
  if (d === null) return ts;
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ── Tones ───────────────────────────────────────────────────────────────────

export type Tone = 'success' | 'warning' | 'danger' | 'neutral';

/** A tool that never failed is not "good news", it is the baseline — neutral. */
export function errorTone(rate: number): Tone {
  if (!Number.isFinite(rate) || rate <= 0) return 'neutral';
  if (rate >= 0.05) return 'danger';
  return 'warning';
}

/** P99 against what a tool call ought to cost in wall-clock. */
export function latencyTone(ms: number | null): Tone {
  if (ms == null || !Number.isFinite(ms)) return 'neutral';
  if (ms >= 5000) return 'danger';
  if (ms >= 1500) return 'warning';
  return 'success';
}
