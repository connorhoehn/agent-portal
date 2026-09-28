// The Distillation module's vertical sub-nav: three groups — Knowledge,
// Review, Activity — whose entries are the views inside each destination
// (Guides & findings / Patterns / Run notes; Pending / Reviewed; Runs / Tier
// graph). No React; the counts come from live data the module already reads.
//
// Two entries share a pathname (…/knowledge?view=patterns vs ?view=notes), so
// "which one is active" is decided here from the pathname AND the view/tab
// param — NavLink's isActive compares the pathname only and would light every
// entry of a group at once.

import {
  promotionReviewHref, activityHref, knowledgeHref, parseActivity, parseKnowledge, parseReview, reviewHref, tabForPath,
  type ActivityView, type KnowledgeView, type ReviewTab,
} from './distillationRoutes.ts';

export type ModuleNavId =
  | 'guides' | 'patterns' | 'notes'
  | 'pending' | 'decided' | 'promotions'
  | 'runs' | 'graph';

export interface ModuleNavEntry {
  id: ModuleNavId;
  group: 'Knowledge' | 'Review' | 'Activity';
  label: string;
  path: string;
  hint: string;
  count?: number;
  accent?: 'warning' | 'danger';
}

export interface ModuleNavCounts {
  /** Tier row counts; null/undefined = not loaded (no count shown, never 0). */
  L0?: number | null;
  L1?: number | null;
  L2?: number | null;
  promotions?: number | null;
  pending?: number | null;
  decided?: number | null;
  /** The Activity health dot: a tier behind or stalled. */
  health?: 'warning' | 'danger' | null;
}

const has = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);

export function moduleNav(counts: ModuleNavCounts, repo: string | null, canReview: boolean): ModuleNavEntry[] {
  const k = (view: KnowledgeView) => knowledgeHref({ view, repo });
  const r = (tab: ReviewTab) => reviewHref({ tab, repo });
  const a = (view: ActivityView) => activityHref({ view, repo });
  return [
    { id: 'guides', group: 'Knowledge', label: 'Guides & findings', path: k('guides'), hint: 'Reusable runbooks, procedures, insights and decisions', ...(has(counts.L2) ? { count: counts.L2 } : {}) },
    { id: 'patterns', group: 'Knowledge', label: 'Patterns', hint: 'Related run notes combined into one claim', path: k('patterns'), ...(has(counts.L1) ? { count: counts.L1 } : {}) },
    { id: 'notes', group: 'Knowledge', label: 'Run notes', hint: 'What happened in one agent session', path: k('notes'), ...(has(counts.L0) ? { count: counts.L0 } : {}) },
    {
      id: 'pending', group: 'Review', label: 'Knowledge pending', path: r('pending'),
      hint: canReview ? 'Check sampled findings against their sources' : 'Sampled findings and their evidence (read-only for your role)',
      ...(has(counts.pending) ? { count: counts.pending } : {}),
    },
    { id: 'decided', group: 'Review', label: 'Knowledge reviewed', hint: 'Verdicts already recorded', path: r('decided'), ...(has(counts.decided) ? { count: counts.decided } : {}) },
    { id: 'promotions', group: 'Review', label: 'Asset promotions', hint: 'Review insights, runbooks and skills; skills require approval and a passing dry run', path: promotionReviewHref(new URLSearchParams(repo ? { repo } : {})), ...(has(counts.promotions) ? { count: counts.promotions } : {}) },
    { id: 'runs', group: 'Activity', label: 'Runs', hint: 'Compaction history and the run inspector', path: a('runs'), ...(counts.health ? { accent: counts.health } : {}) },
    { id: 'graph', group: 'Activity', label: 'Tier graph', hint: 'Run notes → patterns → guides → Agent library', path: a('graph') },
  ];
}

/** The entry the current URL is on, or null off-module. */
export function activeNavId(pathname: string, search: string): ModuleNavId | null {
  const tab = tabForPath(pathname);
  if (tab === 'knowledge') return parseKnowledge(search).view;
  if (tab === 'review') return new URLSearchParams(search).get('view') === 'promotions' ? 'promotions' : parseReview(search).tab;
  if (tab === 'activity') return parseActivity(search).view;
  return null;
}

/** The header title for the current destination. */
export function destinationTitle(pathname: string): string {
  const tab = tabForPath(pathname);
  return tab === 'review' ? 'Review' : tab === 'activity' ? 'Activity' : 'Knowledge';
}
