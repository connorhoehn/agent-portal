// Name → target resolution for the voice navigator's `send_chat_message`
// (docs/voice-navigator-spec.md §4, P6). Pure matching: the route supplies the
// rows it is allowed to show, this ranks them.
//
// Case-insensitive. Tiers, best first: exact (name or slug), prefix, token
// (every query word starts some word of the name). The best tier decides: one
// row in it is the match, several is ambiguous (candidates, no match).

export interface ResolveRow { id: string; name: string; slug?: string }
export interface ResolveOutcome<Row extends ResolveRow> { match: Row | null; candidates: Array<{ id: string; name: string }> }

export const RESOLVE_CANDIDATES_MAX = 5;
const words = (text: string): string[] => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

function tier(row: ResolveRow, query: string, queryWords: string[]): number {
  const name = row.name.trim().toLowerCase();
  const slug = row.slug?.toLowerCase();
  if (name === query || slug === query || words(row.name).join(' ') === queryWords.join(' ')) return 0;
  if (name.startsWith(query) || (slug !== undefined && slug.startsWith(query))) return 1;
  const nameWords = words(row.name);
  if (queryWords.length && queryWords.every((q) => nameWords.some((w) => w.startsWith(q)))) return 2;
  return -1;
}

export function resolveByName<Row extends ResolveRow>(rows: readonly Row[], rawName: string): ResolveOutcome<Row> {
  const query = rawName.trim().replace(/^[#@]/, '').toLowerCase();
  const queryWords = words(query);
  if (!queryWords.length) return { match: null, candidates: [] };
  const ranked = rows.map((row) => ({ row, tier: tier(row, query, queryWords) })).filter((r) => r.tier >= 0)
    .sort((a, b) => a.tier - b.tier || a.row.name.localeCompare(b.row.name));
  if (!ranked.length) return { match: null, candidates: [] };
  const best = ranked.filter((r) => r.tier === ranked[0]!.tier);
  const candidates = ranked.slice(0, RESOLVE_CANDIDATES_MAX).map(({ row }) => ({ id: row.id, name: row.name }));
  return { match: best.length === 1 ? best[0]!.row : null, candidates };
}
