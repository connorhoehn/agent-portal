// Pure derivations for the Projects list. No React, no JSX — everything here
// is a plain function over a ProjectSummary so it can be reasoned about (and
// unit-tested) without mounting a page.

import { relativeTime } from '../../lib/relativeTime';
import type { ProjectSummary } from './types';

// ─── Status ───────────────────────────────────────────────────────────────────

export const STATUS_OPTIONS = ['all', 'active', 'in_progress', 'planning', 'completed', 'archived'];

export const STATUS_LABELS: Record<string, string> = {
  all: 'All', active: 'Active', in_progress: 'In Progress',
  planning: 'Planning', completed: 'Completed', archived: 'Archived',
};

/** Design-system tone, not a hex. The page used to carry a six-entry table of
 *  raw #hex triples that could not follow a theme. */
export type ProjectTone = 'success' | 'info' | 'warning' | 'caution' | 'neutral';

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

export function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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
