// The interviews tenant's seed story (docs/interviews-tenant-plan.md, "Cast").
//
// One hiring desk in the mock world. Greta Lindqvist recruits for three
// openings: a senior backend engineer for Payments and an engineering manager
// for Platform, both Amara Okafor's to decide, and an iOS engineer for Mobile
// Checkout whose hiring manager is not named yet (so only the recruiter sees
// it, which is what the hiring manager's scope is walked against). Hugo
// Marchetti interviews the backend and system design rounds, Wen Zhao the iOS
// and behavioural ones. Twelve candidates across the stages, six interviews
// coming up, four finished with scorecards and one finished yesterday whose
// scorecard is still due.
//
// Live: the tables in schema/interviews_schema.sql (DDL only, the assessment
// pattern: these registered fixtures ARE the seed, checked against the DDL by
// the shape table in mock/core/parity/shape-entities.ts). Every instant is
// relative to the mock clock and computed on read, so "tomorrow at 10:00" is
// always tomorrow. `POST /api/__mock/reset` restores every row.
//
// Candidates are records, never users (decision 3); the four cast users are in
// providers/identity.ts FALLBACK_USERS with a grant only in `interviews`.

import { clock, defineFixture } from './core/index.js';
import { EM_KIT } from './interviews-behavioural.js';
import { seededResumeFileId } from './interviews-resumes.js';
import type {
  Application, ApplicationStage, Candidate, CompetencyRating, Interview, InterviewState, Opening, OpeningKit, Scorecard, StageChange,
} from '../lib/interviews/types.js';

const DAY_MS = 86_400_000;

/**
 * `days` from today's UTC midnight, at `hour:minute` UTC. Negative days are in the past. The seed keeps every
 * interview between 13:00 and 18:00 UTC: a working afternoon in Europe and a working morning on the US east coast.
 */
function at(days: number, hour: number, minute = 0): string {
  const now = clock.now().getTime();
  const midnight = now - (now % DAY_MS);
  return new Date(midnight + days * DAY_MS + (hour * 60 + minute) * 60_000).toISOString();
}

/** The round that is live now: Kwame's coding round with Hugo and Wen, started twelve minutes ago by the mock clock. */
export const LIVE_INTERVIEW_ID = 'iv-s4e8u2zk';
export const liveStart = (): string => new Date(clock.now().getTime() - 12 * 60_000).toISOString();

export const GRETA = 'u-greta';
export const HUGO = 'u-hugo';
export const WEN = 'u-wen';
export const AMARA = 'u-amara';

// ── openings and their kits ──────────────────────────────────────────────────
// The Engineering Manager's kit, a behavioural one (row I1.8), is in interviews-behavioural.ts.

const anchors = (one: string, two: string, three: string, four: string) => ({ 1: one, 2: two, 3: three, 4: four });

const COMMUNICATION = {
  id: 'communication', name: 'Communication',
  lookFor: 'Explains their thinking as they go, checks the listener is with them, and says plainly what they do not know.',
  anchors: anchors('Hard to follow even when prompted.', 'Gets the point across with help.', 'Clear and structured; checks they were understood.', 'Explains trade-offs so others can decide with them.'),
};

const BACKEND_KIT: OpeningKit = {
  rounds: [
    { id: 'rd-coding', name: 'Coding', type: 'technical', minutes: 60 },
    { id: 'rd-design', name: 'System design', type: 'technical', minutes: 60 },
    { id: 'rd-together', name: 'Working together', type: 'behavioural', minutes: 45 },
  ],
  competencies: [
    { id: 'problem-solving', name: 'Problem solving', lookFor: 'Breaks the problem down out loud, picks an approach for a reason and tests it against the edges before calling it done.',
      anchors: anchors('Did not reach a working approach.', 'Reached an approach with heavy hints.', 'Found a working approach and tested its edges.', 'Found it quickly and improved on it unprompted.') },
    { id: 'code-quality', name: 'Code quality', lookFor: 'Names things clearly, handles the failure paths and writes the test that would have caught the bug.',
      anchors: anchors('Code would not pass review.', 'Works, but hard to change.', 'Readable, tested where it matters.', 'Code a teammate would happily extend.') },
    { id: 'system-design', name: 'System design', lookFor: 'Starts from the requirements, names the failure modes and says what the design costs to run.',
      anchors: anchors('No coherent design.', 'A design with gaps in failure handling.', 'A sound design with failure modes covered.', 'Covers failure, cost and how it would be rolled out.') },
    COMMUNICATION,
    { id: 'collaboration', name: 'Collaboration', lookFor: 'Talks about other people\'s work specifically and changes course when someone has a better idea.',
      anchors: anchors('Works around people rather than with them.', 'Cooperates when asked.', 'Seeks input and shares credit.', 'Makes the people around them better.') },
  ],
  questions: [
    {
      id: 'q-be-ratelimit', competencyId: 'problem-solving', roundType: 'technical',
      prompt: 'Implement a token-bucket rate limiter that allows bursts of up to N requests and refills at R tokens per second.',
      followUps: ['What happens when two requests arrive in the same instant?', 'How would this work across several servers?'],
      starter: {
        python: 'class RateLimiter:\n    def __init__(self, capacity: int, refill_per_second: float):\n        pass\n\n    def allow(self, now: float) -> bool:\n        pass\n',
        go: 'type RateLimiter struct{}\n\nfunc NewRateLimiter(capacity int, refillPerSecond float64) *RateLimiter {\n\treturn &RateLimiter{}\n}\n\nfunc (r *RateLimiter) Allow(now float64) bool {\n\treturn false\n}\n',
        java: 'class RateLimiter {\n    RateLimiter(int capacity, double refillPerSecond) {}\n\n    boolean allow(double now) {\n        return false;\n    }\n}\n',
      },
    },
    {
      id: 'q-be-retry', competencyId: 'code-quality', roundType: 'technical',
      prompt: 'Wrap a flaky payment-provider call with retries, exponential backoff and an idempotency key, so that a retried charge is never taken twice.',
      followUps: ['How long do you keep an idempotency key, and why that long?', 'What do you log so support can trace one charge?'],
      starter: {
        python: 'def charge_with_retry(provider, amount_cents: int, card_token: str) -> str:\n    pass\n',
        typescript: 'export async function chargeWithRetry(provider: Provider, amountCents: number, cardToken: string): Promise<string> {\n  throw new Error("not implemented");\n}\n',
      },
    },
    {
      id: 'q-be-ledger', competencyId: 'system-design', roundType: 'technical',
      prompt: 'Design the write path for a double-entry ledger that records card captures and refunds, survives a region failover and never loses or duplicates an entry.',
      followUps: ['What happens when the failover lands in the middle of a write?', 'How would you prove no entry was written twice?'],
    },
    {
      id: 'q-be-reconcile', competencyId: 'system-design', roundType: 'technical',
      prompt: 'Every night our ledger and the card network\'s settlement file disagree on a few hundred rows. Design the reconciliation job.',
      followUps: ['Which differences do you fix automatically, and which go to a person?', 'How do you know the job itself did not miss rows?'],
    },
    {
      id: 'q-be-incident', competencyId: 'communication', roundType: 'behavioural',
      prompt: 'Tell me about an incident you led from detection to the write-up. What changed afterwards?',
      followUps: ['How did you decide who to bring in?', 'What did the write-up change that is still in place?'],
    },
    {
      id: 'q-be-disagree', competencyId: 'collaboration', roundType: 'behavioural',
      prompt: 'Describe a time you disagreed with a technical decision your team had already made. What did you do?',
      followUps: ['How did you raise it, and with whom?', 'What happened afterwards?'],
    },
  ],
};

const IOS_KIT: OpeningKit = {
  rounds: [
    { id: 'rd-coding', name: 'Coding', type: 'technical', minutes: 60 },
    { id: 'rd-together', name: 'Working together', type: 'behavioural', minutes: 45 },
  ],
  competencies: [
    { id: 'problem-solving', name: 'Problem solving', lookFor: 'Breaks the problem down out loud, picks an approach for a reason and tests it against the edges before calling it done.',
      anchors: anchors('Did not reach a working approach.', 'Reached an approach with heavy hints.', 'Found a working approach and tested its edges.', 'Found it quickly and improved on it unprompted.') },
    { id: 'swift', name: 'Swift and SwiftUI', lookFor: 'Uses the type system and concurrency on purpose, and knows what the frameworks do behind the scenes.',
      anchors: anchors('Unfamiliar with the language.', 'Writes Swift, fights the frameworks.', 'Idiomatic Swift, comfortable with concurrency.', 'Knows where the frameworks bite and why.') },
    { id: 'app-architecture', name: 'App architecture', lookFor: 'Keeps state in one place, separates the view from the data, and plans for offline and failure.',
      anchors: anchors('State scattered through views.', 'Some separation, leaks under change.', 'Clear layers; state is testable.', 'Designs for offline, paging and failure from the start.') },
    COMMUNICATION,
  ],
  questions: [
    {
      id: 'q-ios-feed', competencyId: 'app-architecture', roundType: 'technical',
      prompt: 'Build a paginated list that loads the next page as the user nears the end, and keeps the loaded pages when the app goes offline.',
      followUps: ['How do you avoid loading the same page twice?', 'What does the user see while offline?'],
      starter: { swift: 'struct FeedView: View {\n    var body: some View {\n        List {\n        }\n    }\n}\n' },
    },
    {
      id: 'q-ios-debounce', competencyId: 'swift', roundType: 'technical',
      prompt: 'Debounce a search field so a request goes out only after the user stops typing for 300 ms, and cancel the request already in flight.',
      followUps: ['How would you test the timing without waiting in the test?'],
      starter: { swift: 'final class SearchModel: ObservableObject {\n    @Published var query = ""\n    @Published var results: [String] = []\n}\n' },
    },
    {
      id: 'q-ios-crash', competencyId: 'problem-solving', roundType: 'behavioural',
      prompt: 'Walk me through the hardest crash you have tracked down in production.',
      followUps: ['How did you reproduce it?', 'What did you add so the next one is found faster?'],
    },
    {
      id: 'q-ios-design', competencyId: 'communication', roundType: 'behavioural',
      prompt: 'Tell me about a time a designer and you disagreed on an interaction. How was it settled?',
      followUps: ['Who made the final call?', 'Would you settle it the same way again?'],
    },
  ],
};

export const interviewOpeningsFixture = defineFixture<Opening>({
  key: 'interviews.openings',
  scenarios: {
    default: () => [
      { id: 'op-backend', title: 'Senior Backend Engineer', level: 'Senior', team: 'Payments', location: 'Lisbon or remote in Europe',
        hiringManagerId: AMARA, recruiterId: GRETA, state: 'open', openedAt: clock.daysAgo(41), kit: BACKEND_KIT, budgetCapUsd: 150, interviewCapUsd: null, revision: 1 },
      { id: 'op-ios', title: 'iOS Engineer', level: 'Mid-level', team: 'Mobile Checkout', location: 'Berlin or remote in Europe',
        hiringManagerId: null, recruiterId: GRETA, state: 'open', openedAt: clock.daysAgo(26), kit: IOS_KIT, budgetCapUsd: 100, interviewCapUsd: 8, revision: 1 },
      { id: 'op-em', title: 'Engineering Manager', level: 'Manager', team: 'Platform', location: 'Lisbon',
        hiringManagerId: AMARA, recruiterId: GRETA, state: 'open', openedAt: clock.daysAgo(19), kit: EM_KIT, budgetCapUsd: 60, interviewCapUsd: null, revision: 1 },
    ],
    empty: () => [],
  },
});

// ── candidates ───────────────────────────────────────────────────────────────

const candidate = (id: string, name: string, email: string, headline: string, location: string, source: string, notes: string, createdDaysAgo: number): Candidate =>
  ({ id, name, email, headline, location, source, resumeFileId: seededResumeFileId(id), notes, createdAt: clock.daysAgo(createdDaysAgo) });

export const interviewCandidatesFixture = defineFixture<Candidate>({
  key: 'interviews.candidates',
  scenarios: {
    default: () => [
      candidate('cand-mateo', 'Mateo Álvarez', 'mateo.alvarez@mail.example', 'Backend engineer, ride-hailing marketplace', 'Madrid', 'Careers page', 'Built the trip-pricing service at his current company; wants payments.', 30),
      candidate('cand-ingrid', 'Ingrid Solberg', 'ingrid.solberg@mail.example', 'Senior software engineer, card issuing', 'Oslo', 'Referral', 'Ran the move of a card-authorisation service to a second region.', 33),
      candidate('cand-kwame', 'Kwame Asante', 'kwame.asante@mail.example', 'Software engineer, logistics platform', 'Accra, open to relocating', 'Sourced', 'Strong open-source work on a job queue library.', 12),
      candidate('cand-lucia', 'Lucía Navarro', 'lucia.navarro@mail.example', 'Backend developer, online travel', 'Valencia', 'Careers page', 'Screening call booked for this week.', 6),
      candidate('cand-daniel', 'Daniel Kowalski', 'daniel.kowalski@mail.example', 'Senior Java engineer, banking core systems', 'Warsaw', 'Agency', 'Wants a fully remote role outside European hours.', 28),
      candidate('cand-aiko', 'Aiko Tanaka', 'aiko.tanaka@mail.example', 'iOS engineer, food delivery app', 'Berlin', 'Careers page', 'Shipped the offline order history in her current app.', 17),
      candidate('cand-ravi', 'Ravi Menon', 'ravi.menon@mail.example', 'Mobile engineer, retail banking app', 'Hamburg', 'Referral', 'Led the move from UIKit to SwiftUI for two screens.', 21),
      candidate('cand-chloe', 'Chloé Martin', 'chloe.martin@mail.example', 'iOS developer, media streaming', 'Lyon', 'Sourced', 'Applied yesterday; résumé not reviewed yet.', 1),
      candidate('cand-samuel', 'Samuel Adeyemi', 'samuel.adeyemi@mail.example', 'Junior iOS developer, product studio', 'Lagos, remote', 'Careers page', 'Two years of client apps; strong portfolio.', 9),
      candidate('cand-nadia', 'Nadia Petrova', 'nadia.petrova@mail.example', 'Engineering lead, developer tools', 'Sofia', 'Sourced', 'Leads eight engineers; has run a platform team before.', 14),
      candidate('cand-jonah', 'Jonah Whitaker', 'jonah.whitaker@mail.example', 'Engineering manager, insurance platform', 'Dublin', 'Agency', 'Manages two teams; interested in a smaller platform group.', 16),
      candidate('cand-elif', 'Elif Demir', 'elif.demir@mail.example', 'Senior engineer moving into management, cloud hosting', 'Lisbon', 'Careers page', 'Has been acting team lead for six months.', 3),
    ],
    empty: () => [],
  },
});

// ── applications ─────────────────────────────────────────────────────────────

const step = (stage: ApplicationStage, daysAgo: number, by: string | null, reason: string | null = null): StageChange =>
  ({ stage, at: clock.daysAgo(daysAgo), by, reason });

function application(id: string, candidateId: string, openingId: string, history: StageChange[]): Application {
  return { id, candidateId, openingId, stage: history[history.length - 1]!.stage, appliedAt: history[0]!.at, history };
}

export const interviewApplicationsFixture = defineFixture<Application>({
  key: 'interviews.applications',
  scenarios: {
    default: () => [
      application('app-mateo', 'cand-mateo', 'op-backend', [step('applied', 30, null), step('screening', 24, GRETA), step('interviewing', 8, GRETA, 'Strong screen: payments interest is real.')]),
      application('app-ingrid', 'cand-ingrid', 'op-backend', [step('applied', 33, null), step('screening', 29, GRETA), step('interviewing', 15, GRETA), step('debrief', 5, GRETA, 'Both rounds in; debrief with Amara next.')]),
      application('app-kwame', 'cand-kwame', 'op-backend', [step('applied', 12, null), step('screening', 9, GRETA), step('interviewing', 2, GRETA)]),
      application('app-lucia', 'cand-lucia', 'op-backend', [step('applied', 6, null), step('screening', 2, GRETA)]),
      application('app-daniel', 'cand-daniel', 'op-backend', [step('applied', 28, null), step('screening', 22, GRETA), step('rejected', 18, GRETA, 'Looking for a fully remote role outside European hours.')]),
      application('app-aiko', 'cand-aiko', 'op-ios', [step('applied', 17, null), step('screening', 12, GRETA), step('interviewing', 4, GRETA)]),
      application('app-ravi', 'cand-ravi', 'op-ios', [step('applied', 21, null), step('screening', 16, GRETA), step('interviewing', 7, GRETA)]),
      application('app-chloe', 'cand-chloe', 'op-ios', [step('applied', 1, null)]),
      application('app-samuel', 'cand-samuel', 'op-ios', [step('applied', 9, null), step('screening', 3, GRETA)]),
      application('app-nadia', 'cand-nadia', 'op-em', [step('applied', 14, null), step('screening', 10, GRETA), step('interviewing', 3, GRETA)]),
      application('app-jonah', 'cand-jonah', 'op-em', [step('applied', 16, null), step('screening', 11, GRETA), step('interviewing', 6, GRETA)]),
      application('app-elif', 'cand-elif', 'op-em', [step('applied', 3, null)]),
    ],
    empty: () => [],
  },
});

// ── interviews ───────────────────────────────────────────────────────────────

interface InterviewSeed {
  id: string; app: string; round: string; type: Interview['type']; lead: string; panel?: string[];
  start: string; minutes: number; state: InterviewState; questions?: string[]; assignedDaysAgo: number; ended?: string | null;
}

const interview = (s: InterviewSeed): Interview => ({
  id: s.id, applicationId: s.app, roundId: s.round, type: s.type, leadId: s.lead, panelIds: s.panel ?? [],
  scheduledAt: s.start, minutes: s.minutes, state: s.state, questionIds: s.questions ?? [],
  assignedBy: GRETA, assignedAt: clock.daysAgo(s.assignedDaysAgo), callId: null, endedAt: s.ended ?? null,
  // Row I1.4: past `assigned`, every seat has accepted (a day after the assignment); still `assigned`, nobody has yet.
  acceptances: s.state === 'assigned' || s.state === 'declined' || s.state === 'cancelled' ? []
    : [{ userId: s.lead, seat: 'lead' as const, at: clock.daysAgo(Math.max(s.assignedDaysAgo - 1, 0)) },
      ...(s.panel ?? []).map((userId) => ({ userId, seat: 'panel' as const, at: clock.daysAgo(Math.max(s.assignedDaysAgo - 1, 0)) }))],
  declines: [],
  revision: 1,
});

export const interviewsFixture = defineFixture<Interview>({
  key: 'interviews.interviews',
  scenarios: {
    default: () => [
      // Finished, with scorecards. Ingrid's two wait for Amara's decision (row I5.5); the decision marks them reviewed.
      interview({ id: 'iv-d7q4n9xe', app: 'app-ingrid', round: 'rd-coding', type: 'technical', lead: HUGO, start: at(-9, 14), minutes: 60, state: 'scored',
        questions: ['q-be-ratelimit', 'q-be-retry'], assignedDaysAgo: 15, ended: at(-9, 15) }),
      interview({ id: 'iv-f2b6t5zh', app: 'app-ingrid', round: 'rd-together', type: 'behavioural', lead: WEN, start: at(-6, 13), minutes: 45, state: 'scored',
        questions: ['q-be-incident', 'q-be-disagree'], assignedDaysAgo: 14, ended: at(-6, 13, 45) }),
      interview({ id: 'iv-j6x2d9sb', app: 'app-mateo', round: 'rd-coding', type: 'technical', lead: HUGO, start: at(-3, 14), minutes: 60, state: 'scored',
        questions: ['q-be-ratelimit', 'q-be-retry'], assignedDaysAgo: 8, ended: at(-3, 15) }),
      interview({ id: 'iv-p2v7j4ye', app: 'app-ravi', round: 'rd-coding', type: 'technical', lead: WEN, start: at(-2, 15), minutes: 60, state: 'scored',
        questions: ['q-ios-feed', 'q-ios-debounce'], assignedDaysAgo: 7, ended: at(-2, 16) }),
      // Finished yesterday; Wen's scorecard is still due.
      interview({ id: 'iv-g9r1y8lp', app: 'app-jonah', round: 'rd-leadership', type: 'behavioural', lead: WEN, start: at(-1, 16), minutes: 60, state: 'ended',
        questions: ['q-em-struggling', 'q-em-slip'], assignedDaysAgo: 6, ended: at(-1, 17) }),
      // Live now: Kwame's first round, started twelve minutes ago (nobody has joined a call yet; Hugo opens the room).
      interview({ id: LIVE_INTERVIEW_ID, app: 'app-kwame', round: 'rd-coding', type: 'technical', lead: HUGO, panel: [WEN], start: liveStart(), minutes: 60, state: 'live',
        questions: ['q-be-ratelimit'], assignedDaysAgo: 2 }),
      // Coming up.
      interview({ id: 'iv-k1p5w8ra', app: 'app-mateo', round: 'rd-design', type: 'technical', lead: HUGO, start: at(1, 14), minutes: 60, state: 'ready',
        questions: ['q-be-ledger'], assignedDaysAgo: 2 }),
      interview({ id: 'iv-c3k8w2ma', app: 'app-aiko', round: 'rd-coding', type: 'technical', lead: WEN, start: at(2, 14, 30), minutes: 60, state: 'ready',
        questions: ['q-ios-feed', 'q-ios-debounce'], assignedDaysAgo: 4 }),
      interview({ id: 'iv-h4m7c3vu', app: 'app-kwame', round: 'rd-design', type: 'technical', lead: HUGO, start: at(3, 14), minutes: 60, state: 'assigned', assignedDaysAgo: 1 }),
      interview({ id: 'iv-r6d1k9wt', app: 'app-ravi', round: 'rd-together', type: 'behavioural', lead: WEN, start: at(4, 13), minutes: 45, state: 'assigned', assignedDaysAgo: 1 }),
      interview({ id: 'iv-m8t3h6ng', app: 'app-nadia', round: 'rd-design', type: 'technical', lead: HUGO, start: at(5, 16), minutes: 60, state: 'accepted', assignedDaysAgo: 3 }),
      interview({ id: 'iv-n5z9f2cq', app: 'app-nadia', round: 'rd-leadership', type: 'behavioural', lead: WEN, panel: [HUGO], start: at(6, 15), minutes: 60, state: 'accepted', assignedDaysAgo: 3 }),
    ],
    empty: () => [],
  },
});

// ── scorecards ───────────────────────────────────────────────────────────────

const rate = (competencyId: string, rating: CompetencyRating['rating'], note: string): CompetencyRating => ({ competencyId, rating, note });

export const interviewScorecardsFixture = defineFixture<Scorecard>({
  key: 'interviews.scorecards',
  scenarios: {
    default: () => [
      { id: 'sc-ingrid-coding', interviewId: 'iv-d7q4n9xe', interviewerId: HUGO, recommendation: 'strong-yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-9, 16, 20),
        summary: 'The strongest coding round on this opening so far. Finished the limiter and the per-merchant follow-up with time to spare.',
        ratings: [
          rate('problem-solving', 4, 'Finished the token bucket in twenty minutes, then extended it to per-merchant limits without a hint.'),
          rate('code-quality', 4, 'Wrote the tests first and kept the clock out of the limiter so it could be tested.'),
        ] },
      { id: 'sc-ingrid-together', interviewId: 'iv-f2b6t5zh', interviewerId: WEN, recommendation: 'yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-6, 15, 5),
        summary: 'Clear, honest examples. She owns her mistakes and follows up on disagreements with data rather than pressure.',
        ratings: [
          rate('communication', 3, 'Walked through a settlement outage in order and named what she would do differently.'),
          rate('collaboration', 3, 'Disagreed in a design review, accepted the call, and came back a month later with numbers.'),
        ] },
      { id: 'sc-mateo-coding', interviewId: 'iv-j6x2d9sb', interviewerId: HUGO, recommendation: 'yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-3, 16, 10),
        summary: 'A solid round. Correct and careful, a little slow to think about concurrency. Worth the system design round.',
        ratings: [
          rate('problem-solving', 3, 'Reached a working limiter in about thirty minutes; handled the burst case once asked.'),
          rate('code-quality', 3, 'Small functions and clear names. Reused the idempotency key correctly on retry.'),
        ] },
      { id: 'sc-ravi-coding', interviewId: 'iv-p2v7j4ye', interviewerId: WEN, recommendation: 'yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-2, 17, 40),
        summary: 'Comfortable with modern Swift. The offline cache was sketched rather than built; worth asking about in the next round.',
        ratings: [
          rate('app-architecture', 3, 'Kept paging state out of the view; described the offline cache but did not build it.'),
          rate('swift', 3, 'Used async/await and cancelled the stale search task correctly.'),
        ] },
    ],
    empty: () => [],
  },
});
