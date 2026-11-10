// Pure derivations for the decision record pages. No React — testable under
// node:test like the other format modules.

import type { PublishedPage } from '../../lib/voice/pageContext';
import { dialogueRows } from './decisionDialogue.ts';
import type { DecideBody, DecisionDetail, DecisionInitiativeRow, DecisionParticipant, DecisionSummary } from './types';

export const DECISIONS_SOURCE = 'Decisions are read from the org graph';

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  escalated: 'Escalated',
  resolved: 'Decided',
  rejected: 'Rejected',
};

export const STATUS_TONE: Record<string, 'warning' | 'danger' | 'success' | 'neutral'> = {
  open: 'warning',
  escalated: 'danger',
  resolved: 'success',
  rejected: 'neutral',
};

const DAY_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A DATE column ('YYYY-MM-DD') as an instant: the start of that day, here, so
 * it reads as "9d ago" rather than falling through as raw text. Not noon UTC:
 * a same-day date read as noon is still to come every morning, and the record
 * said "Decided in 8h" (walk, 9 November). Anything else passes through.
 */
export function asInstant(value: string): string {
  const day = DAY_ONLY.exec(value);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).toISOString() : value;
}

const calendarDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * When a decision was made, for the list and the record: "3h ago" from an
 * instant; "today" for a bare date that is today (a day has no hour to count
 * from); otherwise the relative day. A decided date is never "in …": anything
 * the clock puts in the future (a bare date ahead of this zone, clock skew of
 * more than the "just now" window) renders as the date.
 */
export function decidedWhen(value: string, relative: (iso: string) => string, now: number = Date.now()): string {
  const iso = asInstant(value);
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return value;
  if (DAY_ONLY.test(value) && new Date(at).toDateString() === new Date(now).toDateString()) return 'today';
  if (at > now) return calendarDay(iso);
  const said = relative(iso);
  return said.startsWith('in ') ? calendarDay(iso) : said;
}

/** The table's date: "today", else "Nov 2" (with the year only when it is not this one). The record page says the rest. */
export function decidedShort(value: string, now: number = Date.now()): string {
  const at = Date.parse(asInstant(value));
  if (!Number.isFinite(at)) return value;
  if (new Date(at).toDateString() === new Date(now).toDateString()) return 'today';
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: '2-digit' });
}

export const statusLabel = (status: string): string => STATUS_LABEL[status] ?? status;

/** Waiting decisions first (escalated, then open), then the settled ones, newest first. */
const ORDER: Record<string, number> = { escalated: 0, open: 1, resolved: 2, rejected: 3 };
export function sortDecisions<T extends { status: string; decidedAt: string | null; topic: string }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) =>
    (ORDER[a.status] ?? 4) - (ORDER[b.status] ?? 4)
    || (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')
    || a.topic.localeCompare(b.topic));
}

export function filterDecisions<T extends { status: string }>(rows: readonly T[], status: string): T[] {
  if (status === 'all') return rows.slice();
  if (status === 'waiting') return rows.filter((r) => r.status === 'open' || r.status === 'escalated');
  return rows.filter((r) => r.status === status);
}

export function matchesDecision(
  row: Pick<DecisionSummary, 'id' | 'topic' | 'summary'> & { outcome?: string | null }, query: string, initiativeName?: string | null,
): boolean {
  const q = query.trim().toLowerCase();
  return !q || [row.id, row.topic, row.summary ?? '', row.outcome ?? '', initiativeName ?? ''].some((f) => f.toLowerCase().includes(q));
}

export const decider = (people: readonly DecisionParticipant[]): DecisionParticipant | null =>
  people.find((p) => (p.role ?? '').toLowerCase() === 'decider') ?? null;

export const contributors = (people: readonly DecisionParticipant[]): DecisionParticipant[] =>
  people.filter((p) => (p.role ?? '').toLowerCase() !== 'decider');

/**
 * One line on where the decision stands, for the record's header. A settled
 * one says when, not who: the record names who decided once, on its Decided
 * line (`decidedLine`), so `deciderName` is only the waiting forms' decider.
 */
export function standingLine(d: Pick<DecisionDetail, 'status' | 'decidedAt'> & { escalatedAt?: string | null; requiredRole?: string | null },
  deciderName: string | null, relative: (iso: string) => string): string {
  if (d.status === 'resolved' || d.status === 'rejected') {
    return `${d.status === 'resolved' ? 'Decided' : 'Rejected'}${d.decidedAt ? ` ${decidedWhen(d.decidedAt, relative)}` : ''}`;
  }
  if (d.status === 'escalated') {
    const to = deciderName ?? (d.requiredRole ? `the ${d.requiredRole}` : 'its decider');
    return `Waiting on ${to}${d.escalatedAt ? `, escalated ${relative(d.escalatedAt)}` : ''}`;
  }
  return deciderName ? `Open — ${deciderName} decides` : 'Open';
}

export interface HistoryEvent { id: string; at: string | null; label: string; detail: string }

/** One row of the record's held-up work: "Holding up", "Unblocked" or "Still blocked", the item and its link. */
export interface HeldWorkRow { id: string; label: 'Holding up' | 'Unblocked' | 'Still blocked' | 'Linked work'; title: string; href: string }

/**
 * The work the record lists beside the decision: the server's `heldWork`
 * (deciding settles it: "Unblocked" once resolved, "Still blocked" when
 * rejected, "Holding up" while it waits). Without it, the initiative row's
 * linked work item, labelled for what the record can know.
 */
export function heldWorkRows(d: Pick<DecisionDetail, 'status' | 'projectId' | 'heldWork'>, row: DecisionInitiativeRow | null): HeldWorkRow[] {
  const href = (projectId: string, itemId: string) =>
    `/iq/projects/${encodeURIComponent(projectId)}?${new URLSearchParams({ tab: 'work', item: itemId }).toString()}`;
  if (d.heldWork && d.heldWork.length > 0) {
    return d.heldWork.map((w) => ({
      id: w.id, title: w.title, href: href(w.projectId, w.id),
      label: isWaiting(d.status) ? 'Holding up' : w.blocked ? 'Still blocked' : 'Unblocked',
    }));
  }
  if (row?.workItemId && row.workItemTitle && d.projectId) {
    return [{ id: row.workItemId, title: row.workItemTitle, href: href(d.projectId, row.workItemId), label: isWaiting(d.status) ? 'Holding up' : 'Linked work' }];
  }
  return [];
}

/**
 * The record's history, newest first: the calls recorded in the product
 * (`history`, G54: who, when and why), then what the table's columns say.
 * A recorded call replaces the column-derived "Decided" line, which could only
 * name the assigned decider, not who actually made it.
 */
export function historyOf(
  d: DecisionDetail, row: DecisionInitiativeRow | null, projectName: string | null,
): HistoryEvent[] {
  const who = decider(d.participants)?.name ?? null;
  // Who made a recorded call is on the record's Decided line; the history keeps what was said.
  const events: HistoryEvent[] = (d.history ?? []).map((e) => ({
    id: `event-${e.id}`, at: e.at,
    label: e.kind === 'resolved' ? 'Decided' : 'Rejected',
    detail: e.rationale,
  }));
  // Deciding it settled the work it held up, at the same moment as the call.
  const at = d.history?.[0]?.at ?? d.decidedAt;
  const unblocked = d.status === 'resolved' ? (d.heldWork ?? []).filter((w) => !w.blocked) : [];
  events.unshift(...unblocked.map((w) => ({ id: `unblocked-${w.id}`, at, label: 'Unblocked', detail: w.title })));
  if ((d.status === 'resolved' || d.status === 'rejected') && events.length === 0) {
    events.push({
      id: 'settled', at: d.decidedAt,
      label: d.status === 'resolved' ? 'Decided' : 'Rejected',
      // Who is the Decided line's to say (and with no recorded call, only the assigned decider is known).
      detail: 'The call was made.',
    });
  }
  if (row?.escalatedAt) {
    events.push({
      id: 'escalated', at: row.escalatedAt, label: 'Escalated',
      detail: row.requiredRole ? `Sent up to the ${row.requiredRole}${who ? `, ${who}` : ''}.` : 'Sent up to a decider.',
    });
  }
  events.push({
    id: 'raised', at: null, label: 'Raised',
    detail: projectName ? `Raised against ${projectName}.` : 'Raised as an organisation-wide call.',
  });
  return events;
}

// ─── Deciding (G54) ─────────────────────────────────────────────────────────

/** The longest rationale the route keeps (routes/decisions.ts RATIONALE_MAX). */
export const RATIONALE_MAX = 500;

export const isWaiting = (status: string): boolean => status === 'open' || status === 'escalated';

/**
 * Whether the record draws its Decide control: the session holds
 * DecideDecision, the decision is still waiting, and the server did not say
 * this viewer is someone the write would refuse (not the decider, not the
 * initiative's owner, not an org-leader). Presentation only: the route decides.
 */
export function showDecideControl(
  d: Pick<DecisionDetail, 'status' | 'viewerMayDecide'>, can: (action: 'DecideDecision') => boolean,
): boolean {
  return can('DecideDecision') && isWaiting(d.status) && d.viewerMayDecide !== false;
}

/** The first word of a display name, for "Only Nina, the initiative's owner…". */
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/**
 * The Waiting section for a decision that waits on someone else: the decider
 * named (or "an unassigned decider"), who may decide it, and the decider's
 * person id for a link. Null once settled. Presentation only.
 */
export function waitingNotice(d: Pick<DecisionDetail, 'status' | 'participants'>): { line: string; name: string | null; personId: string | null } | null {
  if (!isWaiting(d.status)) return null;
  const who = decider(d.participants);
  if (!who) return { line: 'Waiting on an unassigned decider. Only the initiative’s owner or an org-leader can decide this.', name: null, personId: null };
  return {
    line: `Waiting on ${who.name}. Only ${firstName(who.name)}, the initiative’s owner or an org-leader can decide this.`,
    name: who.name, personId: who.personId,
  };
}

/** The body the control sends, or why it cannot be sent yet. */
export function decideBody(outcome: DecideBody['outcome'], rationale: string): { body: DecideBody } | { error: string } {
  const text = rationale.trim();
  if (!text) return { error: 'Write what was decided and why.' };
  if (text.length > RATIONALE_MAX) return { error: `Keep it to ${RATIONALE_MAX} characters (${text.length} now).` };
  return { body: { outcome, rationale: text } };
}

/**
 * The record's outcome for a settled decision, under "The decision": what was
 * decided, alone. When and by whom are the Decided line's (`decidedLine`) —
 * the record says "by" once. Null while it waits, or when nothing says what
 * was decided.
 */
export function outcomeLine(d: Pick<DecisionDetail, 'status' | 'outcome'>): string | null {
  if (isWaiting(d.status) || !d.outcome) return null;
  return d.outcome;
}

/**
 * The record's one Decided line (its key-value row): "<when> by <who>", each
 * part only when the record has it; null while it waits. The only place the
 * record names who made the call.
 */
export function decidedLine(
  d: Pick<DecisionDetail, 'status' | 'decidedAt' | 'decidedBy'>, relative: (iso: string) => string,
): string | null {
  if (isWaiting(d.status)) return null;
  const when = d.decidedAt ? decidedWhen(d.decidedAt, relative) : null;
  const who = d.decidedBy?.name ? `by ${d.decidedBy.name}` : null;
  return [when, who].filter(Boolean).join(' ') || null;
}

/** A settled row's outcome, first line only, for the list; null while it waits. */
export function outcomeFirstLine(d: Pick<DecisionSummary, 'status' | 'outcome'>): string | null {
  if (isWaiting(d.status) || !d.outcome) return null;
  const first = d.outcome.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return first ?? null;
}

/**
 * What the record publishes for the voice (lib/voice/pageContext.ts): the
 * decision as the record in view and as the page's one row (so `decide` with
 * scope "this-page" names it), and, when the viewer may decide it, the offer
 * and the decision dialogue's numbered rows (G57: "decide 2", "go with the
 * riskiest first" name one; decisionDialogue.ts numbers them the same way).
 */
export function decisionPageContext(
  d: Pick<DecisionDetail, 'id' | 'topic' | 'status'> & Partial<Pick<DecisionDetail, 'participants' | 'options'>>, path: string, mayDecide: boolean,
): PublishedPage {
  // A waiting decision this viewer cannot decide: say who it waits on, never the decide offer.
  const waiting = !mayDecide && d.participants ? waitingNotice({ status: d.status, participants: d.participants }) : null;
  const waitingOffer = waiting?.name
    ? `This decision waits on ${waiting.name}; you cannot decide it. Say message ${waiting.name} to ask about it.`
    : waiting ? 'This decision waits on an unassigned decider; you cannot decide it.' : null;
  const ref = `decision:${d.id}`;
  const dialogue = mayDecide && isWaiting(d.status);
  return {
    path,
    record: { ref, title: d.topic },
    rowsLabel: 'decision',
    rows: [{ ref, title: d.topic, status: d.status, href: `/iq/decisions/${encodeURIComponent(d.id)}` }],
    offer: mayDecide
      ? `This decision is waiting on you: say decide with an option's number or label to resolve it (decide ref ${ref}, scope this-page, option; any why as the note), or reject it with why.`
      : waitingOffer,
    ...(dialogue ? { choices: dialogueRows(d.options).map((r) => r.label) } : {}),
  };
}
