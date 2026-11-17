// Assigning a round, answering a seat and reassigning (docs/interviews-tenant-plan.md row I1.4; decisions 2, 16
// and 20). The tenant's first state machine, and the pattern later rows (the time, I1.5; scorecards, I5.3) copy.
//
// Pure functions over plain input and a world, so the route and the tests hold every write to the same rules.
// Each check answers either the cleaned value or a list of problems, one plain sentence per field (kit.ts's
// shape), keyed by the field the form shows it on: applicationId, roundId, leadId, panelIds, reason, answer.
//
// The seat model. An interview has one lead and up to two panel members (`leadId`, `panelIds`, decision 20).
// Each seat answers for itself:
//
//   seat    accepts                                   declines (a reason is required)
//   lead    assigned → accepted                       → declined; the lead stays named so the recruiter sees who
//   panel   recorded on the seat; the state stays     leaves the panel; the state stays
//
// `acceptances` holds an entry for each seat that has accepted, and only for seats held now; `declines` keeps
// every decline with its reason across reassignments (the recruiter and the hiring manager read them, views.ts;
// another interviewer never does). Nobody answers a seat twice, nobody answers a seat they do not hold, and
// nothing is answered once the call has started or the round is closed.
//
// Reassigning (the recruiter): the lead or the panel may change while the call has not started (assigned,
// accepted, ready or declined). A new lead puts the round back to `assigned` and is asked; a seat whose holder
// stays keeps its acceptance. The time and the chosen questions are not touched (I1.5 and I1.7 own them).

import { randomBytes } from 'node:crypto';
import type { Checked, FieldProblem } from './kit.js';
import type { Application, Interview, InterviewState, InterviewsWorld, Opening, Seat, SeatAcceptance, SeatDecline } from './types.js';

export const ASSIGN_LIMITS = {
  /** Panel members besides the lead (decision 20). */
  panel: 2,
  /** A decline's reason, in characters. */
  reasonMin: 10,
  reasonMax: 500,
  /** An interview id names the pad's channel, whose names stop at 40 characters (the I0.7 answer). */
  id: 40,
} as const;

/** Stages where a round makes no sense: the application is over. */
const CLOSED_STAGES: ReadonlySet<Application['stage']> = new Set(['rejected', 'withdrawn', 'hired']);
/** An interview in one of these does not hold its application's round: the round may be assigned again. */
const VACANT_STATES: ReadonlySet<InterviewState> = new Set(['declined', 'cancelled']);
/** Seats may be answered while the call has not started. */
const ANSWERABLE: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready']);
/** The recruiter may change who sits on the round while the call has not started. */
const REASSIGNABLE: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'declined']);

export const isAnswerable = (state: InterviewState): boolean => ANSWERABLE.has(state);
export const isReassignable = (state: InterviewState): boolean => REASSIGNABLE.has(state);

/** What the recruiter asked for: whose application, which of the opening's rounds, who leads, who else sits. */
export interface Assignment {
  applicationId: string;
  roundId: string;
  leadId: string;
  panelIds: string[];
}

/** The seats a reassignment asks for. */
export type Seating = Pick<Assignment, 'leadId' | 'panelIds'>;

/** The fields a seat's answer writes (store.ts InterviewWrites.answerSeat). */
export type SeatAnswerChange = Pick<Interview, 'state' | 'panelIds' | 'acceptances' | 'declines'>;
/** The fields a reassignment writes (store.ts InterviewWrites.reassign). */
export type Reassignment = Pick<Interview, 'leadId' | 'panelIds' | 'state' | 'acceptances'>;

export type Answer = { answer: 'accept' } | { answer: 'decline'; reason: string };

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const record = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The seats' own rules, shared by assigning and reassigning. */
function checkSeats(body: Record<string, unknown>, interviewers: ReadonlySet<string>, problems: FieldProblem[]): Seating {
  const leadId = text(body['leadId']);
  if (!leadId) problems.push({ path: 'leadId', message: 'Choose who leads this round.' });
  else if (!interviewers.has(leadId)) problems.push({ path: 'leadId', message: 'The lead must be someone who interviews here.' });

  const raw = body['panelIds'] ?? [];
  const panelIds: string[] = [];
  if (!Array.isArray(raw)) {
    problems.push({ path: 'panelIds', message: 'The panel must be a list of people.' });
  } else {
    raw.forEach((v, i) => {
      const id = text(v);
      if (!id) problems.push({ path: `panelIds.${i}`, message: 'Choose a person for this panel seat, or remove the seat.' });
      else if (!interviewers.has(id)) problems.push({ path: `panelIds.${i}`, message: 'A panel member must be someone who interviews here.' });
      else if (id === leadId) problems.push({ path: `panelIds.${i}`, message: 'The lead cannot also sit on the panel.' });
      else if (panelIds.includes(id)) problems.push({ path: `panelIds.${i}`, message: 'This person is already on the panel.' });
      else panelIds.push(id);
    });
    if (raw.length > ASSIGN_LIMITS.panel) problems.push({ path: 'panelIds', message: `A round has at most ${ASSIGN_LIMITS.panel} panel members besides the lead.` });
  }
  return { leadId, panelIds };
}

/**
 * A new round for an application. `interviewers` are the people who hold the interviewer role in this
 * tenant; `world` is the recruiter's (everything).
 */
export function checkAssignment(input: unknown, world: Pick<InterviewsWorld, 'applications' | 'openings' | 'interviews'>, interviewers: ReadonlySet<string>): Checked<Assignment> {
  const body = record(input);
  const problems: FieldProblem[] = [];
  const applicationId = text(body['applicationId']);
  const roundId = text(body['roundId']);

  const app = world.applications.find((a) => a.id === applicationId);
  const opening = app ? world.openings.find((o) => o.id === app.openingId) : undefined;
  if (!app || !opening) {
    problems.push({ path: 'applicationId', message: 'Choose the candidate\'s application this round is for.' });
  } else if (CLOSED_STAGES.has(app.stage)) {
    problems.push({ path: 'applicationId', message: 'This application is no longer moving, so it takes no more rounds.' });
  } else if (opening.state !== 'open') {
    problems.push({ path: 'applicationId', message: 'This opening is not open, so its rounds cannot be assigned. Open it again first.' });
  }

  if (opening) {
    if (!roundId) problems.push({ path: 'roundId', message: 'Choose which round to assign.' });
    else if (!opening.kit.rounds.some((r) => r.id === roundId)) problems.push({ path: 'roundId', message: 'Choose one of this opening\'s rounds.' });
    else if (world.interviews.some((i) => i.applicationId === applicationId && i.roundId === roundId && !VACANT_STATES.has(i.state))) {
      problems.push({ path: 'roundId', message: 'This round is already assigned for this candidate. Change who sits on it from the rounds list instead.' });
    }
  }

  const seats = checkSeats(body, interviewers, problems);
  if (problems.length) return { ok: false, problems };
  return { ok: true, value: { applicationId, roundId, ...seats } };
}

/** The new interview: `assigned`, no time (row I1.5 sets it), nothing chosen, nobody answered yet. */
export function newInterview(a: Assignment, opening: Opening, id: string, by: string, at: string): Interview {
  const round = opening.kit.rounds.find((r) => r.id === a.roundId)!;
  return {
    id, applicationId: a.applicationId, roundId: a.roundId, type: round.type, leadId: a.leadId, panelIds: [...a.panelIds],
    scheduledAt: null, minutes: round.minutes, state: 'assigned', questionIds: [], assignedBy: by, assignedAt: at,
    callId: null, endedAt: null, acceptances: [], declines: [], revision: 1,
  };
}

/** A new interview id: `iv-` and twelve random letters and digits. Says nothing about the candidate, never reused. */
export function interviewIdFor(taken: ReadonlySet<string>, random: () => string = () => randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')): string {
  for (;;) {
    const id = `iv-${(random() + '000000000000').slice(0, 12)}`;
    if (!taken.has(id) && id.length <= ASSIGN_LIMITS.id) return id;
  }
}

/** An answer as sent: `{ answer: 'accept' }` or `{ answer: 'decline', reason }`. */
export function checkAnswer(input: unknown): Checked<Answer> {
  const body = record(input);
  const answer = body['answer'];
  if (answer === 'accept') return { ok: true, value: { answer: 'accept' } };
  if (answer !== 'decline') return { ok: false, problems: [{ path: 'answer', message: 'Accept or decline the round.' }] };
  const reason = text(body['reason']).replace(/\s+/g, ' ');
  if (reason.length < ASSIGN_LIMITS.reasonMin) {
    return { ok: false, problems: [{ path: 'reason', message: `Say why you are declining, in at least ${ASSIGN_LIMITS.reasonMin} characters, so the recruiter can arrange someone else.` }] };
  }
  if (reason.length > ASSIGN_LIMITS.reasonMax) {
    return { ok: false, problems: [{ path: 'reason', message: `Keep the reason under ${ASSIGN_LIMITS.reasonMax} characters.` }] };
  }
  return { ok: true, value: { answer: 'decline', reason } };
}

/** The seat `userId` holds on `i`, if any. */
export function seatOf(i: Pick<Interview, 'leadId' | 'panelIds'>, userId: string): Seat | null {
  if (i.leadId === userId) return 'lead';
  return i.panelIds.includes(userId) ? 'panel' : null;
}

/** Has the person in `seat` accepted it? */
export const hasAccepted = (i: Pick<Interview, 'acceptances'>, userId: string, seat: Seat): boolean =>
  i.acceptances.some((a) => a.userId === userId && a.seat === seat);

export type AnswerOutcome =
  | { ok: true; change: SeatAnswerChange; seat: Seat }
  | { ok: false; reason: 'no-seat' | 'answered' | 'closed'; message: string };

/** `userId` answers the seat they hold on `i`. */
export function answerSeat(i: Interview, userId: string, answer: Answer, at: string): AnswerOutcome {
  const seat = seatOf(i, userId);
  if (!seat) return { ok: false, reason: 'no-seat', message: 'You do not have a seat on this round, so there is nothing for you to answer.' };
  if (!ANSWERABLE.has(i.state)) {
    return { ok: false, reason: 'closed', message: i.state === 'declined' || i.state === 'cancelled'
      ? 'This round is no longer going ahead, so it cannot be answered.'
      : 'This round has already started, so it can no longer be answered.' };
  }
  if (hasAccepted(i, userId, seat)) return { ok: false, reason: 'answered', message: 'You have already accepted this round.' };

  if (answer.answer === 'accept') {
    const acceptance: SeatAcceptance = { userId, seat, at };
    return { ok: true, seat, change: {
      state: seat === 'lead' && i.state === 'assigned' ? 'accepted' : i.state,
      panelIds: [...i.panelIds], acceptances: [...i.acceptances, acceptance], declines: [...i.declines],
    } };
  }
  const decline: SeatDecline = { userId, seat, reason: answer.reason, at };
  return { ok: true, seat, change: seat === 'lead'
    ? { state: 'declined', panelIds: [...i.panelIds], acceptances: [...i.acceptances], declines: [...i.declines, decline] }
    : {
      state: i.state, panelIds: i.panelIds.filter((p) => p !== userId),
      acceptances: i.acceptances.filter((a) => a.userId !== userId), declines: [...i.declines, decline],
    } };
}

/** A reassignment of `i`'s seats, checked against its state and the seats' own rules. */
export function checkReassignment(input: unknown, i: Interview, interviewers: ReadonlySet<string>): Checked<Seating> {
  if (!REASSIGNABLE.has(i.state)) {
    return { ok: false, problems: [{ path: 'state', message: i.state === 'cancelled'
      ? 'This round was cancelled, so nobody can be assigned to it.'
      : 'This round has already started, so who sits on it can no longer change.' }] };
  }
  const problems: FieldProblem[] = [];
  const seats = checkSeats(record(input), interviewers, problems);
  if (problems.length) return { ok: false, problems };
  if (i.state === 'declined' && seats.leadId === i.leadId) {
    return { ok: false, problems: [{ path: 'leadId', message: 'The lead declined this round. Choose someone else to lead it.' }] };
  }
  const samePanel = seats.panelIds.length === i.panelIds.length && seats.panelIds.every((p) => i.panelIds.includes(p));
  if (seats.leadId === i.leadId && samePanel) return { ok: false, problems: [{ path: 'leadId', message: 'Nothing changed: choose a different lead or panel.' }] };
  return { ok: true, value: seats };
}

/** The write a checked reassignment makes: a new lead puts the round back to `assigned`; held seats keep their acceptance. */
export function applyReassignment(i: Interview, seats: Seating): Reassignment {
  const newLead = seats.leadId !== i.leadId;
  return {
    leadId: seats.leadId,
    panelIds: [...seats.panelIds],
    state: newLead ? 'assigned' : i.state,
    acceptances: i.acceptances.filter((a) => (a.seat === 'lead' ? a.userId === seats.leadId && !newLead : seats.panelIds.includes(a.userId))),
  };
}

/** The people a reassignment puts in a seat they did not hold before: they are the ones to ask (the bell). */
export function newlySeated(before: Pick<Interview, 'leadId' | 'panelIds'>, after: Seating): string[] {
  return [
    ...(after.leadId !== before.leadId ? [after.leadId] : []),
    ...after.panelIds.filter((p) => !before.panelIds.includes(p)),
  ];
}

/** "The round was not assigned: one thing needs fixing." */
export function assignProblemsLine(what: 'assign' | 'reassign' | 'answer', count: number): string {
  const noun = what === 'assign' ? 'The round was not assigned' : what === 'reassign' ? 'Nobody was reassigned' : 'Your answer was not saved';
  return `${noun}: ${count === 1 ? 'one thing needs' : `${count} things need`} fixing.`;
}

/** The time may be set, changed or cleared while the call has not started (row I1.5). `ready` is reached by nothing yet. */
const TIMEABLE: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready']);
export const isTimeable = (state: InterviewState): boolean => TIMEABLE.has(state);

/**
 * A time as sent: `{ scheduledAt: '<ISO instant>' }` sets, `{ scheduledAt: null }` clears. A set time is a whole
 * minute in the future and is stored in UTC; the round must not have started or closed. `now` is injectable for tests.
 */
export function checkTime(input: unknown, i: Pick<Interview, 'state'>, now: Date = new Date()): Checked<{ scheduledAt: string | null }> {
  if (!TIMEABLE.has(i.state)) {
    return { ok: false, problems: [{ path: 'state', message: i.state === 'declined' || i.state === 'cancelled'
      ? 'This round is no longer going ahead, so it cannot be given a time.'
      : 'This round has already started, so its time can no longer change.' }] };
  }
  const raw = record(input)['scheduledAt'];
  if (raw === null) return { ok: true, value: { scheduledAt: null } };
  const bad = (message: string): Checked<{ scheduledAt: string | null }> => ({ ok: false, problems: [{ path: 'scheduledAt', message }] });
  if (typeof raw !== 'string' || !raw.trim()) return bad('Choose a date and time for this round.');
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return bad('Choose a date and time for this round.');
  if (at.getTime() % 60000 !== 0) return bad('Choose a time on a whole minute.');
  if (at.getTime() <= now.getTime()) return bad('Choose a time in the future: that time has already passed.');
  return { ok: true, value: { scheduledAt: at.toISOString() } };
}

export function timeProblemsLine(count: number): string {
  return `The time was not saved: ${count === 1 ? 'one thing needs' : `${count} things need`} fixing.`;
}
