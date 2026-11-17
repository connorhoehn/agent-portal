// Assigning a round and answering a seat on the portal side (docs/interviews-tenant-plan.md row I1.4): the three
// writes and the pure helpers the pages share. The server checks everything (middleware lib/interviews/assign.ts)
// and answers each problem as one sentence on a field (`leadId`, `panelIds.1`, `reason`); the form shows it there.

import { INTERVIEWS_API, type InterviewRow, type InterviewState, type PersonRef } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export interface FieldProblem { path: string; message: string }

/** What the assign form sends. */
export interface Seating { leadId: string; panelIds: string[] }
export interface AssignRequest extends Seating { applicationId: string; roundId: string }

/** A decline's reason, in characters (the server's floor and ceiling). */
export const REASON_MIN = 10;
export const REASON_MAX = 500;
/** Panel members besides the lead (decision 20). */
export const PANEL_SEATS = 2;

/** Who sits on a round may change until the call starts. */
const REASSIGNABLE: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'declined']);
export const canReassign = (state: InterviewState): boolean => REASSIGNABLE.has(state);

export type WriteOutcome =
  | { ok: true; interview: InterviewRow | null }
  | { ok: false; error: string; fields: FieldProblem[]; stale: boolean; interview: InterviewRow | null };

async function send(path: string, method: 'POST' | 'PUT', body: unknown, fallback: string): Promise<WriteOutcome> {
  const r = await writeJson<{ interview?: InterviewRow | null; fields?: FieldProblem[] }>(`${INTERVIEWS_API}${path}`, method, body);
  if (r.ok) return { ok: true, interview: r.data?.interview ?? null };
  return { ok: false, error: r.error ?? fallback, fields: r.data?.fields ?? [], stale: r.status === 409, interview: r.data?.interview ?? null };
}

export const assignRound = (req: AssignRequest): Promise<WriteOutcome> =>
  send('/interviews', 'POST', req, 'The round could not be assigned. Try again.');

export const acceptSeat = (id: string, revision: number): Promise<WriteOutcome> =>
  send(`/interviews/${encodeURIComponent(id)}/answer`, 'POST', { revision, answer: 'accept' }, 'Your answer could not be saved. Try again.');

export const declineSeat = (id: string, revision: number, reason: string): Promise<WriteOutcome> =>
  send(`/interviews/${encodeURIComponent(id)}/answer`, 'POST', { revision, answer: 'decline', reason }, 'Your answer could not be saved. Try again.');

export const reassignRound = (id: string, revision: number, seats: Seating): Promise<WriteOutcome> =>
  send(`/interviews/${encodeURIComponent(id)}/panel`, 'PUT', { revision, ...seats }, 'Nobody was reassigned. Try again.');

/** A decline's reason checked before it is sent: the same floor and ceiling as the server. */
export function reasonProblem(text: string): string | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length < REASON_MIN) return `Say why you are declining, in at least ${REASON_MIN} characters, so the recruiter can arrange someone else.`;
  if (t.length > REASON_MAX) return `Keep the reason under ${REASON_MAX} characters.`;
  return null;
}

/** "Wen Zhao declined the panel seat: …", the latest decline first. */
export function declineLines(row: Pick<InterviewRow, 'declines'>): string[] {
  return [...row.declines].sort((a, b) => b.at.localeCompare(a.at))
    .map((d) => `${d.person.name} declined ${d.seat === 'lead' ? 'to lead' : 'the panel seat'}: ${d.reason}`);
}

/** The form's seats, cleaned: the lead, then the chosen panel seats without blanks or repeats. */
export function seatingOf(leadId: string, panel: readonly string[]): Seating {
  return { leadId, panelIds: panel.filter((p, i) => p && p !== leadId && panel.indexOf(p) === i) };
}

/** The people a form may choose for a panel seat: everyone but the lead and the other seat's choice. */
export function panelChoices(people: readonly PersonRef[], leadId: string, otherSeat: string): PersonRef[] {
  return people.filter((p) => p.id !== leadId && p.id !== otherSeat);
}

/** A round's seats as the form starts them: the row's lead and panel, padded to the panel seats. */
export function seatsOfRow(row: Pick<InterviewRow, 'lead' | 'panel'> | null): { leadId: string; panel: string[] } {
  const panel = (row?.panel ?? []).map((p) => p.id);
  return { leadId: row?.lead.id ?? '', panel: [...panel, ...Array(Math.max(PANEL_SEATS - panel.length, 0)).fill('')].slice(0, PANEL_SEATS) };
}

/** The href that opens the assign form for an application, or the reassign form for a round. */
export const assignHref = (candidateId: string, q: { application: string } | { round: string }): string =>
  `/interviews/candidates/${encodeURIComponent(candidateId)}/assign?${'application' in q ? `application=${encodeURIComponent(q.application)}` : `round=${encodeURIComponent(q.round)}`}`;
