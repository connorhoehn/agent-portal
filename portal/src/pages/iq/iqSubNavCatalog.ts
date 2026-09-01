// Per-route contextual SubNav catalog for /iq/* pages. Each entry returns
// the rail title + grouped items appropriate to the active page, instead of
// duplicating the global Layout left sidebar.
//
// Items use query params (?focus=…, ?window=…, ?filter=…) so pages can react
// to a selection without inventing new sub-routes.
//
// RULE: only list an item whose target actually reads its param (or is a real
// route). Decorative entries that silently do nothing were removed — a rail
// full of inert filters reads as broken software, and hid which controls are
// real. When a page learns to read a param, add its item back here.

import type { SubNavItem } from '@connorhoehnslalom/ui-components/shared';
import { useCanaryNavItems } from '../../components/canary/canaryNavItems';
import { useSession } from '../../lib/auth';
import { useCanaryStore } from '../../components/canary/canaryStore';

export interface IqSubNavSpec {
  title: string;
  items: SubNavItem[];
  storageKey: string;
  /** Optional secondary rail rendered between the primary rail and content. */
  secondaryTitle?: string;
  secondaryItems?: SubNavItem[];
  secondaryStorageKey?: string;
}

// ── Static catalogs ─────────────────────────────────────────────────────────

const ARCHITECTURE_ITEMS: SubNavItem[] = [
  { path: 'agents?window=1h',  label: '1 hour',  hint: 'Last 60 min of traffic',  group: 'Window' },
  { path: 'agents?window=24h', label: '24 hours', hint: 'Default window',         group: 'Window' },
  { path: 'agents?window=7d',  label: '7 days',  hint: 'Trend view',              group: 'Window' },
];

// Invoke reads ?session= (deep-links from Memory/Sessions) but none of the
// old focus/prompt params — its own session sidebar covers navigation.
const SCORES_ITEMS: SubNavItem[] = [
  { path: '/iq/scores',          label: 'Overview',  hint: 'Ranked influence + expertise', group: 'Scores' },
  { path: '/iq/scores/cohorts',  label: 'Cohorts',   hint: 'Distribution by team',         group: 'Scores' },
  { path: '/iq/scores/compare',  label: 'Compare',   hint: 'Two-person side-by-side',      group: 'Scores' },
  { path: '/iq/explore',         label: 'Graph',       hint: 'The org as a network',       group: 'Other views' },
  { path: '/iq/projects',        label: 'Initiatives', hint: 'Contributions + status',     group: 'Other views' },
];

// Explore is the "look at the org" surface, so the other org views hang off
// it. Scores is appended in the hook, and only for the leadership roles that
// hold ViewLeaderboard — for everyone else the rail offered a door straight
// into a 403'd leaderboard.
const EXPLORE_ITEMS: SubNavItem[] = [
  { path: '/iq/invoke',   label: 'Ask',         hint: 'Chat + who can help with what', group: 'Other views' },
  { path: '/iq/projects', label: 'Initiatives', hint: 'Contributions + status',       group: 'Other views' },
  { path: 'explore?entities=people',    label: 'People',   group: 'Show' },
  { path: 'explore?entities=skills',    label: 'Skills',   group: 'Show' },
  { path: 'explore?entities=projects',  label: 'Projects', group: 'Show' },
  { path: 'explore?entities=decisions', label: 'Decisions', group: 'Show' },
  { path: 'explore?entities=all',       label: 'All',      group: 'Show' },
  { path: 'explore?layout=force',  label: 'Force',  hint: 'Default',       group: 'Layout' },
  { path: 'explore?layout=radial', label: 'Radial', hint: 'By centrality', group: 'Layout' },
];

// ── Hook ───────────────────────────────────────────────────────────────────

// Prompt Management sub-nav — shared across the prompt-ops overview,
// /iq/prompts, /iq/canary, and the audit surfaces.
const PROMPT_MGMT_ITEMS: SubNavItem[] = [
  { path: '/iq/prompt-ops',           label: 'Overview',        hint: 'What is deployed + what to do next', group: 'Start here' },
  { path: '/iq/prompts',              label: 'Prompt Studio',   hint: 'Author, version, and test prompts',  group: 'Start here' },
  { path: '/iq/canary',               label: 'Deployment',      hint: 'Canary A/B rollout',                 group: 'Start here' },
  { path: '/iq/history',              label: 'History',         hint: 'Version log + past experiments',     group: 'Advanced' },
  { path: '/iq/diff',                 label: 'Diff',            hint: 'Compare two prompt versions',        group: 'Advanced' },
  { path: '/iq/evaluations',          label: 'Evaluations',     hint: 'LLM-as-judge configuration',         group: 'Advanced' },
];

// Work — the agentic queue. Only real routes: the queue itself, the workers
// that drain it, and where finished work leaves a trace. No inert filters.
const WORK_ITEMS: SubNavItem[] = [
  { path: '/iq/work',                        label: 'Queue',   hint: 'Findings, jobs, and what needs you', group: 'Start here' },
  { path: '/admin/devbox',                   label: 'Workers', hint: 'Computers fleet that runs the jobs', group: 'Start here' },
  // "Graph updates", not "Graph changes" — Changes (/admin/changes) is code review.
  { path: '/iq/work/changes',                label: 'Graph updates', hint: 'What reached the org graph',   group: 'Start here' },
  { path: '/admin/observability/invocations', label: 'Runs',   hint: 'What the workers actually did',      group: 'Advanced' },
];

export function useIqSubNav(pathname: string): IqSubNavSpec | null {
  // All hooks must be called unconditionally (rules of hooks).
  const canaryItems = useCanaryNavItems();
  const experimentState = useCanaryStore((s) => s.experimentState);
  const { session } = useSession();
  const seesScores =
    session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const exploreItems = seesScores
    ? [
        { path: '/iq/scores', label: 'Scores', hint: 'Ranked influence + expertise', group: 'Other views' },
        ...EXPLORE_ITEMS,
      ]
    : EXPLORE_ITEMS;

  if (pathname.startsWith('/iq/work')) {
    return { title: 'Work', items: WORK_ITEMS, storageKey: 'iq-work-subnav' };
  }

  if (pathname.startsWith('/iq/prompt-ops') || pathname.startsWith('/iq/prompts') || pathname.startsWith('/iq/history') || pathname.startsWith('/iq/diff') || pathname.startsWith('/iq/evaluations')) {
    return {
      title: 'Prompt Management',
      items: PROMPT_MGMT_ITEMS,
      storageKey: 'iq-prompts-subnav',
    };
  }

  if (pathname.startsWith('/iq/canary')) {
    const isLive = experimentState === 'running' || experimentState === 'terminal';
    return {
      title: 'Prompt Management',
      items: PROMPT_MGMT_ITEMS,
      storageKey: 'iq-canary-subnav',
      ...(isLive ? {
        secondaryTitle: 'Live Experiment',
        secondaryItems: canaryItems,
        secondaryStorageKey: 'iq-canary-secondary',
      } : {}),
    };
  }
  if (pathname.startsWith('/iq/agents')) {
    // The window filter belongs to the fleet graph. On a single agent's page
    // it inherited into the rail and did nothing — a control that looks live,
    // changes the URL, and moves nothing on screen.
    const isSingleAgent = /^\/iq\/agents\/[^/]+/.test(pathname);
    if (isSingleAgent) return null;
    return { title: 'Architecture', items: ARCHITECTURE_ITEMS, storageKey: 'iq-agents-subnav' };
  }
  // /iq/search is a redirect to /iq/invoke — no rail of its own. Ask carries
  // its own session picker in-page, so a rail here was a dead 200px column.
  if (pathname.startsWith('/iq/invoke')) return null;
  if (pathname.startsWith('/iq/scores')) {
    return { title: 'Explore', items: SCORES_ITEMS, storageKey: 'iq-scores-subnav' };
  }
  // Project list → show filter rail; detail pages (/iq/projects/:id) → full-width, no rail.
  if (pathname === '/iq/projects' || pathname.startsWith('/iq/projects?')) {
    // Projects is an Explore view, so it keeps the Explore rail — an empty
    // rail of its own was a dead 200px column with no way back.
    return { title: 'Explore', items: exploreItems, storageKey: 'iq-explore-subnav' };
  }
  if (pathname.startsWith('/iq/projects/')) {
    return null; // detail page is full-width
  }
  if (pathname.startsWith('/iq/explore')) {
    return { title: 'Explore', items: exploreItems, storageKey: 'iq-explore-subnav' };
  }
  return null;
}
