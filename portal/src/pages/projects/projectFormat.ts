// Pure derivations for the Projects list. No React, no JSX — everything here
// is a plain function over a ProjectSummary so it can be reasoned about (and
// unit-tested) without mounting a page.

import { relativeTime } from '../../lib/relativeTime.ts';
import type { ProjectSummary } from './types';

// ─── Status ───────────────────────────────────────────────────────────────────

export const STATUS_OPTIONS = ['all', 'active', 'in_progress', 'planning', 'completed', 'archived'];

export const STATUS_LABELS: Record<string, string> = {
  all: 'All', active: 'Active', in_progress: 'In Progress',
  planning: 'Planning', completed: 'Completed', archived: 'Archived',
};

/** Design-system tone, not a hex. The page used to carry a six-entry table of
 *  raw #hex triples that could not follow a theme. */
export type ProjectTone = 'success' | 'info' | 'warning' | 'caution' | 'danger' | 'neutral';

const STATUS_TONES: Record<string, ProjectTone> = {
  active: 'success',
  completed: 'success',
  in_progress: 'info',
  planning: 'warning',
  paused: 'caution',
  archived: 'neutral',
};

/** Statuses arrive as free text ("In Progress", "in_progress"). Normalise once,
 *  here, so every consumer agrees on the key. */
export function normalizeStatus(status: string | null | undefined): string {
  return (status ?? 'unknown').toLowerCase().replace(/ /g, '_');
}

export function statusTone(status: string | null | undefined): ProjectTone {
  return STATUS_TONES[normalizeStatus(status)] ?? 'neutral';
}

/** Accent stripe along the top of a card. Tailwind classes off the theme
 *  tokens — `caution` has no token in the portal's `@theme` block, so it falls
 *  back to warning. */
export function toneBorderTopClass(tone: ProjectTone): string {
  switch (tone) {
    case 'success': return 'border-t-success';
    case 'info':    return 'border-t-info';
    case 'warning': return 'border-t-warning';
    case 'caution': return 'border-t-warning';
    case 'danger':  return 'border-t-danger';
    default:        return 'border-t-border-emphasis';
  }
}

/** Freshness dot beside the "updated" stamp: green under an hour, amber under
 *  a working day, grey beyond. Token references, not literals, so the dot
 *  follows the theme. */
export function freshnessColor(iso: string | null | undefined): string {
  if (!iso) return 'var(--color-state-idle)';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return 'var(--color-success)';
  if (mins < 480) return 'var(--color-warning)';
  return 'var(--color-state-idle)';
}

// ─── Project key ──────────────────────────────────────────────────────────────

// Short keys for the canonical initiatives, where derived initials would be
// unhelpful ('Observability Platform' → 'OP') or collide ('Design System v3'
// and 'Design System API' both → 'DS'). Anything unlisted falls through to the
// initials rule below.
const KNOWN_KEYS: Record<string, string> = {
  'p-observability':      'OBS',
  'p-auth-migration':     'AUTH',
  'p-llm-platform':       'LLM',
  'p-cost-opt':           'COST',
  'p-realtime-analytics': 'RTA',
  'p-data-lake':          'LAKE',
  'p-feature-store':      'FEAT',
  'p-mobile-redesign':    'MOB',
  'p-design-v3':          'DSV3',
  'p-design-system-api':  'DSAP',
  'p-inference-platform': 'INF',
  'p-rag-search':         'RAG',
  'p-soc2':               'SOC2',
  'p-zero-trust':         'ZT',
};

export function deriveProjectKey(projectId: string, projectName: string): string {
  if (KNOWN_KEYS[projectId]) return KNOWN_KEYS[projectId]!;
  // Take uppercase initials of words with 2+ letters, max 4 chars.
  const initials = projectName
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .map(w => w[0]!.toUpperCase())
    .join('');
  if (initials.length >= 2) return initials.slice(0, 4);
  return projectName.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 4);
}

// ─── Rollups ──────────────────────────────────────────────────────────────────

/** "{openStories} stories · {openBugs} bugs · {done}/{total} pts" — parts the
 *  rollup didn't provide (pre-migration clusters) are omitted, not zeroed. */
export function workLine(p: ProjectSummary): string | null {
  const parts: string[] = [];
  if (p.openStories != null) parts.push(`${p.openStories} ${p.openStories === 1 ? 'story' : 'stories'}`);
  if (p.openBugs != null) parts.push(`${p.openBugs} ${p.openBugs === 1 ? 'bug' : 'bugs'}`);
  if (p.pointsDone != null && p.pointsTotal != null) parts.push(`${p.pointsDone}/${p.pointsTotal} pts`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Open stories/bugs only — for labels that already carry the points ratio,
 *  where workLine's points suffix would say it twice. */
export function openWorkLine(p: ProjectSummary): string | null {
  const parts: string[] = [];
  if (p.openStories != null) parts.push(`${p.openStories} ${p.openStories === 1 ? 'story' : 'stories'}`);
  if (p.openBugs != null) parts.push(`${p.openBugs} ${p.openBugs === 1 ? 'bug' : 'bugs'}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// Promoted to lib/format.ts — the app-wide canonical `usd`. Re-exported here
// so existing `from './projectFormat'` imports keep working.
import { usd } from '../../lib/format.ts';
export { usd };

/**
 * The one-line agent-spend summary for a card.
 *
 * Zero month-to-date is not the same claim as "never ran" — an initiative that
 * spent in June and has been quiet since must not be reported as having no
 * agent history, so the three cases stay distinct.
 */
export function spendLine(p: ProjectSummary): { text: string; muted: boolean } {
  const spend = p.agentSpendUsd ?? 0;
  const last = p.lastAgentActivityAt ? ` · last run ${relativeTime(p.lastAgentActivityAt)}` : '';
  if (spend > 0) return { text: `${usd(spend)} agent spend this month${last}`, muted: false };
  if (p.lastAgentActivityAt) return { text: `no agent spend this month${last}`, muted: true };
  return { text: 'no agent runs yet', muted: true };
}

// ─── The spend window ─────────────────────────────────────────────────────────
// agentSpendUsd is month-to-date: providers/budgets.ts owns the window
// (PERIOD_START_SQL = date_trunc('month', NOW())) and providers/projects.ts
// imports it, so this rollup and the Budgets ledger report one number per
// initiative. It used to be lifetime here and month-to-date there, both
// unlabelled, so clicking from one page to the other looked like the figure had
// changed. Name the window wherever the number appears.

export const SPEND_MONTH = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export const SPEND_TITLE = `Agent spend so far in ${SPEND_MONTH}. Same window as the Budgets ledger, which judges it against this initiative's monthly allocation.`;

// ─── Priority ─────────────────────────────────────────────────────────────────

/** work_items.priority values, hottest first. Anything unknown ranks after
 *  'low' so a null/absent priority never outranks a real one. */
const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'info' | 'neutral'> = {
  critical: 'danger', high: 'warning', medium: 'info', low: 'neutral',
};

export function priorityRank(priority: string | null | undefined): number {
  return priority != null && priority in PRIORITY_ORDER ? PRIORITY_ORDER[priority]! : 4;
}

// ─── Live agent activity ──────────────────────────────────────────────────────

/** "2 agents on it now" — the real-time line. Null when nothing is running,
 *  in which case the card falls back to spendLine's last-run stamp. */
export function liveAgentsLabel(p: ProjectSummary): string | null {
  const n = p.activeAgentRuns ?? 0;
  if (n <= 0) return null;
  return `${n} agent${n === 1 ? '' : 's'} on it now`;
}

// ─── Progress + allocation ────────────────────────────────────────────────────

/** Delivery progress 0–1, or null when the rollup is absent or nothing is
 *  planned (0/0 is "not started planning", not 0%). */
export function pointsFraction(p: ProjectSummary): number | null {
  if (p.pointsDone == null || p.pointsTotal == null || p.pointsTotal <= 0) return null;
  return Math.min(1, p.pointsDone / p.pointsTotal);
}

/** MTD spend over the monthly allocation, uncapped (1.2 = 20% over). Null when
 *  no allocation exists — nothing to be over. */
export function allocationFraction(p: ProjectSummary): number | null {
  if (p.allocatedUsd == null || p.allocatedUsd <= 0) return null;
  return (p.agentSpendUsd ?? 0) / p.allocatedUsd;
}

// ─── Card accent ──────────────────────────────────────────────────────────────

/**
 * The card's top-stripe tone, driven by what is GOING ON, not by the status
 * enum — status made every in-progress card identically blue, which said
 * nothing. Hottest condition wins: money trouble and critical work paint
 * danger, high priority paints warning, live agents paint success, and only
 * a genuinely quiet card falls back to its status tone.
 */
export function cardTone(p: ProjectSummary): ProjectTone {
  const burn = allocationFraction(p);
  if (burn != null && burn > 1) return 'danger';
  if (p.priority === 'critical') return 'danger';
  if (p.priority === 'high') return 'warning';
  if ((p.activeAgentRuns ?? 0) > 0) return 'success';
  return statusTone(p.status);
}

// ─── Sorting + search ─────────────────────────────────────────────────────────

export type ProjectSortKey = 'activity' | 'priority' | 'progress' | 'spend' | 'name';

export const SORT_OPTIONS: Array<{ value: ProjectSortKey; label: string }> = [
  { value: 'activity', label: 'Live activity' },
  { value: 'priority', label: 'Priority' },
  { value: 'progress', label: 'Progress' },
  { value: 'spend',    label: 'Agent spend' },
  { value: 'name',     label: 'Name' },
];

const time = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : 0);

export function compareProjects(a: ProjectSummary, b: ProjectSummary, key: ProjectSortKey): number {
  switch (key) {
    case 'activity':
      // Running agents first, then whoever an agent touched most recently.
      return (b.activeAgentRuns ?? 0) - (a.activeAgentRuns ?? 0)
        || time(b.lastActivityAt) - time(a.lastActivityAt);
    case 'priority':
      return priorityRank(a.priority) - priorityRank(b.priority)
        || (b.activeAgentRuns ?? 0) - (a.activeAgentRuns ?? 0);
    case 'progress': {
      // Furthest-behind first — a progress sort is for finding what needs
      // attention, and 90%-done initiatives are not it.
      const fa = pointsFraction(a); const fb = pointsFraction(b);
      if (fa == null && fb == null) return 0;
      if (fa == null) return 1;
      if (fb == null) return -1;
      return fa - fb;
    }
    case 'spend':
      return (b.agentSpendUsd ?? 0) - (a.agentSpendUsd ?? 0);
    case 'name':
      return a.name.localeCompare(b.name);
  }
}

/** Case-insensitive match over the fields a person actually types: name, key,
 *  owner, SMEs, repo. */
export function matchesQuery(p: ProjectSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    p.name,
    deriveProjectKey(p.id, p.name),
    p.ownerName ?? '',
    ...(p.smeNames ?? []),
    p.repoFullName ?? '',
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

// ─── Program rollup (the KPI strip) ───────────────────────────────────────────

export interface ProgramTotals {
  inFlight: number;
  planning: number;
  agentsActive: number;
  /** Count of initiatives (within this same set) with at least one active
   *  agent run — the number the "Agents active" tile's hint describes. Kept
   *  distinct from `inFlight` (initiatives whose *status* is active/
   *  in_progress): those are different questions, and a tile that answers
   *  one with a hint answering the other reads as self-contradictory (e.g.
   *  "Agents active 0 · 1 in flight" when zero agents are running but one
   *  initiative happens to be status=active). */
  agentsActiveInitiatives: number;
  openStories: number;
  openBugs: number;
  criticalCount: number;
  pointsDone: number;
  pointsTotal: number;
  spendUsd: number;
  allocatedUsd: number;
}

/** Sums the initiatives currently loaded (post-scope, pre-status-filter), so
 *  the tiles describe the program the list is showing. Every field is derived
 *  from the SAME `projects` array — there is no second, differently-filtered
 *  source feeding any one tile's value or hint. */
export function programTotals(projects: ProjectSummary[]): ProgramTotals {
  return projects.reduce<ProgramTotals>((acc, p) => {
    const s = normalizeStatus(p.status);
    const active = p.activeAgentRuns ?? 0;
    return {
      inFlight: acc.inFlight + (s === 'active' || s === 'in_progress' ? 1 : 0),
      planning: acc.planning + (s === 'planning' ? 1 : 0),
      agentsActive: acc.agentsActive + active,
      agentsActiveInitiatives: acc.agentsActiveInitiatives + (active > 0 ? 1 : 0),
      openStories: acc.openStories + (p.openStories ?? 0),
      openBugs: acc.openBugs + (p.openBugs ?? 0),
      criticalCount: acc.criticalCount + (p.priority === 'critical' ? 1 : 0),
      pointsDone: acc.pointsDone + (p.pointsDone ?? 0),
      pointsTotal: acc.pointsTotal + (p.pointsTotal ?? 0),
      spendUsd: acc.spendUsd + (p.agentSpendUsd ?? 0),
      allocatedUsd: acc.allocatedUsd + (p.allocatedUsd ?? 0),
    };
  }, { inFlight: 0, planning: 0, agentsActive: 0, agentsActiveInitiatives: 0, openStories: 0, openBugs: 0,
       criticalCount: 0, pointsDone: 0, pointsTotal: 0, spendUsd: 0, allocatedUsd: 0 });
}

// ─── Filtering ────────────────────────────────────────────────────────────────

export function filterByStatus(projects: ProjectSummary[], statusFilter: string): ProjectSummary[] {
  if (statusFilter === 'all') return projects;
  return projects.filter(p => normalizeStatus(p.status) === statusFilter);
}

/** Only offer a filter chip for a status that actually appears in the data. */
export function visibleStatusOptions(projects: ProjectSummary[]): string[] {
  const present = new Set(projects.map(p => normalizeStatus(p.status)));
  return STATUS_OPTIONS.filter(s => s === 'all' || present.has(s));
}
