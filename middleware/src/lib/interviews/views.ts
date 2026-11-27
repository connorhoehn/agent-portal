// The interviews tenant's wire shapes (routes/interviews.ts), built from a
// world the viewer may already read (scope.ts visibleWorld). Pure: the names
// come in as a lookup, so the tests pin every field.

import type {
  ApplicationStage, Candidate, InterviewState, InterviewsWorld, Interview, KitCompetency, KitQuestion, KitRound, Opening,
  OpeningState, Recommendation, RoundType, Scorecard, StageChange, CompetencyRating,
} from './types.js';
import { mayReadCandidateContact, mayReadOpeningMoney, mayReadStageHistory, reachOf, type Viewer } from './scope.js';
import { hasAccepted, isAnswerable, seatOf } from './assign.js';
import { isPreparable, mayChoose, MAX_QUESTIONS, missingLine, readyState } from './prepare.js';
import type { CancelReason, Seat } from './types.js';
import { candidateVersion } from './types.js';
import { CANCEL_REASON_LABEL } from './cancel.js';
import { latestByAuthor } from './scorecard.js';
import { competenciesOfRound, competencyIdsOfRound, questionsOfRound } from './kit.js';
import { seatConflicts, type SeatConflict } from './conflicts.js';
import { isMissed } from './missed.js';
import { interviewsNowMs } from './clock.js';

export interface PersonRef { id: string; name: string }
export type People = (id: string) => PersonRef;

/** Where an interview sits on the viewer's desk. */
export type Bucket = 'to-accept' | 'to-prepare' | 'upcoming' | 'scorecard-due' | 'done' | 'closed';

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
  /** Every round that went ahead is scored and at least one waits for a decision: the debrief leads (row I5.5). */
  debriefReady: boolean;
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
  budgetCapUsd?: number | null;
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
  /** Each seat held now, the lead first, and whether its holder has accepted (row I1.4). */
  seats: Array<{ person: PersonRef; seat: Seat; accepted: boolean }>;
  /** The viewer's own seat: still to answer, or accepted; null without a seat. */
  myAnswer: 'to-answer' | 'accepted' | null;
  /** Who declined and why, oldest first. The recruiter and the hiring manager read them; an interviewer gets none. */
  declines: Array<{ person: PersonRef; seat: Seat; reason: string; at: string }>;
  /** Why the round was cancelled, by whom and when (lib/interviews/cancel.ts); null unless the state is `cancelled`. */
  cancellation: { reason: CancelReason; label: string; note: string | null; by: PersonRef; at: string } | null;
  /** Still waiting to go live, and its start is more than its length in the past by the tenant's clock (missed.ts). Never stored. */
  missed: boolean;
  /** The revision a write must name (row I1.4: compare-and-set). */
  revision: number;
}

/** One version of a scorecard as it reads. */
export interface ScorecardVersionView {
  id: string;
  interviewer: PersonRef;
  recommendation: Recommendation;
  summary: string;
  submittedAt: string;
  version: number;
  /** Why this version corrects the one before it; null on a first version (row I5.3). */
  correctionReason: string | null;
  /** Each rating with its competency's name and the anchor sentence for the rating given (null once the kit lost it). */
  ratings: Array<CompetencyRating & { competency: string; anchor: string | null }>;
  /** A board round: the red flags the author ticked; absent when none. */
  redFlagsSeen?: string[];
}

/** An author's latest scorecard on an interview, with the versions before it, oldest first (decision 14). */
export interface ScorecardView extends ScorecardVersionView {
  earlier: ScorecardVersionView[];
}

export interface InterviewRecord extends InterviewRow {
  /** The chosen questions as the prepare page reads them: never a kit question's boards, answer key or starter code. */
  questionsChosen: Array<Pick<KitQuestion, 'id' | 'prompt' | 'competencyId'>>;
  competencies: KitCompetency[];
  scorecards: ScorecardView[];
  /** The opening's questions for this round's type, to choose from (row I1.7). No money, nothing about anyone. */
  bank: Array<{ id: string; prompt: string; competencyId: string; competency: string; hasStarter: boolean }>;
  /** Whether the viewer may choose the questions now (the lead of the round, accepted, not yet live). */
  canPrepare: boolean;
  /** What is still missing before the round is ready, in one plain line; null when nothing is. */
  missing: string | null;
  maxQuestions: number;
  /**
   * Whether the opening has a spending cap (gap audit 2026-11-20 §10). Without one nothing that costs money starts in the
   * round (spend.ts), so the prepare page warns. Only whether one is set, never the amount: the amount stays the money readers'.
   */
  spendingCapSet: boolean;
  /**
   * The seats already booked on another round at an overlapping time (lib/interviews/conflicts.ts): a warning, never a
   * refusal. Drawn from the viewer's own world, so it names no round they could not open, and never a candidate.
   */
  conflicts: SeatConflict[];
}

/** What a candidate's record shows of their résumé (row I1.6): the file itself is read from its own route. */
export interface ResumeSummary { fileName: string; sizeBytes: number; uploadedAt: string; uploadedBy: PersonRef }

/** The candidate as an interviewer reads them on the profile: who they are, never how to reach them or the recruiter's notes. */
export type InterviewerCandidateView = Pick<Candidate, 'id' | 'name' | 'headline' | 'location' | 'source'>;

/** The whole record, for those who may read it (scope.ts mayReadCandidateContact). */
export type FullCandidateView = Pick<Candidate, 'id' | 'name' | 'email' | 'headline' | 'location' | 'source' | 'resumeFileId' | 'notes' | 'createdAt'> & {
  /** What an edit is made against (types.ts candidateVersion): the last edit's time, else when the record was added. */
  version: string;
};

/** Each field is copied by name so a column added to the row never reaches a reader by default. */
export function profileCandidate(c: Candidate, role: string): InterviewerCandidateView | FullCandidateView {
  if (!mayReadCandidateContact(role)) return { id: c.id, name: c.name, headline: c.headline, location: c.location, source: c.source };
  return {
    id: c.id, name: c.name, email: c.email, headline: c.headline, location: c.location, source: c.source,
    resumeFileId: c.resumeFileId, notes: c.notes, createdAt: c.createdAt, version: candidateVersion(c),
  };
}

export interface CandidateRecord {
  /** Narrowed by role: an interviewer gets `InterviewerCandidateView` (no email, notes, résumé id or added date). */
  candidate: InterviewerCandidateView | FullCandidateView;
  /** The current résumé, or null. */
  resume: ResumeSummary | null;
  applications: Array<{
    applicationId: string;
    opening: { id: string; title: string; team: string };
    stage: ApplicationStage;
    /** Each move with who made it by name (null: the candidate's own application). Empty for an interviewer, who never reads the decision or its reason (scope.ts mayReadStageHistory). */
    history: Array<StageChange & { byName: string | null }>;
    /** Each round with the latest scorecards the viewer may read (the world is already scoped: an interviewer reads the others' only once their own is in, scope.ts othersRevealed). */
    interviews: Array<InterviewRow & { results: Array<{ interviewer: PersonRef; recommendation: Recommendation }> }>;
  }>;
}

const OPEN_STATES: ReadonlySet<InterviewState> = new Set(['assigned', 'accepted', 'ready', 'live']);
const DONE_STATES: ReadonlySet<InterviewState> = new Set(['scored', 'reviewed']);

export const UNKNOWN_ROUND = 'Round';

function roundOf(opening: Opening | undefined, roundId: string): KitRound | undefined {
  return opening?.kit.rounds.find((r) => r.id === roundId);
}

/** Every round that went ahead is scored or reviewed, none is still to run or still owes a scorecard, and one waits for a decision. */
export function debriefReady(interviews: readonly Interview[]): boolean {
  const held = interviews.filter((i) => i.state !== 'declined' && i.state !== 'cancelled');
  return held.some((i) => i.state === 'scored') && held.every((i) => DONE_STATES.has(i.state));
}

export function bucketFor(interview: Interview, viewer: Viewer, scorecards: readonly Scorecard[]): Bucket {
  if (interview.state === 'declined' || interview.state === 'cancelled') return 'closed';
  const seat = seatOf(interview, viewer.id);
  // A seat still to answer needs the viewer, whatever the others have done (row I1.4).
  if (seat && isAnswerable(interview.state) && !hasAccepted(interview, viewer.id, seat)) return 'to-accept';
  if (interview.state === 'assigned') return seat ? 'upcoming' : 'to-accept';
  // The lead has accepted and the round is not ready yet: a time and questions to come (rows I1.5, I1.7).
  if (interview.state === 'accepted' && seat === 'lead') return 'to-prepare';
  if (OPEN_STATES.has(interview.state)) return 'upcoming';
  const seated = interview.leadId === viewer.id || interview.panelIds.includes(viewer.id);
  const mineIn = scorecards.some((s) => s.interviewId === interview.id && s.interviewerId === viewer.id);
  // Ended: due until every seat's is in; the viewer whose own is in is done with it (row I5.3).
  if (interview.state === 'ended') return seated && mineIn ? 'done' : 'scorecard-due';
  if (seated && !mineIn) return 'scorecard-due';
  return 'done';
}

/** Indexes over one visible world, built once per request. */
export class WorldIndex {
  readonly openings: Map<string, Opening>;
  readonly candidates: Map<string, Candidate>;
  readonly applications: Map<string, InterviewsWorld['applications'][number]>;
  /** `nowMs` is the tenant's clock (clock.ts); a test passes its own. */
  constructor(readonly world: InterviewsWorld, readonly people: People, readonly viewer: Viewer, readonly nowMs: () => number = interviewsNowMs) {
    this.openings = new Map(world.openings.map((o) => [o.id, o]));
    this.candidates = new Map(world.candidates.map((c) => [c.id, c]));
    this.applications = new Map(world.applications.map((a) => [a.id, a]));
  }

  interviewsOf(applicationId: string): Interview[] {
    return this.world.interviews.filter((i) => i.applicationId === applicationId);
  }

  /** The latest version of each author's scorecard on the interview (the earlier ones are `scorecardViews`). */
  scorecardsOf(interviewId: string): Scorecard[] {
    return latestByAuthor(this.world.scorecards.filter((s) => s.interviewId === interviewId));
  }

  /** The scorecards the viewer may read on an interview, each author's latest with its earlier versions (row I5.3). */
  scorecardViews(interviewId: string, competencies: readonly KitCompetency[]): ScorecardView[] {
    const all = this.world.scorecards.filter((s) => s.interviewId === interviewId);
    const kit = new Map(competencies.map((k) => [k.id, k]));
    // What was rated stays as rated, whatever the round assesses now.
    const view = (s: Scorecard): ScorecardVersionView => ({
      id: s.id, interviewer: this.people(s.interviewerId), recommendation: s.recommendation, summary: s.summary,
      submittedAt: s.submittedAt, version: s.version, correctionReason: s.correctionReason,
      ...(s.redFlagsSeen?.length ? { redFlagsSeen: [...s.redFlagsSeen] } : {}),
      ratings: s.ratings.map((r) => ({ ...r, competency: kit.get(r.competencyId)?.name ?? r.competencyId, anchor: kit.get(r.competencyId)?.anchors[r.rating] ?? null })),
    });
    return latestByAuthor(all).map((s) => ({
      ...view(s),
      earlier: all.filter((e) => e.interviewerId === s.interviewerId && e.version < s.version).sort((a, b) => a.version - b.version).map(view),
    }));
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
    const latest = latestByAuthor(this.world.scorecards.filter((s) => ids.has(s.interviewId))).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
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
      // Every round names what it assesses as read, a round saved before rounds named theirs included (all of them).
      rounds: o.kit.rounds.map((r) => ({ ...r, competencyIds: competencyIdsOfRound(o.kit, r.id) })),
      kitSize: {
        competencies: o.kit.competencies.length,
        questions: { technical: o.kit.questions.filter((q) => q.roundType === 'technical').length, behavioural: o.kit.questions.filter((q) => q.roundType === 'behavioural').length },
      },
      candidates: apps.length,
      byStage,
      upcoming: interviews.filter((i) => OPEN_STATES.has(i.state)).length,
      scorecardsIn: latestByAuthor(this.world.scorecards.filter((s) => interviewIds.has(s.interviewId))).length,
      pipeline: apps.flatMap((a): PipelineEntry[] => {
        const c = this.candidates.get(a.candidateId);
        if (!c) return [];
        return [{
          applicationId: a.id, candidate: { id: c.id, name: c.name, headline: c.headline }, stage: a.stage,
          stageChangedAt: a.history[a.history.length - 1]?.at ?? a.appliedAt,
          nextInterview: this.nextInterview(a.id), lastResult: this.lastResult(a.id),
          scorecardDue: this.interviewsOf(a.id).some((i) => i.state === 'ended'),
          debriefReady: debriefReady(this.interviewsOf(a.id)),
        }];
      }),
    };
  }

  openingRecord(o: Opening): OpeningRecord {
    // The cap is money: only the people who may read the opening's spend (scope.ts mayReadOpeningMoney) are sent it.
    const money = mayReadOpeningMoney(this.viewer.role) ? { budgetCapUsd: o.budgetCapUsd } : {};
    return { ...this.openingRow(o), competencies: o.kit.competencies, questions: o.kit.questions, ...money, revision: o.revision };
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
      state: readyState(i),
      bucket: bucketFor(i, this.viewer, this.world.scorecards),
      seat: i.leadId === this.viewer.id ? 'lead' : i.panelIds.includes(this.viewer.id) ? 'panel' : null,
      questions: i.questionIds.length,
      myScorecard: mine ? { recommendation: mine.recommendation, submittedAt: mine.submittedAt } : null,
      scorecardsIn: cards.length,
      seats: [
        { person: this.people(i.leadId), seat: 'lead' as const, accepted: hasAccepted(i, i.leadId, 'lead') },
        ...i.panelIds.map((p) => ({ person: this.people(p), seat: 'panel' as const, accepted: hasAccepted(i, p, 'panel') })),
      ],
      myAnswer: (() => { const s = seatOf(i, this.viewer.id); return s ? (hasAccepted(i, this.viewer.id, s) ? 'accepted' : 'to-answer') : null; })(),
      declines: reachOf(this.viewer.role) === 'assigned' ? []
        : i.declines.map((d) => ({ person: this.people(d.userId), seat: d.seat, reason: d.reason, at: d.at })),
      cancellation: i.state === 'cancelled' && i.cancellation
        ? { reason: i.cancellation.reason, label: CANCEL_REASON_LABEL[i.cancellation.reason], note: i.cancellation.note, by: this.people(i.cancellation.by), at: i.cancellation.at }
        : null,
      missed: isMissed(i, this.nowMs()),
      revision: i.revision,
    };
  }

  /** The seats of `i` already booked elsewhere at that time, among the rounds this viewer may read. */
  conflictsOf(i: Interview): SeatConflict[] {
    return seatConflicts(i, this.world.interviews, (id) => this.people(id).name);
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
      state: readyState(i),
      bank: questionsOfRound(o.kit, i.roundId, i.type).map((q) => ({
        id: q.id, prompt: q.prompt, competencyId: q.competencyId, competency: names.get(q.competencyId) ?? q.competencyId,
        hasStarter: Object.values(q.starter ?? {}).some((c) => !!c),
      })),
      canPrepare: mayChoose(i, this.viewer.id) && isPreparable(i.state) && hasAccepted(i, i.leadId, 'lead'),
      missing: missingLine(i),
      maxQuestions: MAX_QUESTIONS,
      spendingCapSet: o.budgetCapUsd !== null,
      questionsChosen: i.questionIds.map((q) => o.kit.questions.find((k) => k.id === q)).filter((q): q is KitQuestion => !!q)
        .map((q) => ({ id: q.id, prompt: q.prompt, competencyId: q.competencyId })),
      competencies: competenciesOfRound(o.kit, i.roundId),
      scorecards: this.scorecardViews(i.id, o.kit.competencies),
      conflicts: this.conflictsOf(i),
    };
  }

  candidateRecord(c: Candidate, resume: { fileName: string; sizeBytes: number; uploadedAt: string; uploadedBy: string } | null = null): CandidateRecord {
    return {
      candidate: profileCandidate(c, this.viewer.role),
      resume: resume ? { fileName: resume.fileName, sizeBytes: resume.sizeBytes, uploadedAt: resume.uploadedAt, uploadedBy: this.people(resume.uploadedBy) } : null,
      applications: this.world.applications.filter((a) => a.candidateId === c.id).flatMap((a) => {
        const o = this.openings.get(a.openingId);
        if (!o) return [];
        return [{
          applicationId: a.id, opening: { id: o.id, title: o.title, team: o.team }, stage: a.stage,
          // An interviewer reads no stage history: it carries the hiring decision and its reason (E4 #29).
          history: mayReadStageHistory(this.viewer.role) ? a.history.map((h) => ({ ...h, byName: h.by ? this.people(h.by).name : null })) : [],
          interviews: this.interviewsOf(a.id).flatMap((i) => {
            const row = this.interviewRow(i);
            return row ? [{ ...row, results: this.scorecardsOf(i.id).map((s) => ({ interviewer: this.people(s.interviewerId), recommendation: s.recommendation })) }] : [];
          }),
        }];
      }),
    };
  }
}
