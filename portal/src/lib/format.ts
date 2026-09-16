// Canonical money + token-count formatting. Pure, no React.
//
// `usd` matches the server's own `money()` (middleware/src/lib/bot-runner.ts)
// — thousands separators always, so a 409's number and the page's number are
// spelled the same way, including above $1,000 where several call sites
// dropped separators before this existed (see the EstimateDrawer/QueuePage
// bugs noted where this is adopted).

export function usd(n: number | null | undefined, opts?: { precision?: 2 | 4 }): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const precision = opts?.precision ?? 2;
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })}`;
}

/**
 * `formatTokenCount(1234)` → "1,234" (full count, thousands-separated).
 * `formatTokenCount(1234, { compact: true })` → "1.2k" — for tight spaces
 * (stat tiles, flow-graph node labels) where the exact count isn't the point.
 */
export function formatTokenCount(n: number | null | undefined, opts?: { compact?: boolean }): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (opts?.compact) {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }
  return n.toLocaleString('en-US');
}

/**
 * Honest truncation copy — the scale audit's whole point: a page that shows
 * fewer rows/nodes than exist must say so, never render a partial view that
 * looks complete.
 *
 * `showingLabel(50, 560, 'people')` → "Showing the first 50 of 560 people"
 * `showingLabel(50, 50, 'people')`  → "50 people" (nothing was dropped)
 * `showingLabel(50, null, 'people')` → "Showing the first 50 people" — no
 * known total (e.g. the server didn't report one): say what we truncated to,
 * never invent a total.
 */
export function showingLabel(shown: number, total: number | null | undefined, noun: string): string {
  if (total == null) {
    return shown <= 0 ? `No ${noun}` : `Showing the first ${shown.toLocaleString('en-US')} ${noun}`;
  }
  if (shown >= total) {
    return `${total.toLocaleString('en-US')} ${noun}`;
  }
  return `Showing the first ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${noun}`;
}
