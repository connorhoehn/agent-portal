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

/**
 * The notice an Accept waits for (decision 5, its last sentence): the candidate's own notice, its version and title,
 * its paragraphs separated by a blank line, and the one sentence that it applies to the panel too.
 */
export interface PanelNotice { version: string; title: string; text: string; panelLine: string }

/**
 * A seat already booked on another round at an overlapping time (middleware lib/interviews/conflicts.ts, ledger row C-17):
 * a warning, never a refusal. Who, and the other round's id and window; never its candidate.
 */
export interface SeatConflict { person: PersonRef; interviewId: string; scheduledAt: string; minutes: number }

export type WriteOutcome =
  | { ok: true; interview: InterviewRow | null; conflicts: SeatConflict[] }
  | { ok: false; error: string; fields: FieldProblem[]; stale: boolean; interview: InterviewRow | null; needsNotice?: PanelNotice };

async function send(path: string, method: 'POST' | 'PUT', body: unknown, fallback: string): Promise<WriteOutcome> {
  const r = await writeJson<{ interview?: InterviewRow | null; fields?: FieldProblem[]; needsNotice?: PanelNotice; conflicts?: SeatConflict[] }>(`${INTERVIEWS_API}${path}`, method, body);
  if (r.ok) return { ok: true, interview: r.data?.interview ?? null, conflicts: r.data?.conflicts ?? [] };
  const needsNotice = r.data?.needsNotice;
  // A 409 that asks for the notice is not a stale page: nothing changed, the person reads and accepts.
  return { ok: false, error: r.error ?? fallback, fields: r.data?.fields ?? [], stale: r.status === 409 && !needsNotice, interview: r.data?.interview ?? null, ...(needsNotice ? { needsNotice } : {}) };
}

export const assignRound = (req: AssignRequest): Promise<WriteOutcome> =>
  send('/interviews', 'POST', req, 'The round could not be assigned. Try again.');

export const acceptSeat = (id: string, revision: number): Promise<WriteOutcome> =>
  send(`/interviews/${encodeURIComponent(id)}/answer`, 'POST', { revision, answer: 'accept' }, 'Your answer could not be saved. Try again.');

/** Acknowledge the panel's notice (the version the page showed) for the signed-in person, on the way to accepting `id`. */
export async function acknowledgePanelNotice(id: string, version: string): Promise<{ ok: true } | { ok: false; error: string; needsNotice?: PanelNotice }> {
  const r = await writeJson<{ needsNotice?: PanelNotice }>(`${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}/panel-notice`, 'POST', { version });
  if (r.ok) return { ok: true };
  return { ok: false, error: r.error ?? 'Your answer could not be saved. Try again.', ...(r.data?.needsNotice ? { needsNotice: r.data.needsNotice } : {}) };
}

/** The notice's paragraphs, as the server separates them. */
export const noticeParagraphs = (text: string): string[] => text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** The panel notice prompt's two answers. */
export const NOTICE_READ = 'read-accept';
export const NOTICE_LATER = 'not-now';

/**
 * What the panel notice prompt does with an answer: "I have read it — accept" acknowledges the version shown, then
 * accepts, with one receipt; "Not now" changes nothing. A changed notice comes back as `renotice` so the page shows the
 * new one. Pure over the two writes, so the page and its test share it.
 */
export async function answerPanelNotice(
  optionId: string, notice: PanelNotice,
  writes: { acknowledge: (version: string) => Promise<{ ok: true } | { ok: false; error: string; needsNotice?: PanelNotice }>; accept: () => Promise<WriteOutcome> },
): Promise<{ receipt: string; accepted: boolean } | { error: string; renotice?: PanelNotice }> {
  if (optionId !== NOTICE_READ) return { receipt: 'Not accepted yet. The round stays waiting for your answer.', accepted: false };
  const ack = await writes.acknowledge(notice.version);
  if (!ack.ok) return { error: ack.error, ...(ack.needsNotice ? { renotice: ack.needsNotice } : {}) };
  const out = await writes.accept();
  if (!out.ok) return { error: out.error };
  return { receipt: 'Accepted. You have read the notice, and you are on this round.', accepted: true };
}

// ── The notice asked again after it changes (row I6.4; F2) ─────────────────────────────────────────────────────────
// A person who accepted under an earlier version keeps their seats. My interviews reads GET /interviews/panel-notice and,
// while they hold a pending round and have not acknowledged the current version, offers the notice once per visit with
// the same two answers. It blocks nothing.

export const PANEL_NOTICE_PATH = `${INTERVIEWS_API}/interviews/panel-notice`;

/** F2's answer, with the round the acknowledgement is posted against (the first pending one, or null). */
export interface PanelNoticeStatus { notice: PanelNotice; acknowledged: boolean; pendingRounds: number; roundId?: string | null }

/** Ask again only when the current version is not acknowledged and there is a pending round to post it against. */
export const shouldReaskNotice = (status: PanelNoticeStatus | null | undefined): boolean =>
  !!status && !status.acknowledged && status.pendingRounds > 0 && !!status.roundId;

/**
 * The re-ask's two answers: "I have read it" acknowledges the version shown (no Accept: the seats already are); "Not
 * now" changes nothing and it is offered again on the next visit. A changed notice comes back as `renotice`.
 */
export async function answerChangedNotice(
  optionId: string, notice: PanelNotice,
  acknowledge: (version: string) => Promise<{ ok: true } | { ok: false; error: string; needsNotice?: PanelNotice }>,
): Promise<{ receipt: string; acknowledged: boolean } | { error: string; renotice?: PanelNotice }> {
  if (optionId !== NOTICE_READ) return { receipt: 'Not now. Your rounds stay as they are, and the notice is offered again next time.', acknowledged: false };
  const ack = await acknowledge(notice.version);
  if (!ack.ok) return { error: ack.error, ...(ack.needsNotice ? { renotice: ack.needsNotice } : {}) };
  return { receipt: 'Thank you. You have read the current notice.', acknowledged: true };
}

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

// ── Double-booking (ledger row C-17) ────────────────────────────────────────────────────────────────────────

/** The rounds that hold their seats' time: still to run, or live. The server's rule (conflicts.ts). */
const HOLDING: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'live']);

const windowOf = (scheduledAt: string | null, minutes: number): [number, number] | null => {
  const start = scheduledAt ? Date.parse(scheduledAt) : NaN;
  return Number.isFinite(start) ? [start, start + Math.max(minutes, 0) * 60_000] : null;
};

/**
 * The form's check while a person is picked, before anything is saved: each chosen seat already on another round whose
 * window overlaps this round's (touching ends do not), among the rounds the page has read. The server answers the same
 * list after the save, and that one is the one shown then.
 */
export function pickedConflicts(
  round: Pick<InterviewRow, 'id' | 'scheduledAt' | 'state'> & { round: { minutes: number } },
  seats: Seating,
  rows: ReadonlyArray<Pick<InterviewRow, 'id' | 'scheduledAt' | 'state' | 'lead' | 'panel'> & { round: { minutes: number } }>,
  people: readonly PersonRef[],
): SeatConflict[] {
  const mine = windowOf(round.scheduledAt, round.round.minutes);
  if (!mine || !HOLDING.has(round.state)) return [];
  const out: SeatConflict[] = [];
  for (const userId of new Set([seats.leadId, ...seats.panelIds].filter(Boolean))) {
    const name = people.find((p) => p.id === userId)?.name ?? userId;
    const clashes = rows.filter((o) => {
      if (o.id === round.id || !HOLDING.has(o.state) || (o.lead.id !== userId && !o.panel.some((p) => p.id === userId))) return false;
      const w = windowOf(o.scheduledAt, o.round.minutes);
      return !!w && w[0] < mine[1] && mine[0] < w[1];
    }).sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!));
    for (const o of clashes) out.push({ person: { id: userId, name }, interviewId: o.id, scheduledAt: o.scheduledAt!, minutes: o.round.minutes });
  }
  return out;
}

/** "Hugo Marchetti is also on a round from 14:00 to 15:00 that day." One sentence per clash, in the viewer's zone. */
export function conflictsLine(conflicts: readonly SeatConflict[], timeZone?: string): string {
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  return conflicts.map((c) => {
    const start = Date.parse(c.scheduledAt);
    return `${c.person.name} is also on a round from ${hm.format(new Date(start))} to ${hm.format(new Date(start + c.minutes * 60_000))} that day.`;
  }).join(' ');
}
