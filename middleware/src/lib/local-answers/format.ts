// Formatting shared by the local intents. `usd` spells money exactly as the
// portal's `usd` (portal/src/lib/format.ts) and the server's `money()` do, so
// an answer's "$4.28 of $85.00" is byte-identical to the Initiatives table's.

export function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A share as a whole percent; a non-zero share under 1% reads "<1%". */
export function pct(fraction: number): string {
  if (fraction > 0 && fraction < 0.005) return '<1%';
  return `${Math.round(fraction * 100)}%`;
}

/** Cents-exact sum of money values, so a total never drifts from its rows. */
export function sumUsd(values: number[]): number {
  return Math.round(values.reduce((n, v) => n + Math.round(v * 10_000), 0) / 100) / 100;
}

/** "October 2026" — the calendar month the spend window starts in (UTC, like date_trunc on the cluster). */
export function monthLabel(at: Date): string {
  return at.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "October" alone, for "its October allocation". */
export function monthName(at: Date): string {
  return at.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "A, B and C". */
export function listing(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
