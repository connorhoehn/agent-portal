// The initiative Overview tab's model (mockup variant 1): the stat strip,
// "What needs attention" and "Plan next". No React; unit-tested alone.
//
// Everything is read off rows the page already fetched — the project detail
// and its /work tree. The ordering is the Work list's own "By priority" order
// (workRows(tree, 'priority', '')) so "Plan next" is exactly the top of the
// list that "See all N work items" opens, not a second ranking (D2).
//
// Honest numbers: a count is the length of rows we hold; a rollup the server
// could not produce (null) renders as unknown, never as 0; and a failed /work
// read is its own state, never the "Nothing is blocked" copy.

import { sumForestPoints, type FlatWorkItem } from './projectFormat.ts';
import { isBlocked, workRows } from './workListModel.ts';
import type { ProjectDetail, WorkItemTree } from './types';

/** Dollars as the header writes them: whole amounts without cents ("$95"),
 *  anything else to the cent ("$1.73"). */
export function money(n: number): string {
  if (Number.isInteger(n)) return `$${n.toLocaleString('en-US')}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** "5 points", "1 point". */
export function pointsLabel(n: number): string {
  return `${n} ${plural(n, 'point')}`;
}

/** First name for prose ("what Eli needs"); null when there is no name. */
export function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

// ─── Stat strip ──────────────────────────────────────────────────────────────

/** One cell of the inline stat strip: a bold value, then its label. */
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
  return { id: 'points', value: String(done), label: `/ ${total} points delivered`, progress: Math.min(1, done / total) };
}

function agentsStat(runs: number | null | undefined): OverviewStat {
  if (runs == null) return { id: 'agents', value: '—', label: 'agents running', muted: true };
  return { id: 'agents', value: String(runs), label: `${plural(runs, 'agent')} running`, muted: runs === 0 };
}

function spendStat(spent: number | null | undefined, allocated: number | null | undefined): OverviewStat {
  if (spent == null) return { id: 'spend', value: '—', label: 'spent', muted: true };
  const label = allocated != null && allocated > 0 ? `spent of ${money(allocated)} allocated` : 'spent · no allocation';
  return { id: 'spend', value: money(spent), label };
}

/** The three cells: points delivered, agents running, spent of allocated.
 *  `tree` is null when /work has not loaded or failed. */
export function overviewStats(project: ProjectDetail, tree: WorkItemTree[] | null): OverviewStat[] {
  return [
    pointsStat(tree),
    agentsStat(project.activeAgentRuns),
    spendStat(project.agentSpendUsd, project.allocatedUsd),
  ];
}

/** The condensed header line on the Work tab: "18 / 52 points delivered · $1.73 spent".
 *  Parts the page cannot know are left out, not zeroed. */
export function headerStatsLine(project: ProjectDetail, tree: WorkItemTree[] | null): string | null {
  const parts: string[] = [];
  if (tree != null) {
    const { done, total } = sumForestPoints(tree);
    if (total > 0) parts.push(`${done} / ${total} points delivered`);
  }
  if (project.agentSpendUsd != null) parts.push(`${money(project.agentSpendUsd)} spent`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

// ─── What needs attention ────────────────────────────────────────────────────

export interface AttentionMetaPart {
  label: string;
  /** `warning` paints the "Blocked" word; plain parts carry no tone. */
  tone?: 'warning';
}

export interface AttentionItem {
  id: string;
  title: string;
  /** summary + blocked reason, from the row; the description when neither was written. */
  body: string | null;
  /** "Blocked · Eli Garcia · 2 points". */
  meta: AttentionMetaPart[];
  actionLabel: string;
  /** Opens the item on the Work tab. */
  href: string;
}

export const ATTENTION_NONE = 'Nothing is blocked.';

/** Work-tab deep link for one item. */
export function workItemHref(projectId: string, itemId: string): string {
  return `/iq/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ tab: 'work', item: itemId }).toString()}`;
}

function attentionOf(projectId: string, row: FlatWorkItem): AttentionItem {
  const reason = [row.summary, row.blockedReason].map((s) => s?.trim()).filter(Boolean).join(' ');
  const meta: AttentionMetaPart[] = [{ label: 'Blocked', tone: 'warning' }];
  if (row.assigneeName) meta.push({ label: row.assigneeName });
  if (row.storyPoints != null) meta.push({ label: pointsLabel(row.storyPoints) });
  return {
    id: row.id,
    title: row.title,
    body: reason || row.description?.trim() || null,
    meta,
    actionLabel: 'Open work',
    href: workItemHref(projectId, row.id),
  };
}

// ─── Plan next ───────────────────────────────────────────────────────────────

export interface PlanNextRow {
  id: string;
  title: string;
  /** The row's one-sentence summary; null when none was written (no invented copy). */
  description: string | null;
  /** "Layla Hassan · 5 points". */
  meta: string;
  href: string;
}

function planNextOf(projectId: string, row: FlatWorkItem): PlanNextRow {
  const meta = [row.assigneeName ?? 'Unassigned'];
  if (row.storyPoints != null) meta.push(pointsLabel(row.storyPoints));
  return {
    id: row.id,
    title: row.title,
    description: row.summary?.trim() || null,
    meta: meta.join(' · '),
    href: workItemHref(projectId, row.id),
  };
}

export const PLAN_NEXT_LIMIT = 3;

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
      /** The first blocked item still to do, in Work order; null when nothing is blocked. */
      attention: AttentionItem | null;
      /** Up to three Next-up items after the attention item. */
      planNext: PlanNextRow[];
      /** "See all 11 work items"; null when there is no work at all. */
      seeAll: { label: string; href: string } | null;
    };

export function buildOverview(project: ProjectDetail, work: WorkRead): OverviewModel {
  // A failed read wins over stale data: the tab must not render the last
  // good tree's "Nothing is blocked" under an error.
  if (work.error) return { state: 'error', stats: overviewStats(project, null), error: work.error };
  if (work.tree == null) return { state: 'loading', stats: overviewStats(project, null) };

  const tree = work.tree;
  const rows = workRows(tree, 'priority', '');
  const blocked = rows.find((r) => isBlocked(r) && (r.status === 'open' || r.status === 'in_progress'));
  const attention = blocked ? attentionOf(project.id, blocked) : null;
  const planNext = rows
    .filter((r) => r.status === 'open' && r.id !== attention?.id)
    .slice(0, PLAN_NEXT_LIMIT)
    .map((r) => planNextOf(project.id, r));
  const n = rows.length;
  return {
    state: 'ready',
    stats: overviewStats(project, tree),
    workCount: n,
    attention,
    planNext,
    seeAll: n > 0
      ? {
          label: n === 1 ? 'See 1 work item' : `See all ${n} work items`,
          href: `/iq/projects/${encodeURIComponent(project.id)}?tab=work`,
        }
      : null,
  };
}

/** The "How to move this forward" sentence. */
export const MOVE_FORWARD_TITLE = 'How to move this forward';
export const MOVE_FORWARD_BODY = 'Open a work item to refine its brief, discuss tradeoffs, or review an agent run.';

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
