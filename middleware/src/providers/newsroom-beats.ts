// newsroom-beats provider — beat coverage heatmap data from Aurora.
// Queries the `documents` table (section + published_at + doc_type).
// All queries are wrapped defensively; missing schema returns empty defaults.

import { exec } from './aurora.js';

// ─── Public types ────────────────────────────────────────────────────────────

/** matrix[beatIdx][dayIdx] = article count */
export interface BeatHeatmapResponse {
  beats: string[];
  /** ISO date strings YYYY-MM-DD, ascending */
  days: string[];
  matrix: number[][];
}

export interface TopBeatsResponse {
  beats: Array<{ name: string; count: number }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toStr(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function toNumber(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Generate a list of YYYY-MM-DD strings for the last `days` days (today included). */
function buildDayLabels(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ─── getBeatCoverage ─────────────────────────────────────────────────────────

export async function getBeatCoverage(opts: { days: number }): Promise<BeatHeatmapResponse> {
  const empty: BeatHeatmapResponse = { beats: [], days: buildDayLabels(opts.days), matrix: [] };

  try {
    const rows = await exec(
      `SELECT section,
              DATE(published_at)::text AS day,
              COUNT(*)::int            AS cnt
         FROM documents
        WHERE doc_type    = 'article'
          AND published_at > now() - make_interval(days => :d::int)
          AND section IS NOT NULL
        GROUP BY section, DATE(published_at)`,
      [{ name: 'd', value: { longValue: opts.days } }],
    );

    if (rows.length === 0) return empty;

    const dayLabels = buildDayLabels(opts.days);
    const dayIndex = new Map(dayLabels.map((d, i) => [d, i]));

    // Collect beat names in stable insertion order.
    const beatSet = new Set<string>();
    for (const r of rows) {
      const section = toStr(r['section']);
      if (section) beatSet.add(section);
    }
    const beats = Array.from(beatSet).sort();
    const beatIndex = new Map(beats.map((b, i) => [b, i]));

    // Zero-initialise matrix.
    const matrix: number[][] = beats.map(() => dayLabels.map(() => 0));

    for (const r of rows) {
      const b = toStr(r['section']);
      const d = toStr(r['day']);
      const cnt = toNumber(r['cnt']);
      const bi = beatIndex.get(b);
      const di = dayIndex.get(d);
      if (bi !== undefined && di !== undefined) {
        matrix[bi]![di] = cnt;
      }
    }

    return { beats, days: dayLabels, matrix };
  } catch {
    // Schema may not exist yet — return empty gracefully.
    return empty;
  }
}

// ─── getTopBeats ─────────────────────────────────────────────────────────────

export async function getTopBeats(limit: number): Promise<TopBeatsResponse> {
  const empty: TopBeatsResponse = { beats: [] };

  try {
    const rows = await exec(
      `SELECT section,
              COUNT(*)::int AS cnt
         FROM documents
        WHERE doc_type    = 'article'
          AND published_at > now() - make_interval(days => 7)
          AND section IS NOT NULL
        GROUP BY section
        ORDER BY cnt DESC
        LIMIT :lim::int`,
      [{ name: 'lim', value: { longValue: limit } }],
    );

    const beats = rows
      .map((r) => ({ name: toStr(r['section']), count: toNumber(r['cnt']) }))
      .filter((b) => b.name !== '');

    return { beats };
  } catch {
    return empty;
  }
}
