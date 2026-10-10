// The optional time range after `/summarize`: "24h", "last 2 days", "30 min",
// "today". Pure, so the route and its tests agree on the grammar.

export const MAX_RANGE_MS = 30 * 24 * 3_600_000;

export type SummarizeRange = { ok: true; sinceMs: number | null } | { ok: false; error: string };

const UNIT_MS: Record<string, number> = {
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 7 * 86_400_000, week: 7 * 86_400_000, weeks: 7 * 86_400_000,
};

/** `argumentText` is what follows the trigger. Empty means "the recent thread". */
export function parseSummarizeRange(argumentText: string, now: Date): SummarizeRange {
  const text = argumentText.trim().toLowerCase().replace(/^(?:over |in |for )?(?:the )?(?:last|past)\s+/, '');
  if (!text) return { ok: true, sinceMs: null };
  if (text === 'today') {
    const start = new Date(now); start.setUTCHours(0, 0, 0, 0);
    return { ok: true, sinceMs: start.getTime() };
  }
  const m = /^(\d{1,4})\s*([a-z]+)$/.exec(text);
  const unit = m ? UNIT_MS[m[2]!] : undefined;
  if (!m || unit === undefined) return { ok: false, error: 'Give a range like "24h", "last 2 days", "30 min" or "today".' };
  const span = Number(m[1]) * unit;
  if (span <= 0 || span > MAX_RANGE_MS) return { ok: false, error: 'The range must be between a minute and 30 days.' };
  return { ok: true, sinceMs: now.getTime() - span };
}
