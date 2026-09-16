// Pure derivations behind the sprint views: money and date formatting, window
// arithmetic, board column bucketing, the "why is this sprint mine" reasons,
// the cross-sprint rollup, and the option lists for the two people pickers.
//
// Same rule as sprintForm.ts, and for the same reason: none of this needs a
// DOM, so keeping it out of the .tsx makes it testable under `node --test` and
// keeps the components down to markup. Everything here was previously inlined
// in SprintsPage.tsx, where the rollup reducer and the option-grouping logic
// sat in the middle of JSX.

import type { Contributor, RosterPerson, Sprint, WorkItem, WorkTreeNode } from './types';

// ─── Money and dates ─────────────────────────────────────────────────────────

// Promoted to lib/format.ts — the app-wide canonical `usd`. Re-exported here
// so existing `from './sprintFormat'` imports keep working.
export { usd } from '../../lib/format.ts';

/** `2026-08-24` → `24 Aug`. Sprint dates are DATEs, so they are parsed as UTC
 *  and formatted in UTC — reading them locally shifts a sprint boundary by a
 *  day for anyone west of Greenwich. */
export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const DAY_MS = 86_400_000;

/** Whole days from today to `iso` (negative once it has passed). */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const end = new Date(`${iso}T00:00:00Z`).getTime();
  if (Number.isNaN(end)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((end - todayUtc) / DAY_MS);
}

/** How far through its own window a sprint is, 0–1. */
export function windowProgress(s: Sprint): number | null {
  if (!s.startsOn || !s.endsOn) return null;
  const start = new Date(`${s.startsOn}T00:00:00Z`).getTime();
  const end = new Date(`${s.endsOn}T00:00:00Z`).getTime();
  if (!(end > start)) return null;
  return Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
}

export function dateRange(s: Sprint): string {
  return `${shortDate(s.startsOn)} → ${shortDate(s.endsOn)}`;
}

/** "3 days left" / "2 days over", or null when there is no end date. `unit`
 *  picks the card's terse form (`d`) or the detail's long form. */
export function timeLeftLabel(iso: string | null, unit: 'short' | 'long' = 'long'): string | null {
  const left = daysUntil(iso);
  if (left === null) return null;
  const n = Math.abs(left);
  const noun = unit === 'short' ? 'd' : n === 1 ? ' day' : ' days';
  return left >= 0 ? `${n}${noun} left` : `${n}${noun} over`;
}

// ─── Tones ───────────────────────────────────────────────────────────────────

export const STATUS_TONE: Record<string, 'success' | 'info' | 'neutral'> = {
  active: 'success',
  planned: 'info',
  done: 'neutral',
};

export const PRIORITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  high: 'warning',
};

/** True when the initiative outspent the sprint's envelope inside its window.
 *  Only meaningful once an envelope exists — with no grant there is nothing to
 *  be over. */
export function isOverEnvelope(s: Sprint): boolean {
  return s.grantCount > 0 && s.initiativeSpendInWindowUsd > s.grantedUsd;
}

// ─── Health ──────────────────────────────────────────────────────────────────

export interface SprintHealth {
  key: 'over_envelope' | 'off_track' | 'at_risk' | 'on_track';
  label: string;
  tone: 'danger' | 'warning' | 'success';
}

/**
 * The one judgment the page used to make the reader compute themselves: an
 * active sprint at 100% elapsed with 0/26 points is not "0%", it is off track.
 *
 * Time-vs-delivery, judged only for ACTIVE sprints (a planned sprint has no
 * clock; a done one is history): money first — outspending the envelope is
 * red regardless of points — then the gap between window elapsed and points
 * delivered. Null when there is nothing to judge (no window, nothing
 * estimated).
 */
export function sprintHealth(s: Sprint): SprintHealth | null {
  if (s.status !== 'active') return null;
  if (isOverEnvelope(s)) return { key: 'over_envelope', label: 'Over envelope', tone: 'danger' };
  const w = windowProgress(s);
  if (w == null || s.pointsTotal <= 0) return null;
  const gap = w - s.pointsDone / s.pointsTotal;
  if (gap > 0.5) return { key: 'off_track', label: 'Off track', tone: 'danger' };
  if (gap > 0.25) return { key: 'at_risk', label: 'At risk', tone: 'warning' };
  return { key: 'on_track', label: 'On track', tone: 'success' };
}

/** How many of the loaded sprints need attention — the KPI strip's alarm. */
export function atRiskCount(sprints: Sprint[]): number {
  return sprints.filter((s) => {
    const h = sprintHealth(s);
    return h != null && h.key !== 'on_track';
  }).length;
}

// ─── Why this sprint is yours ────────────────────────────────────────────────

export interface MineReason { key: string; label: string; tone: 'accent' | 'info' }

/** "Mine" is not "mine to steward": a sprint is yours when you steward it,
 *  hold its envelope, OR have work in it — and the card has to say which,
 *  because all three read the same otherwise. */
export function mineReasons(s: Sprint): MineReason[] {
  const out: MineReason[] = [];
  if (s.isSteward) out.push({ key: 'steward', label: 'You steward this', tone: 'accent' });
  if (s.isGrantee) out.push({ key: 'grantee', label: 'Your envelope', tone: 'accent' });
  if (s.myItemCount > 0) {
    out.push({
      key: 'items',
      label: s.myOpenItemCount > 0
        ? `${s.myOpenItemCount} open of ${s.myItemCount} yours`
        : `${s.myItemCount} yours, all done`,
      tone: 'info',
    });
  }
  return out;
}

// ─── Cross-sprint rollup ─────────────────────────────────────────────────────

export interface SprintTotals {
  granted: number;
  spend: number;
  myOpen: number;
  pointsDone: number;
  pointsTotal: number;
}

/** Sums only the sprints currently loaded — under the default active-only
 *  filter that is an active-sprint subtotal, not an org-wide figure, which is
 *  what the tiles' hints have to say. */
export function sprintTotals(sprints: Sprint[]): SprintTotals {
  return sprints.reduce<SprintTotals>((acc, s) => ({
    granted: acc.granted + s.grantedUsd,
    spend: acc.spend + s.initiativeSpendInWindowUsd,
    myOpen: acc.myOpen + s.myOpenItemCount,
    pointsDone: acc.pointsDone + s.pointsDone,
    pointsTotal: acc.pointsTotal + s.pointsTotal,
  }), { granted: 0, spend: 0, myOpen: 0, pointsDone: 0, pointsTotal: 0 });
}

// ─── Board ───────────────────────────────────────────────────────────────────

// Board columns, in the order work moves through them. 'cancelled' is rendered
// only when something is actually in it — an always-present empty column reads
// as a stage of the process rather than an exception.
export const BOARD_COLUMNS: Array<{ status: string; label: string }> = [
  { status: 'open', label: 'Open' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'in_review', label: 'In review' },
  { status: 'done', label: 'Done' },
  { status: 'cancelled', label: 'Cancelled' },
];

// Items that have left the board — adding them to a sprint would fold closed
// work into its point/cost totals, so the picker omits them.
export const TERMINAL_STATUSES = new Set(['done', 'cancelled']);

export interface BoardColumn { status: string; label: string; items: WorkItem[] }

export function bucketByColumn(items: WorkItem[]): BoardColumn[] {
  return BOARD_COLUMNS
    .map((c) => ({ ...c, items: items.filter((i) => i.status === c.status) }))
    .filter((c) => c.status !== 'cancelled' || c.items.length > 0);
}

/** Flatten /api/graph/projects/:id/work into a flat list. */
export function flattenTree(nodes: WorkTreeNode[]): WorkTreeNode[] {
  const out: WorkTreeNode[] = [];
  const walk = (n: WorkTreeNode) => { out.push(n); (n.children ?? []).forEach(walk); };
  nodes.forEach(walk);
  return out;
}

/** Items in the initiative that could still be moved INTO this sprint:
 *  not already here, not an epic (epics are containers, not sprint work), and
 *  not already closed. */
export function addableItems(tree: WorkTreeNode[], presentIds: Set<string>): WorkTreeNode[] {
  return flattenTree(tree).filter(
    (n) => !presentIds.has(n.id) && n.type !== 'epic' && !TERMINAL_STATUSES.has(n.status ?? ''),
  );
}

// ─── People pickers ──────────────────────────────────────────────────────────

export interface PeopleGroup { label: string; options: Array<{ value: string; label: string }> }

/**
 * Option groups for a steward/grantee picker: the initiative's own contributors
 * first (labelled with their role), then everyone else from the roster. This is
 * the RM-5 fix — anyone the backend accepts is selectable, with the common case
 * (this initiative's people) prioritised. Returns an empty array when there is
 * nobody yet, which the caller renders as a placeholder.
 */
export function peopleGroups(contributors: Contributor[], roster: RosterPerson[]): PeopleGroup[] {
  const contribIds = new Set(contributors.map((c) => c.personId));
  const others = roster.filter((p) => !contribIds.has(p.id));
  const groups: PeopleGroup[] = [];
  if (contributors.length > 0) {
    groups.push({
      label: 'On this initiative',
      options: contributors.map((c) => ({
        value: c.personId,
        label: c.role ? `${c.name} · ${c.role}` : c.name,
      })),
    });
  }
  if (others.length > 0) {
    groups.push({
      label: contributors.length > 0 ? 'Everyone else' : 'People',
      options: others.map((p) => ({ value: p.id, label: p.isSme ? `${p.name} · SME` : p.name })),
    });
  }
  return groups;
}
