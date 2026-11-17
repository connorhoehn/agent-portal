// The interviews tenant's wire shapes and the words the pages use for them
// (docs/interviews-tenant-plan.md; the server is middleware/src/routes/interviews.ts,
// whose shapes are middleware/src/lib/interviews/views.ts). Pure: no React, so
// `__tests__/interviews.test.ts` runs under plain `node --test`.

export const INTERVIEWS_API = '/api/interviews';

export type ApplicationStage = 'applied' | 'screening' | 'interviewing' | 'debrief' | 'offer' | 'hired' | 'on-hold' | 'rejected' | 'withdrawn';
export type InterviewState = 'assigned' | 'accepted' | 'ready' | 'live' | 'ended' | 'scored' | 'reviewed' | 'declined' | 'cancelled';
export type Recommendation = 'strong-no' | 'no' | 'yes' | 'strong-yes';
export type RoundType = 'technical' | 'behavioural';
export type Bucket = 'to-accept' | 'to-prepare' | 'upcoming' | 'scorecard-due' | 'done' | 'closed';
export type ChipTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'caution' | 'accent';

export interface PersonRef { id: string; name: string }
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
  scorecardDue: boolean;
}

export interface OpeningRow {
  id: string;
  title: string;
  level: string;
  team: string;
  location: string;
  state: 'open' | 'paused' | 'closed';
  openedAt: string;
  hiringManager: PersonRef | null;
  recruiter: PersonRef;
  rounds: Array<{ id: string; name: string; type: RoundType; minutes: number }>;
  candidates: number;
  byStage: Partial<Record<ApplicationStage, number>>;
  upcoming: number;
  scorecardsIn: number;
  pipeline: PipelineEntry[];
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
  seat: 'lead' | 'panel' | null;
  questions: number;
  myScorecard: { recommendation: Recommendation; submittedAt: string } | null;
  scorecardsIn: number;
  /** Each seat held now, the lead first, and whether its holder accepted (row I1.4). */
  seats: Array<{ person: PersonRef; seat: 'lead' | 'panel'; accepted: boolean }>;
  /** The viewer's own seat: still to answer, or accepted; null without a seat. */
  myAnswer: 'to-answer' | 'accepted' | null;
  /** Who declined and why; the recruiter and the hiring manager read them, an interviewer gets none. */
  declines: Array<{ person: PersonRef; seat: 'lead' | 'panel'; reason: string; at: string }>;
  /** The revision a write names. */
  revision: number;
}

export interface ItemsResponse<T> { items: T[] }

/** One move of an application between stages; `byName` is null for the candidate's own application. */
export interface StageMove { stage: ApplicationStage; at: string; by: string | null; byName: string | null; reason: string | null }
export interface RoundResult { interviewer: PersonRef; recommendation: Recommendation }
export interface ProfileRound extends InterviewRow { results: RoundResult[] }
export interface ProfileApplication {
  applicationId: string;
  opening: { id: string; title: string; team: string };
  stage: ApplicationStage;
  history: StageMove[];
  interviews: ProfileRound[];
}
/** GET /api/interviews/candidates/:id. */
export interface CandidateProfile {
  candidate: { id: string; name: string; email: string; headline: string; location: string; source: string; createdAt: string };
  applications: ProfileApplication[];
}

/** Where a candidate's profile lives. */
export const candidateHref = (id: string): string => `/interviews/candidates/${encodeURIComponent(id)}`;

// ── words ────────────────────────────────────────────────────────────────────

export const STAGE_ORDER: readonly ApplicationStage[] = ['applied', 'screening', 'interviewing', 'debrief', 'offer', 'hired', 'on-hold', 'rejected', 'withdrawn'];

export const STAGE_LABELS: Readonly<Record<ApplicationStage, string>> = {
  applied: 'Applied', screening: 'Screening', interviewing: 'Interviewing', debrief: 'Debrief', offer: 'Offer',
  hired: 'Hired', 'on-hold': 'On hold', rejected: 'Not moving forward', withdrawn: 'Withdrew',
};

export function stageTone(stage: ApplicationStage): ChipTone {
  switch (stage) {
    case 'interviewing': return 'info';
    case 'debrief': case 'offer': return 'accent';
    case 'hired': return 'success';
    case 'on-hold': return 'caution';
    case 'rejected': case 'withdrawn': return 'neutral';
    default: return 'neutral';
  }
}

export const RECOMMENDATION_LABELS: Readonly<Record<Recommendation, string>> = {
  'strong-no': 'Strong no', no: 'No', yes: 'Yes', 'strong-yes': 'Strong yes',
};

export function recommendationTone(r: Recommendation): ChipTone {
  return r === 'strong-yes' || r === 'yes' ? 'success' : r === 'no' ? 'caution' : 'danger';
}

export const ROUND_TYPE_LABELS: Readonly<Record<RoundType, string>> = { technical: 'Technical', behavioural: 'Behavioural' };

/** The stages a candidate moves through, in order; the other three end or pause the path. */
export const STAGE_PATH: readonly ApplicationStage[] = ['applied', 'screening', 'interviewing', 'debrief', 'offer', 'hired'];

export interface StageStep { step: number; label: string; done: boolean; active: boolean; description: string }

/**
 * The tracker's steps. The path always shows in order, the current stage marked
 * and the ones reached before it done; a candidate on hold, not moving forward
 * or withdrawn gets that stage as the last, active step after what they reached.
 * `when` words a timestamp ("3 days ago").
 */
export function stageSteps(stage: ApplicationStage, history: ReadonlyArray<Pick<StageMove, 'stage' | 'at'>>, when: (iso: string) => string): StageStep[] {
  const reachedAt = (s: ApplicationStage) => history.filter((h) => h.stage === s).map((h) => h.at).sort().pop();
  const onPath = STAGE_PATH.includes(stage);
  const labels = onPath ? STAGE_PATH : [...STAGE_PATH.filter((s) => reachedAt(s)), stage];
  const current = labels.indexOf(stage);
  return labels.map((s, i) => {
    const at = reachedAt(s);
    return { step: i + 1, label: STAGE_LABELS[s], done: i < current && (onPath ? true : !!at), active: i === current, description: at ? when(at) : '' };
  });
}

/** What a round is waiting for, in words. */
export function roundStatus(state: InterviewState): { label: string; tone: ChipTone } {
  switch (state) {
    case 'assigned': return { label: 'To accept', tone: 'warning' };
    case 'accepted': return { label: 'Accepted', tone: 'info' };
    case 'ready': return { label: 'Scheduled', tone: 'info' };
    case 'live': return { label: 'In progress', tone: 'info' };
    case 'ended': return { label: 'Scorecard due', tone: 'caution' };
    case 'scored': case 'reviewed': return { label: 'Done', tone: 'success' };
    case 'declined': return { label: 'Declined', tone: 'neutral' };
    default: return { label: 'Cancelled', tone: 'neutral' };
  }
}

/** What an interview on the viewer's desk is waiting for, in their words. */
export function deskLabel(row: Pick<InterviewRow, 'bucket' | 'state' | 'seat'>): string {
  if (row.bucket === 'to-accept') return row.seat === 'panel' ? 'Panel: accept or decline' : 'Accept or decline';
  if (row.bucket === 'to-prepare') return 'Choose questions';
  if (row.bucket === 'scorecard-due') return 'Scorecard due';
  if (row.bucket === 'done') return 'Scorecard in';
  if (row.bucket === 'closed') return row.state === 'declined' ? 'Declined' : 'Cancelled';
  if (row.state === 'live') return 'In progress';
  if (row.seat === 'panel') return 'On the panel';
  return row.state === 'ready' ? 'Prepared' : 'Choose questions';
}

export function deskTone(row: Pick<InterviewRow, 'bucket' | 'state'>): ChipTone {
  if (row.bucket === 'to-accept') return 'warning';
  if (row.bucket === 'to-prepare') return 'accent';
  if (row.bucket === 'scorecard-due') return 'caution';
  if (row.bucket === 'done') return 'success';
  if (row.bucket === 'closed') return 'neutral';
  return row.state === 'ready' || row.state === 'live' ? 'info' : 'neutral';
}

/** The desk's order: what needs the viewer first, then what is coming up by time, then what is done. */
const BUCKET_RANK: Readonly<Record<Bucket, number>> = { 'to-accept': 0, 'scorecard-due': 1, 'to-prepare': 2, upcoming: 3, done: 4, closed: 5 };
export function deskOrder(a: InterviewRow, b: InterviewRow): number {
  return BUCKET_RANK[a.bucket] - BUCKET_RANK[b.bucket]
    || (a.bucket === 'done' ? (b.scheduledAt ?? '').localeCompare(a.scheduledAt ?? '') : (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? ''));
}

export type DeskView = 'open' | Bucket;
export const DESK_VIEWS: ReadonlyArray<{ value: DeskView; label: string }> = [
  { value: 'open', label: 'Needs me or coming up' },
  { value: 'to-accept', label: 'To accept' },
  { value: 'to-prepare', label: 'To prepare' },
  { value: 'upcoming', label: 'Upcoming' },
  { value: 'scorecard-due', label: 'Scorecards due' },
  { value: 'done', label: 'Done' },
];
export function inDeskView(row: InterviewRow, view: DeskView): boolean {
  // "Upcoming" is a round the viewer has accepted and that has a time (row I1.5).
  if (view === 'upcoming') return (row.state === 'accepted' || row.state === 'ready') && row.scheduledAt !== null && (row.bucket === 'upcoming' || row.bucket === 'to-prepare');
  return view === 'open' ? row.bucket === 'to-accept' || row.bucket === 'to-prepare' || row.bucket === 'upcoming' || row.bucket === 'scorecard-due' : row.bucket === view;
}

// ── time ─────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Midnight of the instant's calendar day, in `timeZone` (the viewer's own when omitted). */
function dayKey(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * When an interview is, the way a person says it: "Today 14:00", "Tomorrow
 * 10:00", "Yesterday 16:00", else "Thu 19 Nov, 09:30". 24-hour clock, the
 * viewer's own time zone unless one is given (tests pin one).
 */
export function whenLabel(iso: string | null, nowMs: number = Date.now(), timeZone?: string): string {
  if (!iso) return 'No time set';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'No time set';
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  const day = dayKey(ms, timeZone);
  if (day === dayKey(nowMs, timeZone)) return `Today ${time}`;
  if (day === dayKey(nowMs + DAY_MS, timeZone)) return `Tomorrow ${time}`;
  if (day === dayKey(nowMs - DAY_MS, timeZone)) return `Yesterday ${time}`;
  const date = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(ms));
  return `${date.replace(',', '')}, ${time}`;
}

/** "Coding with Hugo Marchetti, tomorrow 10:00" — the next interview in one line. */
export function nextInterviewLine(next: InterviewBrief | null, nowMs: number = Date.now(), timeZone?: string): string {
  if (!next) return '';
  return `${next.roundName} · ${whenLabel(next.scheduledAt, nowMs, timeZone)}`;
}

/** "Yes · Coding" — the last result in one line. */
export function lastResultLine(r: ResultBrief | null): string {
  return r ? `${RECOMMENDATION_LABELS[r.recommendation]} · ${r.roundName}` : '';
}

/** "Interviewing 2 · Debrief 1 · Screening 1" — candidates by stage, in the stage order, zeros left out. */
export function byStageLine(byStage: Partial<Record<ApplicationStage, number>>): string {
  return STAGE_ORDER.filter((s) => (byStage[s] ?? 0) > 0).map((s) => `${STAGE_LABELS[s]} ${byStage[s]}`).join(' · ');
}

/** Search across the words a row shows (candidate, opening, team, stage, round, interviewer). */
export function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

/** The viewer's own zone, named: "Europe/London", else "UTC". */
export function zoneName(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** A time in the viewer's own zone with the zone's short name: "Thu 4 Mar, 15:30 GMT". "No time set" for none. */
export function whenWithZone(iso: string | null, nowMs: number = Date.now(), timeZone?: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return 'No time set';
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' }).formatToParts(new Date(iso)).find((p) => p.type === 'timeZoneName')?.value ?? zoneName();
  return `${whenLabel(iso, nowMs, timeZone)} ${zone}`;
}

/** Upcoming's order: by time, rounds without a time last, then by candidate. */
export function upcomingOrder(a: Pick<InterviewRow, 'scheduledAt' | 'candidate'>, b: Pick<InterviewRow, 'scheduledAt' | 'candidate'>): number {
  if (!a.scheduledAt !== !b.scheduledAt) return a.scheduledAt ? -1 : 1;
  return (a.scheduledAt ?? '').localeCompare(b.scheduledAt ?? '') || a.candidate.name.localeCompare(b.candidate.name);
}

/** Rounds the recruiter may still time: not started, not closed. */
export const isTimeable = (state: InterviewState): boolean => state === 'assigned' || state === 'accepted' || state === 'ready';
