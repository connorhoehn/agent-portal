// Per-route contextual SubNav catalog for /iq/* pages. Each entry returns
// the rail title + grouped items appropriate to the active page, instead of
// duplicating the global Layout left sidebar.
//
// Items use query params (?focus=…, ?window=…, ?filter=…) so pages can react
// to a selection without inventing new sub-routes. Pages that haven't wired
// any of those params yet still show the menu for navigation flavor; the
// params become live once the page reads them.

import { useMemo } from 'react';
import type { SubNavItem } from '../../components/shell/SubNavLayout';
import { useCanaryNavItems } from '../../components/canary/canaryNavItems';
import { useCanaryStore } from '../../components/canary/canaryStore';
import { useFetch } from '../../hooks/useFetch';

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
  { path: 'agents?filter=all',     label: 'All agents',  group: 'Filter' },
  { path: 'agents?filter=active',  label: 'Active only', hint: 'Recent traffic > 0', group: 'Filter' },
  { path: 'agents?filter=errors',  label: 'With errors', hint: 'p95 over budget',  group: 'Filter' },
  { path: 'agents?cluster=all',     label: 'All clusters', group: 'Cluster' },
  { path: 'agents?cluster=orgiq',   label: 'OrgIQ',        hint: '6 core agents',   group: 'Cluster' },
  { path: 'agents?cluster=newsroom',label: 'Newsroom',     hint: '3 newsroom agents', group: 'Cluster' },
  { path: 'agents?focus=legend',   label: 'Edge colors', hint: 'green/amber/red',  group: 'Reference' },
];

// Static items without History — History group is built dynamically from sessions.
const SEARCH_STATIC_ITEMS: SubNavItem[] = [
  { path: '/iq/search?prompt=who-knows',     label: 'Who knows X?',         hint: 'Deepest expertise',     group: 'Suggested' },
  { path: '/iq/search?prompt=decisions',     label: 'Decisions about X',    hint: 'Recent platform calls', group: 'Suggested' },
  { path: '/iq/search?prompt=who-works-on',  label: 'Who works on Y',       hint: 'Contributors + roles',  group: 'Suggested' },
  { path: '/iq/search?prompt=compare',       label: 'Compare two people',   hint: 'Side-by-side profiles', group: 'Suggested' },
];

const INVOKE_ITEMS: SubNavItem[] = [
  { path: 'invoke?focus=orchestrator', label: 'Orchestrator',  hint: 'Top-level router',         group: 'Pipeline' },
  { path: 'invoke?focus=sub-agents',   label: 'Sub-agents',    hint: 'Search / Scoring / Advisor', group: 'Pipeline' },
  { path: 'invoke?focus=sessions',     label: 'Sessions',      hint: 'Recent invocations',       group: 'History' },
  { path: 'invoke?prompt=find-expert', label: 'Find an expert',     group: 'Quick prompts' },
  { path: 'invoke?prompt=strategic',   label: 'Strategic question', group: 'Quick prompts' },
  { path: 'invoke?prompt=guardrail',   label: 'Test the guardrail', accent: 'warning', group: 'Quick prompts' },
];

const SCORES_ITEMS: SubNavItem[] = [
  { path: 'scores',          label: 'Overview',  hint: 'Ranked influence + expertise', group: 'View' },
  { path: 'scores/cohorts',  label: 'Cohorts',   hint: 'Distribution by team',         group: 'View' },
  { path: 'scores/compare',  label: 'Compare',   hint: 'Two-person side-by-side',      group: 'View' },
  { path: 'scores?window=7d',  label: '7 days',  group: 'Window' },
  { path: 'scores?window=30d', label: '30 days', group: 'Window' },
  { path: 'scores?window=90d', label: '90 days', group: 'Window' },
];

const DECISIONS_ITEMS: SubNavItem[] = [
  { path: 'decisions?status=open',     label: 'Open',     hint: 'Awaiting action',  group: 'Status' },
  { path: 'decisions?status=approved', label: 'Approved', hint: 'Greenlit',         group: 'Status' },
  { path: 'decisions?status=blocked',  label: 'Blocked',  hint: 'Held by review',   accent: 'warning', group: 'Status' },
  { path: 'decisions?status=closed',   label: 'Closed',   hint: 'Resolved',         group: 'Status' },
  { path: 'decisions?scope=platform',  label: 'Platform', group: 'Scope' },
  { path: 'decisions?scope=product',   label: 'Product',  group: 'Scope' },
  { path: 'decisions?scope=org',       label: 'Org-level', group: 'Scope' },
];

const PROJECTS_ITEMS: SubNavItem[] = [
  { path: 'projects?status=active',  label: 'Active',  group: 'Status' },
  { path: 'projects?status=paused',  label: 'Paused',  accent: 'warning', group: 'Status' },
  { path: 'projects?status=done',    label: 'Shipped', accent: 'success', group: 'Status' },
  { path: 'projects?sort=recent',    label: 'Recent activity', group: 'Sort' },
  { path: 'projects?sort=size',      label: 'Most contributors', group: 'Sort' },
];

const EXPLORE_ITEMS: SubNavItem[] = [
  { path: 'explore?entities=people',    label: 'People',   group: 'Show' },
  { path: 'explore?entities=skills',    label: 'Skills',   group: 'Show' },
  { path: 'explore?entities=projects',  label: 'Projects', group: 'Show' },
  { path: 'explore?entities=decisions', label: 'Decisions', group: 'Show' },
  { path: 'explore?entities=all',       label: 'All',      group: 'Show' },
  { path: 'explore?layout=force',  label: 'Force',  hint: 'Default',       group: 'Layout' },
  { path: 'explore?layout=radial', label: 'Radial', hint: 'By centrality', group: 'Layout' },
];

const CODE_INTERPRETER_ITEMS: SubNavItem[] = [
  { path: 'code-interpreter?example=stats',  label: 'Quick stats',  hint: 'Summary by team', group: 'Examples' },
  { path: 'code-interpreter?example=chart',  label: 'Chart it',     hint: 'matplotlib demo', group: 'Examples' },
  { path: 'code-interpreter?example=sql',    label: 'SQL via Aurora', hint: 'Data API path', group: 'Examples' },
  { path: 'code-interpreter?focus=sessions', label: 'Sessions', group: 'History' },
];

// ── Hook ───────────────────────────────────────────────────────────────────

// Prompt Management sub-nav — shared across /iq/prompts and /iq/canary
const PROMPT_MGMT_ITEMS: SubNavItem[] = [
  { path: '/iq/prompts',              label: 'Prompt Studio',   hint: 'Bedrock library browser + editor',  group: 'Prompts' },
  { path: '/iq/canary',               label: 'Deployment',      hint: 'Canary A/B rollout',                group: 'Prompts' },
  { path: '/iq/canary?focus=decisions', label: 'Experiments',   hint: 'Live canary decisions',             group: 'Prompts' },
  { path: '/iq/history',              label: 'History',         hint: 'Version log + past experiments',    group: 'Audit' },
  { path: '/iq/diff',                 label: 'Diff',            hint: 'Compare two prompt versions RO',    group: 'Audit' },
  { path: '/iq/evaluations',          label: 'Evaluations',     hint: 'LLM-as-judge configuration',        group: 'Audit' },
];

interface SessionSummary {
  sessionId: string;
  createdAt: string;
  title?: string;
}

export function useIqSubNav(pathname: string): IqSubNavSpec | null {
  // All hooks must be called unconditionally (rules of hooks).
  const canaryItems = useCanaryNavItems();
  const experimentState = useCanaryStore((s) => s.experimentState);
  const { data: sessionData } = useFetch<{ sessions: SessionSummary[] }>(
    pathname.startsWith('/iq/search') ? '/api/sessions' : null,
    8000,
  );

  const searchItems = useMemo<SubNavItem[]>(() => {
    const sessions = sessionData?.sessions ?? [];
    const historyItems: SubNavItem[] = [
      { path: '/iq/search?session=new', label: 'New session', group: 'History', groupScrollAfter: 7 },
      ...sessions.slice(0, 20).map<SubNavItem>((s) => ({
        path: `/iq/search?session=${encodeURIComponent(s.sessionId)}`,
        label: s.title || 'Untitled session',
        hint: new Date(s.createdAt).toLocaleString(),
        group: 'History',
        groupScrollAfter: 7,
      })),
    ];
    return [...SEARCH_STATIC_ITEMS, ...historyItems];
  }, [sessionData]);

  if (pathname.startsWith('/iq/prompts') || pathname.startsWith('/iq/history') || pathname.startsWith('/iq/diff') || pathname.startsWith('/iq/evaluations')) {
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
    return { title: 'Architecture', items: ARCHITECTURE_ITEMS, storageKey: 'iq-agents-subnav' };
  }
  if (pathname.startsWith('/iq/search')) {
    return { title: 'Search', items: searchItems, storageKey: 'iq-search-subnav' };
  }
  if (pathname.startsWith('/iq/invoke')) {
    return { title: 'Search', items: INVOKE_ITEMS, storageKey: 'iq-invoke-subnav' };
  }
  if (pathname.startsWith('/iq/scores')) {
    return { title: 'Scores', items: SCORES_ITEMS, storageKey: 'iq-scores-subnav' };
  }
  if (pathname.startsWith('/iq/decisions')) {
    return { title: 'Decisions', items: DECISIONS_ITEMS, storageKey: 'iq-decisions-subnav' };
  }
  // Project list → show filter rail; detail pages (/iq/projects/:id) → full-width, no rail.
  if (pathname === '/iq/projects' || pathname.startsWith('/iq/projects?')) {
    return { title: 'Projects', items: PROJECTS_ITEMS, storageKey: 'iq-projects-subnav' };
  }
  if (pathname.startsWith('/iq/projects/')) {
    return null; // detail page is full-width
  }
  if (pathname.startsWith('/iq/explore')) {
    return { title: 'Explore', items: EXPLORE_ITEMS, storageKey: 'iq-explore-subnav' };
  }
  if (pathname.startsWith('/iq/code-interpreter')) {
    return { title: 'Code Interpreter', items: CODE_INTERPRETER_ITEMS, storageKey: 'iq-code-interpreter-subnav' };
  }
  return null;
}
