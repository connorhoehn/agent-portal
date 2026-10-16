// The command palette's record section (ui-components 2.457.0 `searchRecords`):
// what ⌘K finds besides pages. Each tenant has one search endpoint: orgiq keeps
// GET /api/search, the other four GET /api/<tenant>/search
// (docs/user-search-goal.md S2/S3). Rows come back grouped by type, in the
// order the server ranked them, each with a chip label and a same-origin href.
import type { PaletteRecord, PaletteRecordGroup, SearchPaletteRecords } from '@connorhoehnslalom/ui-components';

export type PaletteTenant = 'orgiq' | 'assessment' | 'social' | 'pipelines' | 'access';

interface Row { type: string; id: string; title: string; subtitle?: string; href?: string; kind?: string }

/** orgiq's /api/search rows carry no chip label. Teams link to their members until the library palette has a team record page. */
const ORGIQ_KIND: Record<string, string> = {
  person: 'Person', team: 'Team', initiative: 'Initiative', work: 'Work item', decision: 'Decision',
  knowledge: 'Knowledge', asset: 'Library', recording: 'Recording',
};

export function paletteSearchUrl(tenant: PaletteTenant, query: string): string {
  const q = encodeURIComponent(query.trim());
  return tenant === 'orgiq' ? `/api/search?q=${q}&limit=12` : `/api/${tenant}/search?q=${q}&limit=12`;
}

/** Only an in-app path is ever handed to navigation: a result cannot send the palette to another origin. */
export const isAppPath = (href: unknown): href is string => typeof href === 'string' && /^\/(?![/\\])/.test(href);

function groupName(kind: string): string {
  if (kind === 'Person') return 'People';
  if (/y$/i.test(kind)) return `${kind.slice(0, -1)}ies`;
  return /s$/i.test(kind) ? kind : `${kind}s`;
}

export function toPaletteGroups(tenant: PaletteTenant, rows: readonly Row[]): PaletteRecordGroup[] {
  const groups = new Map<string, PaletteRecord[]>();
  for (const row of rows) {
    if (!row.title || !isAppPath(row.href)) continue;
    const kind = row.kind ?? (tenant === 'orgiq' ? ORGIQ_KIND[row.type] : undefined) ?? row.type;
    const record: PaletteRecord = { id: `${row.type}:${row.id}`, title: row.title, kind, href: row.href, ...(row.subtitle ? { subtitle: row.subtitle } : {}) };
    const name = groupName(kind);
    groups.set(name, [...(groups.get(name) ?? []), record]);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}

/** A stable `searchRecords` for the palette (hand it to CommandPalette through useMemo keyed on the tenant). */
export function createPaletteRecordSearch(tenant: PaletteTenant, request: typeof fetch = (...args) => fetch(...args)): SearchPaletteRecords {
  return async (query, { signal }) => {
    const response = await request(paletteSearchUrl(tenant, query), { credentials: 'include', headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new Error(`Search ${response.status}`);
    const body = await response.json().catch(() => null) as { results?: Row[] } | null;
    return toPaletteGroups(tenant, Array.isArray(body?.results) ? body!.results : []);
  };
}
