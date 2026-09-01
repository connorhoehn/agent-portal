// What agent work is worth suggesting to this person, right now.
//
// The Work page opened on an empty "Queue a job" box: a title field, a prompt
// field, and no connection to anything the person is actually working on.
// Dispatching an agent was therefore a blank page — you had to already know
// what to type, and nothing on the surface tied it to your initiatives, your
// sprint, or the work assigned to you. The queue is the point of the page and
// it was the least approachable thing on it.
//
// This answers the question the composer could not: given who you are and what
// you are on, here are three or four concrete things a computer could do next,
// each with the prompt already written.
//
// The ranking is deliberate and is the whole design:
//
//   1. blocked   — work that is waiting on something, because a stalled item
//                  costs more than an unstarted one
//   2. in-review — sitting in review is the most expensive place for work to
//                  sit; it is finished and not delivering
//   3. next-up   — the top of the sprint that has not been started
//
// Suggestions are a nudge, not a queue. Anything here can be ignored, and the
// composer still takes a free-typed prompt — the cards exist so the empty
// state is not the only way in.

import { type Session } from './session.js';
import { ORG_WIDE_INITIATIVE_ROLES } from './initiative-scope.js';

export type SuggestionKind = 'blocked' | 'in-review' | 'next-up' | 'maintenance';

export interface WorkSuggestion {
  id: string;
  kind: SuggestionKind;
  /** What to call it on the card. The work item's own title. */
  title: string;
  /** Why this is being suggested, in the user's terms — not the rule's. */
  reason: string;
  /** Ready to run. The composer is prefilled with this. */
  prompt: string;
  initiativeId: string;
  initiativeName: string;
  workItemId: string;
  /** Complexity and dollars, the two axes the operating model plans against. */
  storyPoints: number | null;
  estimatedCostUsd: number | null;
}

/** The subset of a work item this module needs. Keeps it testable in isolation. */
export interface SuggestibleItem {
  id: string;
  projectId: string;
  projectName: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeId: string | null;
  storyPoints: number | null;
  estimatedCostUsd: number | null;
  sprintId: string | null;
  updatedAt?: string | null;
  /** How "blocked" is actually carried — see kindOf. */
  labels?: readonly string[];
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3,
};

/** Rank within a kind: priority first, then bigger estimates — those stall longest. */
function withinKind(a: SuggestibleItem, b: SuggestibleItem): number {
  const p = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (p !== 0) return p;
  return (b.storyPoints ?? 0) - (a.storyPoints ?? 0);
}

const KIND_RANK: Record<SuggestionKind, number> = {
  blocked: 0, 'in-review': 1, 'next-up': 2, maintenance: 3,
};

/**
 * The prompt each kind gets.
 *
 * Written as instructions to an agent working in a checkout, not as a restated
 * title: "Investigate why X is blocked" is the difference between a card you
 * can run and a card you have to rewrite. The description is included when
 * there is one, because it is usually where the actual requirement lives.
 */
function promptFor(kind: SuggestionKind, item: SuggestibleItem): string {
  const context = item.description?.trim()
    ? `\n\nWhat the item says:\n${item.description.trim()}`
    : '';
  const where = `${item.projectName} · ${item.type} ${item.id}`;

  switch (kind) {
    case 'blocked':
      return `"${item.title}" (${where}) is blocked. Work out what it is waiting on — read the item, its parent, and any linked change requests, then check the repo for the code it touches. Report what is actually in the way and the smallest thing that would unblock it. Do not start the implementation.${context}`;
    case 'in-review':
      return `"${item.title}" (${where}) has been in review. Find the open change request or PR, read the diff and the review comments, and summarise what is left before it can merge — unresolved comments, failing checks, missing tests. If the fixes are mechanical, make them and push.${context}`;
    case 'next-up':
      return `Start "${item.title}" (${where}). Read the item and the surrounding code, then propose an approach before writing anything: which files change, what the tests look like, and anything in the item that is ambiguous. Wait for a reply before implementing.${context}`;
    case 'maintenance':
      return `"${item.title}" (${where}) is scheduled maintenance for this initiative. Run it, and report anything that looks different from the last run.${context}`;
  }
}

function reasonFor(kind: SuggestionKind, item: SuggestibleItem): string {
  switch (kind) {
    case 'blocked': return `Blocked on ${item.projectName}`;
    case 'in-review': return `Waiting in review on ${item.projectName}`;
    case 'next-up': return item.sprintId
      ? `Next up in this sprint on ${item.projectName}`
      : `Not started on ${item.projectName}`;
    case 'maintenance': return `Upkeep on ${item.projectName}`;
  }
}

/**
 * Which kind of suggestion an item is, or none.
 *
 * This has to speak the board's real vocabulary, and the first cut did not.
 * `work_items.status` is `open | in_progress | in_review | done | cancelled`
 * (schema/orgiq_work_items_schema.sql) — there is no `blocked` and no `todo`
 * in it, so a ranker written against those two names matched `in_review` and
 * nothing else. On an initiative with no open change request that is zero
 * cards, which is exactly what an SME saw: a suggestion strip that was empty
 * for reasons no one could see from the page.
 *
 * So: not-started is `open`, and blocked is carried as a **label**, because
 * the board has no status for it and inventing one would mean a migration,
 * a new transition matrix row, and a second way to say "in flight". A label
 * is what the seed already uses to annotate an item without moving it.
 *
 * `blocked`/`todo` stay accepted as statuses so a future board that grows
 * them keeps working, and so the policy reads as the policy rather than as a
 * mapping table for one storage decision.
 */
function kindOf(item: SuggestibleItem): SuggestionKind | null {
  if (item.status === 'done' || item.status === 'cancelled') return null;
  if (item.status === 'blocked' || item.labels?.includes('blocked')) return 'blocked';
  if (item.status === 'in_review') return 'in-review';
  if (item.status === 'open' || item.status === 'todo') return 'next-up';
  return null;
}

/**
 * Rank and shape suggestions. Pure — the caller does the fetching and the
 * scoping, so the policy is testable without a database.
 *
 * `limit` is small on purpose. A wall of suggestions is a backlog, and the
 * page already has one of those; the point here is the two or three things
 * worth doing next.
 */
export function rankSuggestions(
  items: readonly SuggestibleItem[],
  opts: { limit?: number; personId?: string | null } = {},
): WorkSuggestion[] {
  const limit = opts.limit ?? 4;
  const mine = opts.personId ?? null;

  const scored = items
    .map((item) => ({ item, kind: kindOf(item) }))
    .filter((x): x is { item: SuggestibleItem; kind: SuggestionKind } => x.kind !== null)
    .sort((a, b) => {
      // Work assigned to you outranks work merely on your initiatives — it is
      // yours either way, but one of them is waiting on you specifically.
      if (mine) {
        const am = a.item.assigneeId === mine ? 0 : 1;
        const bm = b.item.assigneeId === mine ? 0 : 1;
        if (am !== bm) return am - bm;
      }
      const k = KIND_RANK[a.kind] - KIND_RANK[b.kind];
      if (k !== 0) return k;
      return withinKind(a.item, b.item);
    });

  // One per initiative before a second from any: four cards all pointing at the
  // same project is a worse answer than four projects with one thing each.
  const seen = new Set<string>();
  const spread = [
    ...scored.filter(({ item }) => {
      if (seen.has(item.projectId)) return false;
      seen.add(item.projectId);
      return true;
    }),
    ...scored.filter(({ item }) => seen.has(item.projectId)),
  ];

  const out: WorkSuggestion[] = [];
  const used = new Set<string>();
  for (const { item, kind } of spread) {
    if (out.length >= limit) break;
    if (used.has(item.id)) continue;
    used.add(item.id);
    out.push({
      id: `sg-${item.id}`,
      kind,
      title: item.title,
      reason: reasonFor(kind, item),
      prompt: promptFor(kind, item),
      initiativeId: item.projectId,
      initiativeName: item.projectName,
      workItemId: item.id,
      storyPoints: item.storyPoints,
      estimatedCostUsd: item.estimatedCostUsd,
    });
  }
  return out;
}

/**
 * Whether this caller sees suggestions from every initiative or only theirs.
 *
 * Same split as everywhere else: the org-wide roles run the whole program, an
 * `sme` is scoped to what they own or contribute to.
 */
export function seesEveryInitiative(session: Session | null): boolean {
  const role = session?.role;
  return !!role && ORG_WIDE_INITIATIVE_ROLES.includes(role);
}
