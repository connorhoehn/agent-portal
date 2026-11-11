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

import type { SubNavItem } from '@connorhoehn/ui-components/shared';
import { useAutomateSpec } from '../work/automateNav';
import { useCanaryNavItems } from '../../components/canary/canaryNavItems';
import { useSession } from '../../lib/auth';
import { useCanaryStore } from '../../components/canary/canaryStore';
import { promptMgmtItemsFor } from './iqSubNavFormat';

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


// Invoke reads ?session= (deep-links from Memory/Sessions) but none of the
// old focus/prompt params — its own session sidebar covers navigation.
const SCORES_ITEMS: SubNavItem[] = [
  { path: '/iq/scores',          label: 'Overview', group: 'Scores' },
  { path: '/iq/scores/cohorts',  label: 'Cohorts', group: 'Scores' },
  { path: '/iq/scores/compare',  label: 'Compare', group: 'Scores' },
  { path: '/iq/explore',         label: 'Explore', group: 'Other views' },
];

// Explore's rail is only the entity lens now. Ask and Initiatives are
// top-level doors of their own (duplicating them here made the rail read as a
// second, stale main nav), and Force/Radial are a rendering choice, not a
// place — they moved into the page's own toolbar as a toggle.
const EXPLORE_ITEMS: SubNavItem[] = [
  { path: '/iq/explore?entities=people',    label: 'People',   group: 'Show' },
  { path: '/iq/explore?entities=skills',    label: 'Skills',   group: 'Show' },
  { path: '/iq/explore?entities=projects',  label: 'Projects', group: 'Show' },
  { path: '/iq/explore?entities=hierarchy', label: 'Hierarchy', group: 'Show' },
  { path: '/iq/explore?entities=all',       label: 'All',      group: 'Show' },
];

// ── Hook ───────────────────────────────────────────────────────────────────

// Prompt Management sub-nav — shared across the prompt-ops overview,
// /iq/prompts, /iq/canary, and the audit surfaces. The item list + the
// platform-role filter over it live in iqSubNavFormat.ts (pure, unit-tested);
// this file only wires it to the current viewer's role.

// There is deliberately NO Delivery sub-rail any more. Initiatives, Queue and
// Budgets are global rail doors (Layout.tsx, grouped by SDLC phase), sprints
// are a lens on Initiatives, and Graph updates is linked from the Queue page
// itself — a sub-rail here could only duplicate the global hierarchy, and a
// nested link that jumps to another top-level door breaks the breadcrumb
// trail (the old Workers item did exactly that).

export function useIqSubNav(pathname: string): IqSubNavSpec | null {
  // All hooks must be called unconditionally (rules of hooks).
  const automateSpec = useAutomateSpec();
  const canaryItems = useCanaryNavItems();
  const experimentState = useCanaryStore((s) => s.experimentState);
  const { session } = useSession();
  const seesScores =
    session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const promptItems = promptMgmtItemsFor(seesScores);
  const exploreItems = seesScores
    ? [
        { path: '/iq/scores', label: 'Scores', group: 'Other views' },
        ...EXPLORE_ITEMS,
      ]
    : EXPLORE_ITEMS;
  // The Automate family — overview, queue, findings, and (via AdminLayout)
  // bots + changes share this one rail.
  if (pathname.startsWith('/iq/search') || pathname.startsWith('/iq/invoke') || pathname.startsWith('/iq/explore')) return null;
  if (pathname.startsWith('/iq/work')) return automateSpec;

  if (pathname.startsWith('/iq/library')) return null; // The catalog owns its stacked menu.
  if (pathname.startsWith('/iq/local-compute')) return {
    title: 'Local compute', storageKey: 'local-compute-nav', items: [
      { path: '/iq/local-compute?view=machines', label: 'Machines' },
      { path: '/iq/local-compute?view=runs', label: 'Runs' },
    ],
  };

  if (pathname.startsWith('/iq/prompt-ops') || pathname.startsWith('/iq/prompts') || pathname.startsWith('/iq/history') || pathname.startsWith('/iq/diff') || pathname.startsWith('/iq/evaluations')) {
    // A role that only sees Browse gets a one-row rail titled "Prompt
    // Management" whose only link is the page it is on — 200px of chrome
    // for a self-link. No rail at all: the Library renders full-width.
    if (promptItems.length < 2) return null;
    return {
      title: 'Prompt Management',
      items: promptItems,
      storageKey: 'iq-prompts-subnav',
    };
  }

  if (pathname.startsWith('/iq/canary')) {
    const isLive = experimentState === 'running' || experimentState === 'terminal';
    return {
      title: 'Prompt Management',
      // The live experiment's controls join the one section rail under their
      // own headings — a second rail beside it was a third navigation column
      // at the content top (docs/layout-cascade.md rule 1).
      items: isLive ? [...promptItems, ...canaryItems] : promptItems,
      storageKey: 'iq-canary-subnav',
    };
  }
  // /iq/agents has no rail. The only thing it ever held was the Window
  // filter (1 hour / 24 hours / 7 days), and the fleet graph's own toolbar
  // carries the same three-way choice — one setting drawn twice, and a 200px
  // column spent on it. The toolbar keeps it; the graph gets the width.
  if (pathname.startsWith('/iq/agents')) return null;
  // /iq/search is a redirect to /iq/invoke — no rail of its own. Ask carries
  // its own session picker in-page, so a rail here was a dead 200px column.
  if (pathname.startsWith('/iq/invoke')) return null;
  if (pathname.startsWith('/iq/scores')) {
    // "Scores", like the top-level door, the breadcrumb and the palette —
    // the Explore side's rail is titled Explore and links here as "Scores".
    return { title: 'Scores', items: SCORES_ITEMS, storageKey: 'iq-scores-subnav' };
  }
  // The program page carries its own lens toggle and filters — no rail.
  if (pathname.startsWith('/iq/projects')) return null;
  if (pathname.startsWith('/iq/explore')) {
    return { title: 'Explore', items: exploreItems, storageKey: 'iq-explore-subnav' };
  }
  return null;
}
