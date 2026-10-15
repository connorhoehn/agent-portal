/**
 * The footer's Today strip: what the BFF says about today (GET /api/today,
 * middleware routes/today.ts) and the exact signed-context preferences key.
 * Rendering and preferences belong to the native ActivityTicker. There are no
 * sample figures here: each item is a selector over the rows the page behind
 * it reads, so the strip cannot contradict the Budgets or Inbox page.
 */
export const TODAY_CATEGORIES = ['review', 'agenda', 'goals', 'automation', 'budget'] as const;
export type TodayCategory = typeof TODAY_CATEGORIES[number];
export interface TodayItem { category: TodayCategory; label: string; summary: string; detail: string }

export function todayPreferencesKey(actor: string | null | undefined, tenant: string | null | undefined): string | null {
  const identity = actor?.trim(), workspace = tenant?.trim();
  return identity && workspace ? `footer-today.preferences.v1:${JSON.stringify([identity, workspace])}` : null;
}

/** The wire's items in the strip's priority order; anything malformed or of an unknown category is dropped. */
export function todayItemsFromWire(body: unknown): TodayItem[] {
  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(TODAY_CATEGORIES);
  const items = raw.filter((i): i is TodayItem => !!i && typeof i === 'object'
    && known.has((i as TodayItem).category) && typeof (i as TodayItem).label === 'string'
    && typeof (i as TodayItem).summary === 'string' && typeof (i as TodayItem).detail === 'string');
  return TODAY_CATEGORIES.flatMap((c) => items.filter((i) => i.category === c));
}

/** The categories the settings list offers: only those that have an item. */
export function todayCategories(items: readonly TodayItem[]): Array<{ id: TodayCategory; label: string }> {
  const seen = new Map<TodayCategory, string>();
  for (const item of items) if (!seen.has(item.category)) seen.set(item.category, item.label);
  return [...seen].map(([id, label]) => ({ id, label }));
}
