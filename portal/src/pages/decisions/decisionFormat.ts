// Pure derivations for the decision record pages. No React — testable under
// node:test like the other format modules.

import type { DecisionDetail, DecisionInitiativeRow, DecisionParticipant, DecisionSummary } from './types';

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

/** A DATE column ('YYYY-MM-DD') as an instant, so it reads as "9d ago" rather than falling through as raw text. */
export const asInstant = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);

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
  row: Pick<DecisionSummary, 'id' | 'topic' | 'summary'>, query: string, initiativeName?: string | null,
): boolean {
  const q = query.trim().toLowerCase();
  return !q || [row.id, row.topic, row.summary ?? '', initiativeName ?? ''].some((f) => f.toLowerCase().includes(q));
}

export const decider = (people: readonly DecisionParticipant[]): DecisionParticipant | null =>
  people.find((p) => (p.role ?? '').toLowerCase() === 'decider') ?? null;

export const contributors = (people: readonly DecisionParticipant[]): DecisionParticipant[] =>
  people.filter((p) => (p.role ?? '').toLowerCase() !== 'decider');

/** One line on where the decision stands, for the list rail's row and the record's header. */
export function standingLine(d: Pick<DecisionDetail, 'status' | 'decidedAt'> & { escalatedAt?: string | null; requiredRole?: string | null },
  deciderName: string | null, relative: (iso: string) => string): string {
  if (d.status === 'resolved' || d.status === 'rejected') {
    const who = deciderName ? ` by ${deciderName}` : '';
    return `${d.status === 'resolved' ? 'Decided' : 'Rejected'}${who}${d.decidedAt ? ` ${relative(asInstant(d.decidedAt))}` : ''}`;
  }
  if (d.status === 'escalated') {
    const to = deciderName ?? (d.requiredRole ? `the ${d.requiredRole}` : 'its decider');
    return `Waiting on ${to}${d.escalatedAt ? `, escalated ${relative(d.escalatedAt)}` : ''}`;
  }
  return deciderName ? `Open — ${deciderName} decides` : 'Open';
}

export interface HistoryEvent { id: string; at: string | null; label: string; detail: string }

/** The record's history, newest first, from the columns the table keeps. */
export function historyOf(
  d: DecisionDetail, row: DecisionInitiativeRow | null, projectName: string | null,
): HistoryEvent[] {
  const who = decider(d.participants)?.name ?? null;
  const events: HistoryEvent[] = [];
  if (d.status === 'resolved' || d.status === 'rejected') {
    events.push({
      id: 'settled', at: d.decidedAt,
      label: d.status === 'resolved' ? 'Decided' : 'Rejected',
      detail: who ? `${who} made the call.` : 'The call was made.',
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
