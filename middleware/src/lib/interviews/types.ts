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

export interface KitRound {
  id: string;
  name: string;
  type: RoundType;
  minutes: number;
}

/** One competency and what each rating means for it (1 to 4). */
export interface KitCompetency {
  id: string;
  name: string;
  anchors: { 1: string; 2: string; 3: string; 4: string };
}

export interface KitQuestion {
  id: string;
  prompt: string;
  competencyId: string;
  roundType: RoundType;
  starter?: Partial<Record<PadLanguage, string>>;
}

/** An opening's kit: its rounds, the competencies they judge and the question bank. */
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
  /** Spend cap per interview in US dollars; how it is held is row I0.6. */
  budgetCapUsd: number | null;
}

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
