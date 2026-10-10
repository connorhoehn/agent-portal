/** Personal presentation preferences only. The strip contains no activity data. */
export const TODAY_CATEGORIES = ['review', 'agenda', 'goals', 'automation', 'budget'] as const;
export type TodayCategory = typeof TODAY_CATEGORIES[number];
export interface TodayPreferences {
  hidden: boolean; dimmed: boolean; paused: boolean; quiet: boolean;
  speed: 'slow' | 'fast'; categories: TodayCategory[];
}
export const DEFAULT_TODAY_PREFERENCES: TodayPreferences = {
  hidden: false, dimmed: false, paused: false, quiet: false, speed: 'slow', categories: [...TODAY_CATEGORIES],
};
export function todayPreferencesKey(actor: string | null | undefined, tenant: string | null | undefined): string | null {
  const identity = actor?.trim(), workspace = tenant?.trim();
  return identity && workspace ? `footer-today.preferences.v1:${JSON.stringify([identity, workspace])}` : null;
}
export function readTodayPreferences(raw: string | null): TodayPreferences {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preference');
    const row = value as Record<string, unknown>;
    const categories = row.categories;
    return {
      hidden: row.hidden === true, dimmed: row.dimmed === true, paused: row.paused === true, quiet: row.quiet === true,
      speed: row.speed === 'fast' ? 'fast' : 'slow',
      categories: Array.isArray(categories) ? TODAY_CATEGORIES.filter(category => categories.includes(category)) : [...TODAY_CATEGORIES],
    };
  } catch { return { ...DEFAULT_TODAY_PREFERENCES, categories: [...TODAY_CATEGORIES] }; }
}
export const TODAY_SAMPLES: ReadonlyArray<{ category: TodayCategory; label: string; summary: string; detail: string }> = [
  { category: 'review', label: 'Needs review', summary: 'A draft is ready for your review', detail: 'Sample: review a proposed draft before accepting any changes.' },
  { category: 'agenda', label: 'Agenda', summary: 'Make time for a team check-in', detail: 'Sample: an upcoming check-in would appear here when calendar activity is connected.' },
  { category: 'goals', label: 'Goals', summary: 'Choose the next step toward a goal', detail: 'Sample: a goal update would help you choose what to work on next.' },
  { category: 'automation', label: 'Automation', summary: 'An automation summary is ready', detail: 'Sample: review an automation result before deciding whether to act on it.' },
  { category: 'budget', label: 'Budget', summary: 'Review a sample spending notice', detail: 'Sample: a spending notice would appear here. No live budget or usage is connected.' },
];
export function todayRotationAllowed(options: { paused: boolean; quiet: boolean; engaged: boolean; reducedMotion: boolean; pageVisible: boolean; activeCall: boolean; count: number }): boolean {
  return options.count > 1 && !options.paused && !options.quiet && !options.engaged && !options.reducedMotion && options.pageVisible && !options.activeCall;
}
