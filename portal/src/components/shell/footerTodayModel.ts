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
  { category: 'review', label: 'Needs review', summary: '2 agent drafts need your decision', detail: 'Sample: two proposed changes are ready for review. Check the work and its evidence before approving the next step.' },
  { category: 'agenda', label: 'Agenda', summary: 'Project review at 2 PM · 3 work items', detail: 'Sample: a project review at 2 PM covers three work items. A connected agenda would open the meeting and its shared work.' },
  { category: 'goals', label: 'Goals', summary: 'Weekly goal · 3 of 5 milestones complete', detail: 'Sample: three of five milestones are complete. The next milestone depends on reviewing the outstanding agent drafts.' },
  { category: 'automation', label: 'Automation', summary: '8 agents · 3 finished · 2 need review · 3 planning', detail: 'Sample: eight agents have work in progress. Of three finished runs, two succeeded and one needs attention; two other runs await review and three are planning.' },
  { category: 'budget', label: 'Budget', summary: 'Daily budget · 20% used ($829)', detail: 'Sample: $829 of a $4,145 daily budget has been used. No live budget is connected, and this preview cannot request or authorize additional spending.' },
];
export function todayRotationAllowed(options: { paused: boolean; quiet: boolean; engaged: boolean; reducedMotion: boolean; pageVisible: boolean; activeCall: boolean; count: number }): boolean {
  return options.count > 1 && !options.paused && !options.quiet && !options.engaged && !options.reducedMotion && options.pageVisible && !options.activeCall;
}
