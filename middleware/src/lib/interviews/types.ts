// The interviews tenant's model (docs/interviews-tenant-plan.md, "The model").
//
// Phase 0 reads openings (with their kit), candidates, applications,
// interviews and scorecards. Consents, the suggestion log, the pad log, runs
// and the deletion log are later rows; the fields that will point at them
// (`inviteTokenHash`, `callId`, a scorecard's `version` and
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

export interface KitRound {
  id: string;
  name: string;
  type: RoundType;
  minutes: number;
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
}

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
  inviteTokenHash: string | null;
  /** The call this interview runs in (row I2.2); null until then. */
  callId: string | null;
  /** When the call ended; null before. */
  endedAt: string | null;
  /** Who accepted the seat they hold now (row I1.4). The lead's acceptance is also the move to `accepted`. */
  acceptances: SeatAcceptance[];
  /** Every decline, oldest first, kept across reassignments (row I1.4). */
  declines: SeatDecline[];
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
}

/** Everything the phase 0 reads look at, as one snapshot from the store. */
export interface InterviewsWorld {
  openings: Opening[];
  candidates: Candidate[];
  applications: Application[];
  interviews: Interview[];
  scorecards: Scorecard[];
}
