// The initiative Overview tab's model (v2, docs/design/initiative-v2-plan.md
// S1, A1–A2, U1–U2): the one-line stats, "Needs attention N" and "Up next".
// No React; unit-tested alone.
//
// Everything is read off rows the page already fetched — the project detail
// and its /work tree. The ordering is the Work list's own "By priority" order
// (workRows(tree, 'priority', '')) so "Up next" is exactly the top of the
// list that "View all N" opens, not a second ranking (D2).
//
// Honest numbers: a count is the length of rows we hold; a rollup the server
// could not produce (null) renders as unknown, never as 0; and a failed /work
// read is its own state, never the "Nothing is blocked" copy.

import { sumForestPoints, type FlatWorkItem } from './projectFormat.ts';
import { plural, pluralWord } from '../../lib/plural.ts';
import { isBlocked, workRows } from './workListModel.ts';
import type { ProjectDetail, WorkItemTree } from './types';

/** Dollars as the header writes them: whole amounts without cents ("$95"),
 *  anything else to the cent ("$1.73"). */
export function money(n: number): string {
  if (Number.isInteger(n)) return `$${n.toLocaleString('en-US')}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}


/** "5 points", "1 point". */
export function pointsLabel(n: number): string {
  return `${n} ${pluralWord(n, 'point')}`;
}

/** The row column's short form: "5 pts", "1 pt". */
export function ptsLabel(n: number): string {
  return `${n} ${pluralWord(n, 'pt')}`;
}

/** First name for prose ("what Eli needs"); null when there is no name. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

// ─── Stat strip ──────────────────────────────────────────────────────────────

/** One cluster of the stats line: a bold value, then its label. */
export interface OverviewStat {
  id: 'points' | 'agents' | 'spend';
  /** The bold part — "18", "2", "$1.73". `—` when the number is unknown. */
  value: string;
  /** The rest of the sentence — "/ 52 points delivered", "agents running". */
  label: string;
  /** 0–1 fill for the points bar; absent on the other cells. */
  progress?: number;
  /** True when the value is unknown or there is nothing to show. */
  muted?: boolean;
}

function pointsStat(tree: WorkItemTree[] | null): OverviewStat {
  if (tree == null) return { id: 'points', value: '—', label: 'points delivered', muted: true };
  const { done, total } = sumForestPoints(tree);
  // 0/0 is "nothing sized yet", not 0% — no bar to draw.
  if (total <= 0) return { id: 'points', value: '0', label: 'points planned', muted: true };
  return { id: 'points', value: String(done), label: `/ ${plural(total, 'point')} delivered`, progress: Math.min(1, done / total) };
}

function agentsStat(runs: number | null | undefined): OverviewStat {
  if (runs == null) return { id: 'agents', value: '—', label: 'agents running', muted: true };
  return { id: 'agents', value: String(runs), label: `${pluralWord(runs, 'agent')} running`, muted: runs === 0 };
}

/** "$1.73 of $95 spent"; with no allocation, just "$1.73 spent". */
function spendStat(spent: number | null | undefined, allocated: number | null | undefined): OverviewStat {
  if (spent == null) return { id: 'spend', value: '—', label: 'spent', muted: true };
  const label = allocated != null && allocated > 0 ? `of ${money(allocated)} spent` : 'spent';
  return { id: 'spend', value: money(spent), label };
}

/** The three clusters: points delivered, agents running, spent of allocated.
 *  `tree` is null when /work has not loaded or failed. */
export function overviewStats(project: ProjectDetail, tree: WorkItemTree[] | null): OverviewStat[] {
  return [
    pointsStat(tree),
    agentsStat(project.activeAgentRuns),
    // Below the budgets read tier the server withheld the figures (budgetAccess): say so, never '—' or $0.
    project.budgetAccess ? { id: 'spend', value: 'Locked', label: 'spent · budget figures locked', muted: true } : spendStat(project.agentSpendUsd, project.allocatedUsd),
  ];
}

/** The condensed header line on the Work tab: "18 / 52 points delivered · $1.73 spent".
 *  Parts the page cannot know are left out, not zeroed. */
export function headerStatsLine(project: ProjectDetail, tree: WorkItemTree[] | null): string | null {
  const parts: string[] = [];
  if (tree != null) {
    const { done, total } = sumForestPoints(tree);
    if (total > 0) parts.push(`${done} / ${plural(total, 'point')} delivered`);
  }
  if (project.agentSpendUsd != null) parts.push(`${money(project.agentSpendUsd)} spent`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ─── Needs attention ─────────────────────────────────────────────────────────

/** One blocked item: "Blocked" · title / reason · assignee ┆ points ┆ Open →. */
export interface AttentionItem {
  id: string;
  key?: string | null;
  title: string;
  /** Why it is blocked — the short `blockedReason`; the summary, then the
   *  description, when no reason was written. Null when there is nothing. */
  reason: string | null;
  /** Null when unassigned: the person column stays empty rather than
   *  claiming someone. */
  assigneeName: string | null;
  /** Resolved by person id from the initiative contributors; never guessed by name. */
  assigneeAvatarUrl: string | null;
  /** "2 pts"; null when unsized. */
  points: string | null;
  /** Opens the item on the Work tab. */
  href: string;
}

export const ATTENTION_NONE = 'Nothing is blocked.';

/** Work-tab deep link for one item. */
export function workItemHref(projectId: string, itemId: string): string {
  return `/iq/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ tab: 'work', item: itemId }).toString()}`;
}

function attentionOf(projectId: string, row: FlatWorkItem, avatarUrl: string | null): AttentionItem {
  const reason = [row.blockedReason, row.summary, row.description].map((s) => s?.trim()).find(Boolean) ?? null;
  return {
    id: row.id,
    key: row.key ?? null,
    title: row.title,
    reason,
    assigneeName: row.assigneeName ?? null,
    assigneeAvatarUrl: avatarUrl,
    points: row.storyPoints != null ? ptsLabel(row.storyPoints) : null,
    href: workItemHref(projectId, row.id),
  };
}

// ─── Up next ─────────────────────────────────────────────────────────────────

/** Title with its item key below; person and points sit in aligned columns. */
export interface UpNextRow {
  id: string;
  key?: string | null;
  title: string;
  /** Null when unassigned — the column reads "Unassigned", never a guess. */
  assigneeName: string | null;
  /** Resolved by person id from the initiative contributors; never guessed by name. */
  assigneeAvatarUrl: string | null;
  /** "5 pts"; null when unsized. */
  points: string | null;
  href: string;
}

function upNextOf(projectId: string, row: FlatWorkItem, avatarUrl: string | null): UpNextRow {
  return {
    id: row.id,
    key: row.key ?? null,
    title: row.title,
    assigneeName: row.assigneeName ?? null,
    assigneeAvatarUrl: avatarUrl,
    points: row.storyPoints != null ? ptsLabel(row.storyPoints) : null,
    href: workItemHref(projectId, row.id),
  };
}

export const UP_NEXT_LIMIT = 3;

// ─── What the learning loop wants from this initiative ───────────────────────

/** One more line under "Needs attention": a count from the learning loop and the Learning tab it opens. */
export interface LearningAttention { id: 'failed-runs' | 'proposals'; text: string; href: string }

const WEEK_MS = 7 * 86_400_000;

/** The reports that ended failed in the seven days before `now`. A report with no readable end time is not counted. */
export function failedLastWeek(reports: ReadonlyArray<{ outcome: string; endedAt: string }>, now: number): number {
  return reports.filter((r) => {
    const ended = Date.parse(r.endedAt);
    return r.outcome === 'failed' && Number.isFinite(ended) && ended <= now && now - ended < WEEK_MS;
  }).length;
}

/** The learning lines for the attention list; a count of 0 or an unreadable one (null) adds none. */
export function learningAttention(projectId: string, counts: { failedRuns: number | null; proposals: number | null }): LearningAttention[] {
  const href = `/iq/projects/${encodeURIComponent(projectId)}?tab=learning`;
  const out: LearningAttention[] = [];
  if (counts.failedRuns) out.push({ id: 'failed-runs', text: `${plural(counts.failedRuns, 'run')} failed in the last seven days`, href });
  if (counts.proposals) out.push({ id: 'proposals', text: `${plural(counts.proposals, 'runbook proposal')} awaiting review`, href });
  return out;
}

// ─── The whole tab ───────────────────────────────────────────────────────────

/** The /work read as the page holds it. */
export interface WorkRead {
  tree: WorkItemTree[] | null | undefined;
  error?: string | null;
  loading?: boolean;
}

export type OverviewModel =
  | { state: 'loading'; stats: OverviewStat[] }
  | { state: 'error'; stats: OverviewStat[]; error: string }
  | {
      state: 'ready';
      stats: OverviewStat[];
      /** Every story and bug — the Work tab's count. */
      workCount: number;
      /** Every blocked item still to do, in Work order — its length is the
       *  "Needs attention N" count. Empty when nothing is blocked. */
      attention: AttentionItem[];
      /** Up to three open items that are not already in attention. */
      upNext: UpNextRow[];
      /** "View all 11" → the Work tab; null when there is no work at all. */
      viewAll: { label: string; href: string } | null;
    };

export function buildOverview(project: ProjectDetail, work: WorkRead): OverviewModel {
  // A failed read wins over stale data: the tab must not render the last
  // good tree's "Nothing is blocked" under an error.
  if (work.error) return { state: 'error', stats: overviewStats(project, null), error: work.error };
  if (work.tree == null) return { state: 'loading', stats: overviewStats(project, null) };

  const tree = work.tree;
  const rows = workRows(tree, 'priority', '');
  const portraits = new Map(project.contributors.map(person => [person.personId, person.avatarUrl]));
  const portraitOf = (row: FlatWorkItem) => row.assigneeId ? portraits.get(row.assigneeId) ?? null : null;
  const attention = rows
    .filter((r) => isBlocked(r) && (r.status === 'open' || r.status === 'in_progress'))
    .map((r) => attentionOf(project.id, r, portraitOf(r)));
  const flagged = new Set(attention.map((a) => a.id));
  const upNext = rows
    .filter((r) => r.status === 'open' && !flagged.has(r.id))
    .slice(0, UP_NEXT_LIMIT)
    .map((r) => upNextOf(project.id, r, portraitOf(r)));
  const n = rows.length;
  return {
    state: 'ready',
    stats: overviewStats(project, tree),
    workCount: n,
    attention,
    upNext,
    viewAll: n > 0
      ? {
          label: `View all ${n}`,
          href: `/iq/projects/${encodeURIComponent(project.id)}?tab=work`,
        }
      : null,
  };
}

/** "Nora DaSilva · Owner   Layla Hassan, Eli Garcia · SMEs" as two groups;
 *  a group with nobody in it is left out. */
export function peopleGroups(project: ProjectDetail): Array<{ label: string; names: string[] }> {
  const groups: Array<{ label: string; names: string[] }> = [];
  if (project.ownerName) groups.push({ label: 'Owner', names: [project.ownerName] });
  const smes = project.contributors
    .filter((c) => (c.role ?? '').toLowerCase() === 'sme' && c.personId !== project.ownerId)
    .map((c) => c.name);
  if (smes.length > 0) groups.push({ label: smes.length === 1 ? 'SME' : 'SMEs', names: smes });
  return groups;
}
