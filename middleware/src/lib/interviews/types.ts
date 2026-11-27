// The interviews tenant's model (docs/interviews-tenant-plan.md, "The model").
//
// Phase 0 reads openings (with their kit), candidates, applications,
// interviews and scorecards. Consents, the suggestion log, the pad log, runs
// and the deletion log are later rows; the fields that will point at them
// (`callId`, a scorecard's `version` and
// `changedAfterRecap`) are here already so those rows add tables, not
// reshapes. The table behind each record is schema/interviews_schema.sql.

export const INTERVIEWS_TENANT = 'interviews';

/** Technical rounds get the code pad (a later row); behavioural rounds never do. */
export type RoundType = 'technical' | 'behavioural';
export const ROUND_TYPES: readonly RoundType[] = ['technical', 'behavioural'];

export type OpeningState = 'open' | 'paused' | 'closed';
export const OPENING_STATES: readonly OpeningState[] = ['open', 'paused', 'closed'];

/** Where an application stands. `on-hold` is the hiring manager's "hold" (decision 15). */
export type ApplicationStage = 'applied' | 'screening' | 'interviewing' | 'debrief' | 'offer' | 'hired' | 'on-hold' | 'rejected' | 'withdrawn';
export const APPLICATION_STAGES: readonly ApplicationStage[] = ['applied', 'screening', 'interviewing', 'debrief', 'offer', 'hired', 'on-hold', 'rejected', 'withdrawn'];

/**
 * An interview's state (the plan's model): `assigned → accepted → ready → live → ended → scored → reviewed`,
 * or `declined` / `cancelled`. `ready` is accepted with a time set and questions chosen; `scored` is every
 * panel member's scorecard submitted.
 */
export type InterviewState = 'assigned' | 'accepted' | 'ready' | 'live' | 'ended' | 'scored' | 'reviewed' | 'declined' | 'cancelled';
export const INTERVIEW_STATES: readonly InterviewState[] = ['assigned', 'accepted', 'ready', 'live', 'ended', 'scored', 'reviewed', 'declined', 'cancelled'];

/** A person's go or no-go on a scorecard. Milo never produces one (decision 6). */
export type Recommendation = 'strong-no' | 'no' | 'yes' | 'strong-yes';
export const RECOMMENDATIONS: readonly Recommendation[] = ['strong-no', 'no', 'yes', 'strong-yes'];

/** Languages a question may carry starter code in (decision 11). */
export type PadLanguage = 'python' | 'swift' | 'javascript' | 'typescript' | 'java' | 'go' | 'cpp';
export const PAD_LANGUAGES: readonly PadLanguage[] = ['python', 'swift', 'javascript', 'typescript', 'java', 'go', 'cpp'];

/**
 * What a technical round works on (WHITEBOARD-PLAN step 1): the shared code pad, or the shared whiteboard (a system
 * design round). A kit saved before the board existed has no `surface`; its technical rounds read as 'pad'
 * (kit.ts roundSurface). A behavioural round has neither.
 */
export type RoundSurface = 'pad' | 'board';
export const ROUND_SURFACES: readonly RoundSurface[] = ['pad', 'board'];

export interface KitRound {
  id: string;
  name: string;
  type: RoundType;
  minutes: number;
  /** A technical round's surface; absent on behavioural rounds and on kits saved before the board. */
  surface?: RoundSurface;
  /**
   * The line the interviewer reads to the candidate when the round starts. Absent: a technical round reads the default
   * (kit.ts `roundIntro`: how to ask Milo for help), a behavioural round has none.
   */
  intro?: string;
  /**
   * The competencies this round assesses, by id, in any order (the kit's order is the one shown). Every screen that
   * lists a round's competencies reads them through `competenciesOfRound` (kit.ts). Absent on a kit saved before rounds
   * named theirs: such a round assesses every competency of the kit, as it did then; the next save writes the list.
   */
  competencyIds?: string[];
}

/**
 * A starting board for a board round's question: an Excalidraw scene's elements, kept as the library's binding
 * writes them (realtime-modules adapters/excalidraw `DiagramElement`). The kit checks its shape and size only
 * (kit.ts checkBoard); the room inserts it as one write when the lead picks the question.
 */
export interface KitBoard {
  /** The board's short name, shown beside the question, e.g. "Frames with starter notes". */
  name: string;
  elements: Array<Record<string, unknown>>;
}

/**
 * One competency: what good looks like (the coach reads it, I3.3) and what each rating means (the
 * scorecard rates against the anchors, I5.3). Its id is stable across edits, so a rating, a
 * suggestion or a recap keeps pointing at it when the name is reworded.
 */
export interface KitCompetency {
  id: string;
  name: string;
  /** One or two sentences on what a strong answer shows. */
  lookFor: string;
  anchors: { 1: string; 2: string; 3: string; 4: string };
}

/**
 * One question in the bank, asked in rounds of `roundType`. A technical question may carry starter
 * code per pad language (the pad inserts it, I4.2); a behavioural one never does (its round has no
 * pad, row I1.8). Its id is stable, so an interview's chosen questions keep pointing at it.
 */
export interface KitQuestion {
  id: string;
  prompt: string;
  /** What to ask next if the answer stays general, in the order to ask them. */
  followUps: string[];
  /** The competency this question gathers evidence for. */
  competencyId: string;
  roundType: RoundType;
  starter?: Partial<Record<PadLanguage, string>>;
  /** A technical question's starting board, for a board round (WHITEBOARD-PLAN step 2). */
  board?: KitBoard;
  /**
   * A system design question's clarifying questions: what a strong candidate asks before drawing (who uses it, scale,
   * the read/write mix, latency, consistency). The coach suggests one to the lead when none was asked early in a board
   * round (coach/clarifying.ts). Technical questions only; absent when there are none.
   */
  clarifying?: string[];
  // ── the answer key (the master template's part C): the interviewer's, never the candidate's ──
  // These three are read by the lead, the panel and the kit's editors only. Every payload a candidate can reach (the
  // guest's routes, the board document, Milo's tools in the call) carries a question through answer-key.ts
  // candidateQuestion, which keeps only the fields it names, so a field added here stays off the candidate's side.
  /** The reference design, a board scene like `board`: shown in the lead's and panel's "Provided design" tab, and put on the shared board only when the lead reveals it. */
  providedDesign?: KitBoard;
  /** The numbered "Please answer the following questions", each with the interviewer's short answer; the last may be the enhancement that changes the diagram. */
  designQuestions?: KitDesignQuestion[];
  /** What a weak design shows, grouped: the lead's unchecked checklist on the scorecard (never auto-scored). */
  redFlags?: KitRedFlag[];
}

export const RED_FLAG_GROUPS = ['over-engineering', 'responsibility', 'naming', 'other'] as const;
export type RedFlagGroup = typeof RED_FLAG_GROUPS[number];
export interface KitRedFlag { group: RedFlagGroup; text: string }
export interface KitDesignQuestion {
  text: string;
  /** The interviewer's answer (answer key). */
  answer?: string;
  /** The last question only: the enhancement that makes the candidate update the diagram. */
  enhancement?: true;
}

/** An opening's kit: its rounds, the competencies they judge and the question bank, each list in the order shown. */
export interface OpeningKit {
  rounds: KitRound[];
  competencies: KitCompetency[];
  questions: KitQuestion[];
}

export interface Opening {
  id: string;
  title: string;
  level: string;
  team: string;
  location: string;
  /** The app user who decides this opening's candidates; null while the opening has no hiring manager named. */
  hiringManagerId: string | null;
  recruiterId: string;
  state: OpeningState;
  openedAt: string;
  kit: OpeningKit;
  /**
   * The opening's spending cap in US dollars, across all its interviews (row I0.6; lib/interviews/spend.ts). Null: no cap
   * is set, and nothing that costs money starts in its interviews until the recruiter sets one.
   */
  budgetCapUsd: number | null;
  /** The cap per interview in US dollars; null takes the deployment's default (`INTERVIEWS_INTERVIEW_CAP_USD`). */
  interviewCapUsd: number | null;
  /** Bumped by every write; a write names the revision it was made against, so two editors never overwrite each other unseen. */
  revision: number;
}

/** What "edit its details" changes on an opening (row I1.3); the kit is replaced on its own. */
export type OpeningDetails = Pick<Opening, 'title' | 'level' | 'team' | 'location' | 'hiringManagerId' | 'state' | 'budgetCapUsd' | 'interviewCapUsd'>;

/** A candidate is a record, never a user (decision 3). */
export interface Candidate {
  id: string;
  name: string;
  email: string;
  /** Their current role, as the résumé gives it. */
  headline: string;
  location: string;
  source: string;
  /** The uploaded résumé (row I1.6); null until then. */
  resumeFileId: string | null;
  notes: string;
  createdAt: string;
  /**
   * When the recruiter last edited the name, email, headline or location (gap audit 2026-11-20 §6); absent until the
   * first edit, in both stores. An edit is a compare-and-set on `updatedAt ?? createdAt` (store.ts updateCandidate).
   */
  updatedAt?: string;
}

/** The fields the recruiter edits on a candidate's profile (routes/interviews/candidates.ts checkCandidateEdit). */
export interface CandidateEdit { name: string; email: string; headline: string; location: string }

/** The stamp an edit is made against: the last edit, or the record's creation before there was one. */
export const candidateVersion = (c: Pick<Candidate, 'createdAt' | 'updatedAt'>): string => c.updatedAt ?? c.createdAt;

export interface StageChange {
  stage: ApplicationStage;
  at: string;
  /** Who moved it; null for the candidate's own application. */
  by: string | null;
  reason: string | null;
}

export interface Application {
  id: string;
  candidateId: string;
  openingId: string;
  stage: ApplicationStage;
  appliedAt: string;
  history: StageChange[];
}

/** A seat on an interview (decision 20): the one lead, or one of up to two panel members. */
export type Seat = 'lead' | 'panel';

/** The person in a seat accepted it (row I1.4). Only the seats held now carry one: a reassignment drops the rest. */
export interface SeatAcceptance {
  userId: string;
  seat: Seat;
  at: string;
}

/**
 * The person in a seat declined it, with their reason (row I1.4). Kept across reassignments so the
 * recruiter and the hiring manager can read who declined and why; another interviewer never does.
 */
export interface SeatDecline {
  userId: string;
  seat: Seat;
  reason: string;
  at: string;
}

/**
 * Why a round was cancelled (gap audit 2026-11-20, section 1). The recruiter picks one of the first five on Cancel; the
 * lead or the recruiter picks `no_show` or `did_not_take_place` on "Did not take place"; `candidate_withdrew` is
 * written when the recruiter marks the application withdrawn. lib/interviews/cancel.ts holds the rules.
 */
export type CancelReason = 'candidate_unavailable' | 'interviewer_unavailable' | 'rescheduling' | 'opening_closed' | 'other'
  | 'no_show' | 'did_not_take_place' | 'candidate_withdrew';
export const CANCEL_REASONS: readonly CancelReason[] = ['candidate_unavailable', 'interviewer_unavailable', 'rescheduling', 'opening_closed', 'other',
  'no_show', 'did_not_take_place', 'candidate_withdrew'];

/** Who cancelled a round, when, why, and the optional note (at most 280 characters). */
export interface Cancellation {
  reason: CancelReason;
  note: string | null;
  by: string;
  at: string;
}

/**
 * The candidate's "I can't make this time" (gap audit 2026-11-20 §6; lib/interviews/cant-make.ts): when they said it and
 * their own words, trimmed, or null. Nothing else: the round keeps its time and state, and the recruiter decides.
 */
export interface CantMakeNotice { at: string; note: string | null }

export interface Interview {
  id: string;
  applicationId: string;
  roundId: string;
  type: RoundType;
  leadId: string;
  /** Up to two more panel members (decision 20). */
  panelIds: string[];
  /** When it is set to start; null until the recruiter sets a time. */
  scheduledAt: string | null;
  minutes: number;
  state: InterviewState;
  /** Question ids chosen from the opening's kit. */
  questionIds: string[];
  assignedBy: string;
  assignedAt: string;
  /** The invite link's token hash (row I2.1); null until one is issued. */
  /** The call this interview runs in (row I2.2); null until then. */
  callId: string | null;
  /** When the lead started it (moved it to live); absent before, and on rows written before this was kept. */
  startedAt?: string | null;
  /** When the call ended; null before. */
  endedAt: string | null;
  /** Who accepted the seat they hold now (row I1.4). The lead's acceptance is also the move to `accepted`. */
  acceptances: SeatAcceptance[];
  /** Every decline, oldest first, kept across reassignments (row I1.4). */
  declines: SeatDecline[];
  /** Set when the round moves to `cancelled` (lib/interviews/cancel.ts); absent on every other round. */
  cancellation?: Cancellation | null;
  /** The candidate's notice that they cannot make the time (cant-make.ts); absent while there is none. Rescheduling, cancelling, the recruiter's clear and erasure remove it. */
  cantMake?: CantMakeNotice | null;
  /** Bumped by every write; a write names the revision it was made against (store.ts "Writes"). */
  revision: number;
}

export interface CompetencyRating {
  competencyId: string;
  rating: 1 | 2 | 3 | 4;
  note: string;
}

export interface Scorecard {
  id: string;
  interviewId: string;
  interviewerId: string;
  ratings: CompetencyRating[];
  recommendation: Recommendation;
  summary: string;
  submittedAt: string;
  /** A submitted scorecard is never edited; a correction is a new version with a reason (decision 14). */
  version: number;
  /** Whether a rating changed after the interviewer opened Milo's recap (decision 14). */
  changedAfterRecap: boolean;
  /** Why this version corrects the one before it (row I5.3); null on a first version. */
  correctionReason: string | null;
  /** A board round with red flags: the ones the author ticked (scorecard.ts); absent when none. Never scored. */
  redFlagsSeen?: string[];
}

/** Everything the phase 0 reads look at, as one snapshot from the store. */
export interface InterviewsWorld {
  openings: Opening[];
  candidates: Candidate[];
  applications: Application[];
  interviews: Interview[];
  scorecards: Scorecard[];
}
