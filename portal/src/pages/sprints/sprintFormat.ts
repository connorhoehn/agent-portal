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

/**
 * A sprint's window, in whole UTC days, INCLUSIVE of its end date: a sprint
 * that runs 30 Sep → 14 Oct is worked on the 14th too, so it closes at the
 * end of that day (midnight starting the 15th), not at its start. Reading the
 * end date as an instant made an active sprint on its last day show "Elapsed
 * 100%" beside "0 days left" — finished by the arithmetic while the team was
 * still working it. Every window figure on the sprint views comes from here.
 *
 * - `days`: the window's length (a one-day sprint has 1).
 * - `day`: which day of the window today is, 1-based and clamped to [0, days]
 *   (0 before it starts).
 * - `daysLeft`: whole days still to work, today included (1 on the last day,
 *   0 the day after; negative once it is further past).
 * - `progress`: the elapsed fraction of the window, 0–1, by the clock.
 */
export interface SprintWindow { days: number; day: number; daysLeft: number; progress: number }

function utcDay(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(`${iso}T00:00:00Z`).getTime();
  return Number.isNaN(t) ? null : t;
}

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function sprintWindow(s: Pick<Sprint, 'startsOn' | 'endsOn'>, now: number = Date.now()): SprintWindow | null {
  const start = utcDay(s.startsOn), end = utcDay(s.endsOn);
  if (start === null || end === null || end < start) return null;
  const close = end + DAY_MS; // exclusive: the end date is a working day
  const days = Math.round((close - start) / DAY_MS);
  const today = startOfUtcDay(now);
  const day = Math.min(days, Math.max(0, Math.round((today - start) / DAY_MS) + 1));
  return {
    days,
    day,
    daysLeft: Math.round((close - today) / DAY_MS),
    progress: Math.min(1, Math.max(0, (now - start) / (close - start))),
  };
}

/** How far through its own window a sprint is, 0–1 (end date inclusive). */
export function windowProgress(s: Sprint, now: number = Date.now()): number | null {
  return sprintWindow(s, now)?.progress ?? null;
}

export function dateRange(s: Sprint): string {
  return `${shortDate(s.startsOn)} → ${shortDate(s.endsOn)}`;
}

/** "3 days left" / "last day" / "2 days over" for a window ending on `iso`
 *  (inclusive — the end date is a working day), or null when there is no end
 *  date. `unit` picks the card's terse form (`d`) or the detail's long form. */
export function timeLeftLabel(iso: string | null, unit: 'short' | 'long' = 'long', now: number = Date.now()): string | null {
  const end = utcDay(iso);
  if (end === null) return null;
  const left = Math.round((end + DAY_MS - startOfUtcDay(now)) / DAY_MS);
  if (left === 1) return 'last day';
  const n = left > 0 ? left : 1 - left;
  const noun = unit === 'short' ? 'd' : n === 1 ? ' day' : ' days';
  return left > 0 ? `${n}${noun} left` : `${n}${noun} over`;
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
// ─── Board quick filters ─────────────────────────────────────────────────────

/** The board's quick filters (Jira's "Only my issues", "Recently updated"):
 *  toggled independently, combined with AND, kept in the URL as `?quick=`. */
export type QuickFilter = 'mine' | 'recent';
export const QUICK_FILTERS: { id: QuickFilter; label: string; title: string }[] = [
  { id: 'mine', label: 'Only my issues', title: 'Only work assigned to you' },
  { id: 'recent', label: 'Recently updated', title: 'Changed in the last 7 days' },
];
const RECENT_MS = 7 * DAY_MS;

/** `?quick=mine,recent` → the known ids, in a stable order; unknown ids dropped. */
export function parseQuickFilters(raw: string | null): QuickFilter[] {
  const wanted = new Set((raw ?? '').split(',').map((v) => v.trim()));
  return QUICK_FILTERS.map((f) => f.id).filter((id) => wanted.has(id));
}

/** The URL value, or null (no param) when nothing is on. */
export function serializeQuickFilters(active: readonly QuickFilter[]): string | null {
  return active.length ? parseQuickFilters(active.join(',')).join(',') : null;
}

export function applyQuickFilters(
  items: WorkItem[],
  active: readonly QuickFilter[],
  opts: { personId: string | null; now?: number },
): WorkItem[] {
  const now = opts.now ?? Date.now();
  return items.filter((i) => {
    // "Mine" with no linked person matches nothing rather than everything:
    // the filter cannot be resolved, and showing the whole board would claim
    // it was.
    if (active.includes('mine') && (!opts.personId || i.assigneeId !== opts.personId)) return false;
    if (active.includes('recent')) {
      const t = i.updatedAt ? Date.parse(i.updatedAt) : NaN;
      if (!Number.isFinite(t) || now - t > RECENT_MS) return false;
    }
    return true;
  });
}

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
