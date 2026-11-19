// The interviews tenant's seed story (docs/interviews-tenant-plan.md, "Cast").
//
// One hiring desk in the mock world. Greta Lindqvist recruits for three
// openings: a senior backend engineer for Payments and an engineering manager
// for Platform, both Amara Okafor's to decide, and an iOS engineer for Mobile
// Checkout whose hiring manager is not named yet (so only the recruiter sees
// it, which is what the hiring manager's scope is walked against). Hugo
// Marchetti interviews the backend and system design rounds, Wen Zhao the iOS
// and behavioural ones. Twelve candidates across the stages, six interviews
// coming up, one live now (Kwame's coding round with Hugo and Wen, started twelve
// minutes ago), four finished with scorecards and one finished yesterday whose
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

import { blueprintBoard, promptBoard } from '../lib/interviews/board/templates.js';
import { clock, defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import { EM_KIT } from './interviews-behavioural.js';
import { seededResumeFileId } from './interviews-resumes.js';
import type {
  Application, ApplicationStage, Candidate, CompetencyRating, Interview, InterviewState, Opening, OpeningKit, Scorecard, StageChange,
} from '../lib/interviews/types.js';

/** Working days from today at an hour UTC (mock/interviews-days.ts). */
const at = seedAt;

/** The round that is live now: Kwame's coding round with Hugo and Wen, started twelve minutes ago by the mock clock. */
export const LIVE_INTERVIEW_ID = 'iv-s4e8u2zk'; // keep equal to the literal in `interviewsFixture` (the walk's seed check reads that one)
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
    { id: 'rd-screen', name: 'Technical screen', type: 'technical', minutes: 45, surface: 'pad', competencyIds: ['problem-solving', 'code-quality', 'communication'] },
    { id: 'rd-coding', name: 'Coding', type: 'technical', minutes: 60, surface: 'pad', competencyIds: ['problem-solving', 'code-quality', 'communication'] },
    // The system design round is drawn on the shared whiteboard (WHITEBOARD-PLAN step 1).
    { id: 'rd-design', name: 'System design', type: 'technical', minutes: 60, surface: 'board', competencyIds: ['system-design', 'communication'] },
    { id: 'rd-together', name: 'Working together', type: 'behavioural', minutes: 45, competencyIds: ['communication', 'collaboration'] },
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
      board: blueprintBoard(),
      clarifying: [
        'How many captures and refunds a second, at peak?',
        'Which regions, and is failover active-active or active-passive?',
        'Who reads the ledger, and how fresh must a balance be?',
        'Must a refund link to its capture, and can it be partial?',
      ],
    },
    {
      id: 'q-be-shortener', competencyId: 'system-design', roundType: 'technical',
      prompt: 'Design a URL shortener for 100M links a month.',
      followUps: ['How do you make the short codes, and what happens when two collide?', 'Where would you put a cache, and what does it hold?'],
      board: promptBoard('Design a URL shortener for 100M links a month'),
      clarifying: [
        'How many reads per write: how often is a short link opened?',
        'Do links expire, and can a user pick a custom alias?',
        'How fast must a redirect be, and from where in the world?',
        'Do we need click analytics, and how fresh?',
      ],
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
    {
      id: 'q-be-twosum', competencyId: 'problem-solving', roundType: 'technical',
      prompt: 'Given an array of integers and a target, return the indices of the two numbers that add up to the target. Each input has exactly one answer, and the same element may not be used twice.',
      followUps: [
        'What is the runtime complexity of your solution, in time and in space?',
        'How would you test this function?',
        'What would you change if the array were already sorted?',
      ],
      starter: {
        python: 'def two_sum(nums: list[int], target: int) -> list[int]:\n    pass\n\n\nprint(two_sum([2, 7, 11, 15], 9))\n',
        javascript: 'function twoSum(nums, target) {\n}\n\nconsole.log(twoSum([2, 7, 11, 15], 9));\n',
        typescript: 'function twoSum(nums: number[], target: number): number[] {\n  return [];\n}\n\nconsole.log(twoSum([2, 7, 11, 15], 9));\n',
        java: 'import java.util.*;\n\nclass Main {\n    static int[] twoSum(int[] nums, int target) {\n        return new int[0];\n    }\n\n    public static void main(String[] args) {\n        System.out.println(Arrays.toString(twoSum(new int[]{2, 7, 11, 15}, 9)));\n    }\n}\n',
        go: 'package main\n\nimport "fmt"\n\nfunc twoSum(nums []int, target int) []int {\n\treturn nil\n}\n\nfunc main() {\n\tfmt.Println(twoSum([]int{2, 7, 11, 15}, 9))\n}\n',
      },
    },
  ],
};

const IOS_KIT: OpeningKit = {
  rounds: [
    { id: 'rd-coding', name: 'Coding', type: 'technical', minutes: 60, surface: 'pad', competencyIds: ['problem-solving', 'swift', 'app-architecture', 'communication'] },
    // The crash story (q-ios-crash) is a problem-solving question asked in this round.
    { id: 'rd-together', name: 'Working together', type: 'behavioural', minutes: 45, competencyIds: ['problem-solving', 'communication'] },
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
      candidate('cand-rx6tcaqj', 'Mateo Álvarez', 'mateo.alvarez@mail.example', 'Backend engineer, ride-hailing marketplace', 'Madrid', 'Careers page', 'Built the trip-pricing service at his current company; wants payments.', 30),
      candidate('cand-qz63q3a3', 'Ingrid Solberg', 'ingrid.solberg@mail.example', 'Senior software engineer, card issuing', 'Oslo', 'Referral', 'Ran the move of a card-authorisation service to a second region.', 33),
      candidate('cand-nx59ftdv', 'Kwame Asante', 'kwame.asante@mail.example', 'Software engineer, logistics platform', 'Accra, open to relocating', 'Sourced', 'Strong open-source work on a job queue library.', 12),
      candidate('cand-88j9dpte', 'Lucía Navarro', 'lucia.navarro@mail.example', 'Backend developer, online travel', 'Valencia', 'Careers page', 'Screening call booked for this week.', 6),
      candidate('cand-d7vdruga', 'Daniel Kowalski', 'daniel.kowalski@mail.example', 'Senior Java engineer, banking core systems', 'Warsaw', 'Agency', 'Wants a fully remote role outside European hours.', 28),
      candidate('cand-s52jevud', 'Aiko Tanaka', 'aiko.tanaka@mail.example', 'iOS engineer, food delivery app', 'Berlin', 'Careers page', 'Shipped the offline order history in her current app.', 17),
      candidate('cand-w4pvy8m9', 'Ravi Menon', 'ravi.menon@mail.example', 'Mobile engineer, retail banking app', 'Hamburg', 'Referral', 'Led the move from UIKit to SwiftUI for two screens.', 21),
      candidate('cand-9p2atayb', 'Chloé Martin', 'chloe.martin@mail.example', 'iOS developer, media streaming', 'Lyon', 'Sourced', 'Applied yesterday; résumé not reviewed yet.', 1),
      candidate('cand-6smu3v2v', 'Samuel Adeyemi', 'samuel.adeyemi@mail.example', 'Junior iOS developer, product studio', 'Lagos, remote', 'Careers page', 'Two years of client apps; strong portfolio.', 9),
      candidate('cand-xbmv4nvd', 'Nadia Petrova', 'nadia.petrova@mail.example', 'Engineering lead, developer tools', 'Sofia', 'Sourced', 'Leads eight engineers; has run a platform team before.', 14),
      candidate('cand-zrtncmb2', 'Jonah Whitaker', 'jonah.whitaker@mail.example', 'Engineering manager, insurance platform', 'Dublin', 'Agency', 'Manages two teams; interested in a smaller platform group.', 16),
      candidate('cand-pf3xhgxf', 'Elif Demir', 'elif.demir@mail.example', 'Senior engineer moving into management, cloud hosting', 'Lisbon', 'Careers page', 'Has been acting team lead for six months.', 3),
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
      application('app-7b69njmx', 'cand-rx6tcaqj', 'op-backend', [step('applied', 30, null), step('screening', 24, GRETA), step('interviewing', 8, GRETA, 'Strong screen: payments interest is real.')]),
      application('app-vfzc2x6g', 'cand-qz63q3a3', 'op-backend', [step('applied', 33, null), step('screening', 29, GRETA), step('interviewing', 15, GRETA), step('debrief', 5, GRETA, 'Both rounds in; debrief with Amara next.')]),
      application('app-pn7v4yev', 'cand-nx59ftdv', 'op-backend', [step('applied', 12, null), step('screening', 9, GRETA), step('interviewing', 2, GRETA)]),
      application('app-g393z287', 'cand-88j9dpte', 'op-backend', [step('applied', 6, null), step('screening', 2, GRETA)]),
      application('app-y2pmbks8', 'cand-d7vdruga', 'op-backend', [step('applied', 28, null), step('screening', 22, GRETA), step('rejected', 18, GRETA, 'Looking for a fully remote role outside European hours.')]),
      application('app-3j6avdmd', 'cand-s52jevud', 'op-ios', [step('applied', 17, null), step('screening', 12, GRETA), step('interviewing', 4, GRETA)]),
      application('app-j7zuguu3', 'cand-w4pvy8m9', 'op-ios', [step('applied', 21, null), step('screening', 16, GRETA), step('interviewing', 7, GRETA)]),
      application('app-4shk59u3', 'cand-9p2atayb', 'op-ios', [step('applied', 1, null)]),
      application('app-ddk4nvfg', 'cand-6smu3v2v', 'op-ios', [step('applied', 9, null), step('screening', 3, GRETA)]),
      application('app-efd7rc6g', 'cand-xbmv4nvd', 'op-em', [step('applied', 14, null), step('screening', 10, GRETA), step('interviewing', 3, GRETA)]),
      application('app-5j2chffb', 'cand-zrtncmb2', 'op-em', [step('applied', 16, null), step('screening', 11, GRETA), step('interviewing', 6, GRETA)]),
      application('app-5xecwhnp', 'cand-pf3xhgxf', 'op-em', [step('applied', 3, null)]),
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
  // A round that has run started at its scheduled time in the seed; one that hasn't, never.
  ...(s.state === 'live' || s.ended ? { startedAt: s.start } : {}),
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
      interview({ id: 'iv-d7q4n9xe', app: 'app-vfzc2x6g', round: 'rd-coding', type: 'technical', lead: HUGO, start: at(-9, 14), minutes: 60, state: 'scored',
        questions: ['q-be-ratelimit', 'q-be-retry'], assignedDaysAgo: 15, ended: at(-9, 15) }),
      interview({ id: 'iv-f2b6t5zh', app: 'app-vfzc2x6g', round: 'rd-together', type: 'behavioural', lead: WEN, start: at(-6, 13), minutes: 45, state: 'scored',
        questions: ['q-be-incident', 'q-be-disagree'], assignedDaysAgo: 14, ended: at(-6, 13, 45) }),
      interview({ id: 'iv-j6x2d9sb', app: 'app-7b69njmx', round: 'rd-screen', type: 'technical', lead: HUGO, start: at(-3, 14), minutes: 45, state: 'scored',
        questions: ['q-be-ratelimit', 'q-be-retry'], assignedDaysAgo: 8, ended: at(-3, 14, 45) }),
      interview({ id: 'iv-p2v7j4ye', app: 'app-j7zuguu3', round: 'rd-coding', type: 'technical', lead: WEN, start: at(-2, 15), minutes: 60, state: 'scored',
        questions: ['q-ios-feed', 'q-ios-debounce'], assignedDaysAgo: 7, ended: at(-2, 16) }),
      // Finished yesterday; Wen's scorecard is still due.
      interview({ id: 'iv-g9r1y8lp', app: 'app-5j2chffb', round: 'rd-leadership', type: 'behavioural', lead: WEN, start: at(-1, 16), minutes: 60, state: 'ended',
        questions: ['q-em-struggling', 'q-em-slip'], assignedDaysAgo: 6, ended: at(-1, 17) }),
      // Live now: Kwame's first round, started twelve minutes ago (nobody has joined a call yet; Hugo opens the room).
      interview({ id: 'iv-s4e8u2zk', app: 'app-pn7v4yev', round: 'rd-coding', type: 'technical', lead: HUGO, panel: [WEN], start: liveStart(), minutes: 60, state: 'live',
        questions: ['q-be-ratelimit'], assignedDaysAgo: 2 }),
      // Coming up.
      interview({ id: 'iv-k1p5w8ra', app: 'app-7b69njmx', round: 'rd-coding', type: 'technical', lead: HUGO, start: at(1, 14), minutes: 60, state: 'ready',
        questions: ['q-be-twosum'], assignedDaysAgo: 2 }),
      interview({ id: 'iv-c3k8w2ma', app: 'app-3j6avdmd', round: 'rd-coding', type: 'technical', lead: WEN, start: at(2, 14, 30), minutes: 60, state: 'ready',
        questions: ['q-ios-feed', 'q-ios-debounce'], assignedDaysAgo: 4 }),
      interview({ id: 'iv-h4m7c3vu', app: 'app-pn7v4yev', round: 'rd-design', type: 'technical', lead: HUGO, start: at(3, 14), minutes: 60, state: 'assigned', assignedDaysAgo: 1 }),
      interview({ id: 'iv-r6d1k9wt', app: 'app-j7zuguu3', round: 'rd-together', type: 'behavioural', lead: WEN, start: at(4, 13), minutes: 45, state: 'assigned', assignedDaysAgo: 1 }),
      interview({ id: 'iv-m8t3h6ng', app: 'app-efd7rc6g', round: 'rd-design', type: 'technical', lead: HUGO, start: at(5, 16), minutes: 60, state: 'accepted', assignedDaysAgo: 3 }),
      interview({ id: 'iv-n5z9f2cq', app: 'app-efd7rc6g', round: 'rd-leadership', type: 'behavioural', lead: WEN, panel: [HUGO], start: at(6, 15), minutes: 60, state: 'accepted', assignedDaysAgo: 3 }),
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
      { id: 'sc-szbsws4n', interviewId: 'iv-d7q4n9xe', interviewerId: HUGO, recommendation: 'strong-yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-9, 16, 20),
        summary: 'The strongest coding round on this opening so far. Finished both problems with time to spare and found her own bug from the first run.',
        ratings: [
          rate('problem-solving', 4, 'Had the bucket passing in about sixteen minutes, fixed her own missing-argument call from the run, and kept the lock per key.'),
          rate('code-quality', 4, 'Named the fake-clock refill test unprompted; one idempotency key per charge, kept for a day, and only safe errors retried.'),
          rate('communication', 4, 'Said which approach she was taking and why before typing, and stopped to check I followed the locking.'),
        ] },
      { id: 'sc-ju3s5t85', interviewId: 'iv-f2b6t5zh', interviewerId: WEN, recommendation: 'yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-6, 15, 5),
        summary: 'Clear, honest examples. She owns her mistakes and follows up on disagreements with data rather than pressure.',
        ratings: [
          rate('communication', 3, 'Walked through the authorisation outage in order, with updates every fifteen minutes, and named what changed afterwards.'),
          rate('collaboration', 3, 'Brought failover numbers to the design review, accepted the call, then helped build it and wrote the runbook.'),
        ] },
      { id: 'sc-qadtme79', interviewId: 'iv-j6x2d9sb', interviewerId: HUGO, recommendation: 'yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-3, 16, 10),
        summary: 'A solid round. Correct and careful; spoke to concurrency only once asked. Worth the coding round.',
        ratings: [
          rate('problem-solving', 3, 'Had a working limiter in about fifteen minutes; explained the fixed window\'s burst at the reset once asked.'),
          rate('code-quality', 3, 'Passed the clock in so it could be tested without sleeping. Saved the idempotency key before the first call.'),
          rate('communication', 3, 'Clear once he started explaining; went quiet while coding and needed a nudge to talk through the retry path.'),
        ] },
      { id: 'sc-b75vwqbq', interviewId: 'iv-p2v7j4ye', interviewerId: WEN, recommendation: 'yes', version: 1, changedAfterRecap: false, correctionReason: null,
        submittedAt: at(-2, 17, 40),
        summary: 'Comfortable with modern Swift. The offline cache was sketched rather than built; worth asking about in the next round.',
        ratings: [
          rate('app-architecture', 3, 'Kept paging state out of the view; described the offline cache but did not build it.'),
          rate('swift', 3, 'Used async/await and cancelled the stale search task correctly.'),
          rate('problem-solving', 3, 'Broke the feed into paging, caching and cancellation before writing any code, and tested the empty page.'),
          rate('communication', 3, 'Explained the paging trade-off plainly and said where she was unsure about the cache.'),
        ] },
    ],
    empty: () => [],
  },
});
