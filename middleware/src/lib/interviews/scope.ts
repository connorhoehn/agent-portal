// Who sees which interviews rows (docs/interviews-tenant-plan.md, decision 2; row I0.5).
//
// Cedar decides that a role may read the tenant at all (ViewInterviews); it
// cannot see rows, so the row rule lives here, in one pure function both
// stores' rows pass through:
//
//   recruiter        everything in the tenant
//   interviewer      the interviews they lead or sit on the panel of, and
//                    through each its application, candidate and opening.
//                    Scorecards: their own, every version. The others' on a
//                    candidate's application (any round, every version) only
//                    once their own is in: `othersRevealed` (decision 14,
//                    row I5.3). Until then they read none of them.
//   hiring-manager   the openings they are hiring manager of, and everything
//                    that hangs off them: applications, candidates,
//                    interviews and their scorecards, as they arrive
//                    (decision 15)
//   admin            everything (the cross-tenant break-glass role)
//   anything else    nothing (requireTenant and ViewInterviews refuse first)

import type { Interview, InterviewsWorld, Scorecard } from './types.js';

export interface Viewer {
  id: string;
  role: string;
}

/** Who reads an opening's money: its recruiters, its hiring manager (scope already narrows them to their own openings) and the admin. */
const MONEY_READERS: ReadonlySet<string> = new Set(['recruiter', 'hiring-manager', 'admin']);
export const mayReadOpeningMoney = (role: string): boolean => MONEY_READERS.has(role);

/**
 * Who reads an application's stage history, so the hiring decision and its reason (E4 #29): the recruiter, the
 * opening's hiring manager (scope narrows them to their own openings) and the admin. An interviewer never does,
 * even for a candidate they interviewed: the profile read sends them an empty history.
 */
export const mayReadStageHistory = (role: string): boolean => MONEY_READERS.has(role);

export type Reach = 'everything' | 'assigned' | 'own-openings' | 'nothing';

export function reachOf(role: string): Reach {
  if (role === 'recruiter' || role === 'admin') return 'everything';
  if (role === 'interviewer') return 'assigned';
  if (role === 'hiring-manager') return 'own-openings';
  return 'nothing';
}

/** Rounds that did not go ahead owe nobody a scorecard. */
const NOT_HELD: ReadonlySet<Interview['state']> = new Set(['declined', 'cancelled']);

/**
 * Others hidden until yours is in (decision 14, row I5.3): may interviewer `viewerId` read the other interviewers'
 * scorecards on application `applicationId`? Only when they hold a seat on at least one of its rounds and their own
 * scorecard is in for EVERY round of it they sit on (declined and cancelled rounds aside). So a panel member who has
 * not submitted reads nobody's, and an interviewer with a later round still to run on the same candidate reads
 * nobody's until that one is in too: nothing they read can anchor a judgement they have yet to make.
 */
export function othersRevealed(world: Pick<InterviewsWorld, 'interviews' | 'scorecards'>, viewerId: string, applicationId: string): boolean {
  const mine = world.interviews.filter((i) => i.applicationId === applicationId && !NOT_HELD.has(i.state)
    && (i.leadId === viewerId || i.panelIds.includes(viewerId)));
  if (!mine.length) return false;
  return mine.every((i) => world.scorecards.some((s: Scorecard) => s.interviewId === i.id && s.interviewerId === viewerId));
}

const EMPTY: InterviewsWorld = { openings: [], candidates: [], applications: [], interviews: [], scorecards: [] };

/** The part of `world` the viewer may read. Rows keep the store's order. */
export function visibleWorld(world: InterviewsWorld, viewer: Viewer): InterviewsWorld {
  const reach = reachOf(viewer.role);
  if (reach === 'everything') return world;
  if (reach === 'nothing') return { ...EMPTY };

  if (reach === 'assigned') {
    const interviews = world.interviews.filter((i) => i.leadId === viewer.id || i.panelIds.includes(viewer.id));
    const appIds = new Set(interviews.map((i) => i.applicationId));
    const applications = world.applications.filter((a) => appIds.has(a.id));
    const candidateIds = new Set(applications.map((a) => a.candidateId));
    const openingIds = new Set(applications.map((a) => a.openingId));
    const interviewIds = new Set(interviews.map((i) => i.id));
    // Every round of the applications whose others' scorecards the viewer may read (row I5.3).
    const revealed = new Set([...appIds].filter((a) => othersRevealed(world, viewer.id, a)));
    const readable = new Set(world.interviews.filter((i) => revealed.has(i.applicationId)).map((i) => i.id));
    return {
      openings: world.openings.filter((o) => openingIds.has(o.id)),
      candidates: world.candidates.filter((c) => candidateIds.has(c.id)),
      applications,
      interviews,
      scorecards: world.scorecards.filter((s) => (interviewIds.has(s.interviewId) && s.interviewerId === viewer.id) || readable.has(s.interviewId)),
    };
  }

  // own-openings
  const openings = world.openings.filter((o) => o.hiringManagerId === viewer.id);
  const openingIds = new Set(openings.map((o) => o.id));
  const applications = world.applications.filter((a) => openingIds.has(a.openingId));
  const appIds = new Set(applications.map((a) => a.id));
  const candidateIds = new Set(applications.map((a) => a.candidateId));
  const interviews = world.interviews.filter((i) => appIds.has(i.applicationId));
  const interviewIds = new Set(interviews.map((i) => i.id));
  return {
    openings,
    candidates: world.candidates.filter((c) => candidateIds.has(c.id)),
    applications,
    interviews,
    scorecards: world.scorecards.filter((s) => interviewIds.has(s.interviewId)),
  };
}
