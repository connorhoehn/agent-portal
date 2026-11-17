// What the debrief reads (docs/interviews-tenant-plan.md decisions 6, 14, 15; rows I5.4, I5.5; contract E4).
//
// One candidate, per application the viewer may see: the stage and its history (each decision with what was decided
// and how many scorecards were missing), and each round with its state, lead and panel, when it ran, every
// submitted scorecard (the latest version whole, whether a rating changed after the recap, the correction reason,
// how many earlier versions there are), who has not submitted yet, and where its recap (E3) and record (E2) are.
//
// Readers: the recruiter, the hiring manager of that opening, the admin. An interviewer reads no debrief whatever
// they have submitted (their view of the others stays the scorecard page's). Nothing about the candidate's consent
// answers (decision 5). No average, no total, no ranking (decision 6): what people wrote, side by side.

import { latestByAuthor, seatedOf } from '../scorecard.js';
import { reachOf } from '../scope.js';
import type { ApplicationStage, Interview, InterviewState, Recommendation, RoundType, StageChange } from '../types.js';
import type { PersonRef, WorldIndex } from '../views.js';
import { DECISIONS, DECISION_LIMITS, DECISION_TARGET, decisionMove, isDecisionChange, scorecardsMissing, type Decision } from './rules.js';

export interface DebriefScorecard {
  id: string;
  interviewer: PersonRef;
  version: number;
  submittedAt: string;
  recommendation: Recommendation;
  summary: string;
  ratings: Array<{ competencyId: string; competency: string; rating: 1 | 2 | 3 | 4; note: string }>;
  /** Whether a rating changed after the interviewer opened Milo's recap (decision 14). */
  changedAfterRecap: boolean;
  /** Why this version corrects the one before it; null on a first version. */
  correctionReason: string | null;
  /** How many versions came before this one. */
  earlierVersions: number;
}

export interface DebriefRound {
  interviewId: string;
  name: string;
  type: RoundType;
  minutes: number;
  state: InterviewState;
  lead: PersonRef;
  panel: PersonRef[];
  scheduledAt: string | null;
  endedAt: string | null;
  /** Each seat's latest scorecard, lead first, then the panel in seat order. */
  scorecards: DebriefScorecard[];
  /** Seats whose scorecard is not in on a round that has been held; empty before the round runs. */
  due: PersonRef[];
  /** The recap's API path (E3) and the record's page path (E2), once the round has been held; null before. */
  recapPath: string | null;
  recordPath: string | null;
}

export interface DebriefMove extends StageChange {
  byName: string | null;
  /** Set on a hiring manager's decision (row I5.5); null on any other move. */
  decision: Decision | null;
  /** How many scorecards were still due when the decision was made; null on any other move. */
  scorecardsMissing: number | null;
}

export interface DebriefDecide {
  /** The options as the stage now stands: where each goes, or why it cannot be made. */
  options: Array<{ decision: Decision; to: ApplicationStage; allowed: boolean; refusal: string | null }>;
  /** Seats whose scorecard is still due on held rounds: the page asks once more when this is not 0. */
  scorecardsMissing: number;
  limits: typeof DECISION_LIMITS;
}

export interface DebriefApplication {
  applicationId: string;
  opening: { id: string; title: string; team: string };
  stage: ApplicationStage;
  /** Oldest first. */
  history: DebriefMove[];
  /** The length of the history as read: a decision names it, so a stale page never decides. */
  basedOn: number;
  /** The kit's competencies in order: the rows of the side-by-side table. */
  competencies: Array<{ id: string; name: string }>;
  rounds: DebriefRound[];
  /** Only for the opening's hiring manager; null for everyone else (they read and do not decide). */
  decide: DebriefDecide | null;
}

export interface DebriefView {
  candidate: { id: string; name: string; headline: string };
  applications: DebriefApplication[];
}

const HELD: ReadonlySet<InterviewState> = new Set(['ended', 'scored', 'reviewed']);

/** Who reads a debrief at all: the recruiter, the hiring manager (their own openings, by scope) and the admin. */
export const readsDebrief = (role: string): boolean => {
  const reach = reachOf(role);
  return reach === 'everything' || reach === 'own-openings';
};

function roundOf(ix: WorldIndex, i: Interview, names: ReadonlyMap<string, string>, roundName: string): DebriefRound {
  const all = ix.world.scorecards.filter((s) => s.interviewId === i.id);
  const latest = latestByAuthor(all);
  const seats = seatedOf(i);
  const order = (id: string) => { const k = seats.indexOf(id); return k < 0 ? seats.length : k; };
  const held = HELD.has(i.state);
  return {
    interviewId: i.id, name: roundName, type: i.type, minutes: i.minutes, state: i.state,
    lead: ix.people(i.leadId), panel: i.panelIds.map((p) => ix.people(p)), scheduledAt: i.scheduledAt, endedAt: i.endedAt,
    scorecards: [...latest].sort((a, b) => order(a.interviewerId) - order(b.interviewerId)).map((s) => ({
      id: s.id, interviewer: ix.people(s.interviewerId), version: s.version, submittedAt: s.submittedAt, recommendation: s.recommendation, summary: s.summary,
      ratings: s.ratings.map((r) => ({ competencyId: r.competencyId, competency: names.get(r.competencyId) ?? r.competencyId, rating: r.rating, note: r.note })),
      changedAfterRecap: s.changedAfterRecap, correctionReason: s.correctionReason,
      earlierVersions: all.filter((e) => e.interviewerId === s.interviewerId && e.version < s.version).length,
    })),
    due: held ? seats.filter((p) => !latest.some((s) => s.interviewerId === p)).map((p) => ix.people(p)) : [],
    recapPath: held ? `/api/interviews/interviews/${encodeURIComponent(i.id)}/recap` : null,
    recordPath: held ? `/interviews/rounds/${encodeURIComponent(i.id)}/record` : null,
  };
}

/** The debrief of `candidateId` as the viewer of `ix` reads it; null when they read none (not found). */
export function debriefView(ix: WorldIndex, candidateId: string): DebriefView | null {
  if (!readsDebrief(ix.viewer.role)) return null;
  const c = ix.candidates.get(candidateId);
  if (!c) return null;
  const applications = ix.world.applications.filter((a) => a.candidateId === c.id).flatMap((a): DebriefApplication[] => {
    const o = ix.openings.get(a.openingId);
    if (!o) return [];
    const names = new Map(o.kit.competencies.map((k) => [k.id, k.name]));
    const interviews = ix.interviewsOf(a.id);
    const rounds = interviews.map((i) => roundOf(ix, i, names, o.kit.rounds.find((r) => r.id === i.roundId)?.name ?? 'Round'));
    const cards = ix.world.scorecards.filter((s) => interviews.some((i) => i.id === s.interviewId));
    const decides = ix.viewer.role === 'hiring-manager' && o.hiringManagerId === ix.viewer.id;
    return [{
      applicationId: a.id,
      opening: { id: o.id, title: o.title, team: o.team },
      stage: a.stage,
      history: a.history.map((h) => ({
        stage: h.stage, at: h.at, by: h.by, reason: h.reason, byName: h.by ? ix.people(h.by).name : null,
        decision: isDecisionChange(h) ? h.decision : null, scorecardsMissing: isDecisionChange(h) ? h.scorecardsMissing : null,
      })),
      basedOn: a.history.length,
      competencies: o.kit.competencies.map((k) => ({ id: k.id, name: k.name })),
      rounds,
      decide: decides ? {
        options: DECISIONS.map((d) => {
          const move = decisionMove(a.stage, d, interviews, cards);
          return { decision: d, to: DECISION_TARGET[d], allowed: move.ok, refusal: move.ok ? null : move.message };
        }),
        scorecardsMissing: scorecardsMissing(interviews, cards),
        limits: DECISION_LIMITS,
      } : null,
    }];
  });
  if (!applications.length) return null;
  return { candidate: { id: c.id, name: c.name, headline: c.headline }, applications };
}
