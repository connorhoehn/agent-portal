// Who sees which interviews rows (docs/interviews-tenant-plan.md, decision 2; row I0.5).
//
// Cedar decides that a role may read the tenant at all (ViewInterviews); it
// cannot see rows, so the row rule lives here, in one pure function both
// stores' rows pass through:
//
//   recruiter        everything in the tenant
//   interviewer      the interviews they lead or sit on the panel of, and
//                    through each its application, candidate and opening;
//                    of the scorecards, only their own (decision 14 hides the
//                    others until theirs is in; that reveal is row I5.3)
//   hiring-manager   the openings they are hiring manager of, and everything
//                    that hangs off them: applications, candidates,
//                    interviews and their scorecards
//   admin            everything (the cross-tenant break-glass role)
//   anything else    nothing (requireTenant and ViewInterviews refuse first)

import type { InterviewsWorld } from './types.js';

export interface Viewer {
  id: string;
  role: string;
}

/** Who reads an opening's money: its recruiters, its hiring manager (scope already narrows them to their own openings) and the admin. */
const MONEY_READERS: ReadonlySet<string> = new Set(['recruiter', 'hiring-manager', 'admin']);
export const mayReadOpeningMoney = (role: string): boolean => MONEY_READERS.has(role);

export type Reach = 'everything' | 'assigned' | 'own-openings' | 'nothing';

export function reachOf(role: string): Reach {
  if (role === 'recruiter' || role === 'admin') return 'everything';
  if (role === 'interviewer') return 'assigned';
  if (role === 'hiring-manager') return 'own-openings';
  return 'nothing';
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
    return {
      openings: world.openings.filter((o) => openingIds.has(o.id)),
      candidates: world.candidates.filter((c) => candidateIds.has(c.id)),
      applications,
      interviews,
      scorecards: world.scorecards.filter((s) => interviewIds.has(s.interviewId) && s.interviewerId === viewer.id),
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
