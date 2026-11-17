// The interviews tenant's wire shapes (routes/interviews.ts), built from a
// world the viewer may already read (scope.ts visibleWorld). Pure: the names
// come in as a lookup, so the tests pin every field.

import type {
  ApplicationStage, Candidate, InterviewState, InterviewsWorld, Interview, KitCompetency, KitQuestion, KitRound, Opening,
  OpeningState, Recommendation, RoundType, Scorecard, StageChange, CompetencyRating,
} from './types.js';
import type { Viewer } from './scope.js';

export interface PersonRef { id: string; name: string }
export type People = (id: string) => PersonRef;

/** Where an interview sits on the viewer's desk. */
export type Bucket = 'to-accept' | 'upcoming' | 'scorecard-due' | 'done' | 'closed';

export interface InterviewBrief { id: string; roundName: string; type: RoundType; scheduledAt: string | null; state: InterviewState; lead: PersonRef }
export interface ResultBrief { recommendation: Recommendation; roundName: string; interviewer: PersonRef; submittedAt: string }

export interface CandidateRow {
  applicationId: string;
  candidate: { id: string; name: string; headline: string; location: string; source: string };
  opening: { id: string; title: string; team: string };
  stage: ApplicationStage;
  appliedAt: string;
  stageChangedAt: string;
  nextInterview: InterviewBrief | null;
  lastResult: ResultBrief | null;
  /** An ended interview whose scorecard is not in yet. */
  scorecardDue: boolean;
  roundsDone: number;
  roundsTotal: number;
}

export interface PipelineEntry {
  applicationId: string;
  candidate: { id: string; name: string; headline: string };
  stage: ApplicationStage;
  stageChangedAt: string;
  nextInterview: InterviewBrief | null;
  lastResult: ResultBrief | null;
  /** A round has ended and its scorecard is not in yet. */
  scorecardDue: boolean;
}

export interface OpeningRow {
  id: string;
  title: string;
  level: string;
  team: string;
  location: string;
  state: OpeningState;
  openedAt: string;
  hiringManager: PersonRef | null;
  recruiter: PersonRef;
  rounds: KitRound[];
  /** The kit at a glance (the Openings table, row I1.3): how many competencies, and questions per round type. */
  kitSize: { competencies: number; questions: Record<RoundType, number> };
  candidates: number;
  byStage: Partial<Record<ApplicationStage, number>>;
  upcoming: number;
  scorecardsIn: number;
  pipeline: PipelineEntry[];
}

export interface OpeningRecord extends OpeningRow {
  competencies: KitCompetency[];
  questions: KitQuestion[];
  /** Spend cap per interview in US dollars (decision 18); null while none is set. */
  budgetCapUsd: number | null;
  /** The revision a write must name (row I1.3: compare-and-set). */
  revision: number;
}

export interface InterviewRow {
  id: string;
  candidate: { id: string; name: string; headline: string };
  opening: { id: string; title: string; team: string };
  applicationId: string;
  round: { id: string; name: string; type: RoundType; minutes: number };
  lead: PersonRef;
  panel: PersonRef[];
  scheduledAt: string | null;
  state: InterviewState;
  bucket: Bucket;
  /** The viewer's seat on this interview, if any. */
  seat: 'lead' | 'panel' | null;
  questions: number;
  myScorecard: { recommendation: Recommendation; submittedAt: string } | null;
  scorecardsIn: number;
}

export interface ScorecardView {
  id: string;
  interviewer: PersonRef;
  recommendation: Recommendation;
  summary: string;
  submittedAt: string;
  version: number;
  ratings: Array<CompetencyRating & { competency: string }>;
}

export interface InterviewRecord extends InterviewRow {
  questionsChosen: KitQuestion[];
  competencies: KitCompetency[];
  scorecards: ScorecardView[];
}

export interface CandidateRecord {
  candidate: Candidate;
  applications: Array<{
    applicationId: string;
    opening: { id: string; title: string; team: string };
    stage: ApplicationStage;
    /** Each move with who made it by name (null: the candidate's own application). */
    history: Array<StageChange & { byName: string | null }>;
    /** Each round with the scorecards the viewer may read (the world is already scoped; an interviewer reads only their own). */
    interviews: Array<InterviewRow & { results: Array<{ interviewer: PersonRef; recommendation: Recommendation }> }>;
  }>;
}

const OPEN_STATES: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'live']);
const DONE_STATES: ReadonlySet<InterviewState> = new Set(['scored', 'reviewed']);

export const UNKNOWN_ROUND = 'Round';

function roundOf(opening: Opening | undefined, roundId: string): KitRound | undefined {
  return opening?.kit.rounds.find((r) => r.id === roundId);
}

export function bucketFor(interview: Interview, viewer: Viewer, scorecards: readonly Scorecard[]): Bucket {
  if (interview.state === 'declined' || interview.state === 'cancelled') return 'closed';
  if (interview.state === 'assigned') return 'to-accept';
  if (OPEN_STATES.has(interview.state)) return 'upcoming';
  if (interview.state === 'ended') return 'scorecard-due';
  const seated = interview.leadId === viewer.id || interview.panelIds.includes(viewer.id);
  if (seated && !scorecards.some((s) => s.interviewId === interview.id && s.interviewerId === viewer.id)) return 'scorecard-due';
  return 'done';
}

/** Indexes over one visible world, built once per request. */
export class WorldIndex {
  readonly openings: Map<string, Opening>;
  readonly candidates: Map<string, Candidate>;
  readonly applications: Map<string, InterviewsWorld['applications'][number]>;
  constructor(readonly world: InterviewsWorld, readonly people: People, readonly viewer: Viewer) {
    this.openings = new Map(world.openings.map((o) => [o.id, o]));
    this.candidates = new Map(world.candidates.map((c) => [c.id, c]));
    this.applications = new Map(world.applications.map((a) => [a.id, a]));
  }

  interviewsOf(applicationId: string): Interview[] {
    return this.world.interviews.filter((i) => i.applicationId === applicationId);
  }

  scorecardsOf(interviewId: string): Scorecard[] {
    return this.world.scorecards.filter((s) => s.interviewId === interviewId);
  }

  private openingOfInterview(i: Interview): Opening | undefined {
    const app = this.applications.get(i.applicationId);
    return app ? this.openings.get(app.openingId) : undefined;
  }

  brief(i: Interview): InterviewBrief {
    return { id: i.id, roundName: roundOf(this.openingOfInterview(i), i.roundId)?.name ?? UNKNOWN_ROUND, type: i.type, scheduledAt: i.scheduledAt, state: i.state, lead: this.people(i.leadId) };
  }

  /** The earliest interview still to happen on an application. */
  nextInterview(applicationId: string): InterviewBrief | null {
    const next = this.interviewsOf(applicationId)
      .filter((i) => OPEN_STATES.has(i.state) && i.scheduledAt !== null)
      .sort((a, b) => a.scheduledAt!.localeCompare(b.scheduledAt!))[0];
    return next ? this.brief(next) : null;
  }

  /** The latest scorecard the viewer may read on an application. */
  lastResult(applicationId: string): ResultBrief | null {
    const ids = new Map(this.interviewsOf(applicationId).map((i) => [i.id, i]));
    const latest = this.world.scorecards.filter((s) => ids.has(s.interviewId)).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    if (!latest) return null;
    const i = ids.get(latest.interviewId)!;
    return { recommendation: latest.recommendation, roundName: roundOf(this.openingOfInterview(i), i.roundId)?.name ?? UNKNOWN_ROUND, interviewer: this.people(latest.interviewerId), submittedAt: latest.submittedAt };
  }

  candidateRows(): CandidateRow[] {
    return this.world.applications.flatMap((a): CandidateRow[] => {
      const c = this.candidates.get(a.candidateId);
      const o = this.openings.get(a.openingId);
      if (!c || !o) return [];
      const interviews = this.interviewsOf(a.id);
      return [{
        applicationId: a.id,
        candidate: { id: c.id, name: c.name, headline: c.headline, location: c.location, source: c.source },
        opening: { id: o.id, title: o.title, team: o.team },
        stage: a.stage,
        appliedAt: a.appliedAt,
        stageChangedAt: a.history[a.history.length - 1]?.at ?? a.appliedAt,
        nextInterview: this.nextInterview(a.id),
        lastResult: this.lastResult(a.id),
        scorecardDue: interviews.some((i) => i.state === 'ended'),
        roundsDone: interviews.filter((i) => DONE_STATES.has(i.state)).length,
        roundsTotal: o.kit.rounds.length,
      }];
    });
  }

  openingRow(o: Opening): OpeningRow {
    const apps = this.world.applications.filter((a) => a.openingId === o.id);
    const byStage: Partial<Record<ApplicationStage, number>> = {};
    for (const a of apps) byStage[a.stage] = (byStage[a.stage] ?? 0) + 1;
    const appIds = new Set(apps.map((a) => a.id));
    const interviews = this.world.interviews.filter((i) => appIds.has(i.applicationId));
    const interviewIds = new Set(interviews.map((i) => i.id));
    return {
      id: o.id, title: o.title, level: o.level, team: o.team, location: o.location, state: o.state, openedAt: o.openedAt,
      hiringManager: o.hiringManagerId ? this.people(o.hiringManagerId) : null,
      recruiter: this.people(o.recruiterId),
      rounds: o.kit.rounds,
      kitSize: {
        competencies: o.kit.competencies.length,
        questions: { technical: o.kit.questions.filter((q) => q.roundType === 'technical').length, behavioural: o.kit.questions.filter((q) => q.roundType === 'behavioural').length },
      },
      candidates: apps.length,
      byStage,
      upcoming: interviews.filter((i) => OPEN_STATES.has(i.state)).length,
      scorecardsIn: this.world.scorecards.filter((s) => interviewIds.has(s.interviewId)).length,
      pipeline: apps.flatMap((a): PipelineEntry[] => {
        const c = this.candidates.get(a.candidateId);
        if (!c) return [];
        return [{
          applicationId: a.id, candidate: { id: c.id, name: c.name, headline: c.headline }, stage: a.stage,
          stageChangedAt: a.history[a.history.length - 1]?.at ?? a.appliedAt,
          nextInterview: this.nextInterview(a.id), lastResult: this.lastResult(a.id),
          scorecardDue: this.interviewsOf(a.id).some((i) => i.state === 'ended'),
        }];
      }),
    };
  }

  openingRecord(o: Opening): OpeningRecord {
    return { ...this.openingRow(o), competencies: o.kit.competencies, questions: o.kit.questions, budgetCapUsd: o.budgetCapUsd, revision: o.revision };
  }

  interviewRow(i: Interview): InterviewRow | null {
    const a = this.applications.get(i.applicationId);
    const c = a ? this.candidates.get(a.candidateId) : undefined;
    const o = a ? this.openings.get(a.openingId) : undefined;
    if (!a || !c || !o) return null;
    const round = roundOf(o, i.roundId);
    const cards = this.scorecardsOf(i.id);
    const mine = cards.find((s) => s.interviewerId === this.viewer.id);
    return {
      id: i.id,
      candidate: { id: c.id, name: c.name, headline: c.headline },
      opening: { id: o.id, title: o.title, team: o.team },
      applicationId: a.id,
      round: { id: i.roundId, name: round?.name ?? UNKNOWN_ROUND, type: i.type, minutes: i.minutes },
      lead: this.people(i.leadId),
      panel: i.panelIds.map((p) => this.people(p)),
      scheduledAt: i.scheduledAt,
      state: i.state,
      bucket: bucketFor(i, this.viewer, this.world.scorecards),
      seat: i.leadId === this.viewer.id ? 'lead' : i.panelIds.includes(this.viewer.id) ? 'panel' : null,
      questions: i.questionIds.length,
      myScorecard: mine ? { recommendation: mine.recommendation, submittedAt: mine.submittedAt } : null,
      scorecardsIn: cards.length,
    };
  }

  interviewRows(): InterviewRow[] {
    return this.world.interviews.map((i) => this.interviewRow(i)).filter((r): r is InterviewRow => r !== null);
  }

  interviewRecord(i: Interview): InterviewRecord | null {
    const row = this.interviewRow(i);
    if (!row) return null;
    const o = this.openings.get(row.opening.id)!;
    const names = new Map(o.kit.competencies.map((k) => [k.id, k.name]));
    return {
      ...row,
      questionsChosen: i.questionIds.map((q) => o.kit.questions.find((k) => k.id === q)).filter((q): q is KitQuestion => !!q),
      competencies: o.kit.competencies,
      scorecards: this.scorecardsOf(i.id).map((s) => ({
        id: s.id, interviewer: this.people(s.interviewerId), recommendation: s.recommendation, summary: s.summary,
        submittedAt: s.submittedAt, version: s.version,
        ratings: s.ratings.map((r) => ({ ...r, competency: names.get(r.competencyId) ?? r.competencyId })),
      })),
    };
  }

  candidateRecord(c: Candidate): CandidateRecord {
    return {
      candidate: c,
      applications: this.world.applications.filter((a) => a.candidateId === c.id).flatMap((a) => {
        const o = this.openings.get(a.openingId);
        if (!o) return [];
        return [{
          applicationId: a.id, opening: { id: o.id, title: o.title, team: o.team }, stage: a.stage,
          history: a.history.map((h) => ({ ...h, byName: h.by ? this.people(h.by).name : null })),
          interviews: this.interviewsOf(a.id).flatMap((i) => {
            const row = this.interviewRow(i);
            return row ? [{ ...row, results: this.scorecardsOf(i.id).map((s) => ({ interviewer: this.people(s.interviewerId), recommendation: s.recommendation })) }] : [];
          }),
        }];
      }),
    };
  }
}
