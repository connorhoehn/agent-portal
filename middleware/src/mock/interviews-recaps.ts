// Milo's recaps and who opened them (docs/interviews-tenant-plan.md decision 14, row I5.2): the mock world's
// interview_recaps, interview_recap_opens and interview_recap_attempts.
//
// A recap on each of the four finished, scored rounds of mock/interviews.ts: Ingrid's coding and "Working together"
// rounds, Mateo's coding round and Ravi's coding round in Swift. Jonah's leadership round has none yet: Wen has not
// rated it, and the first open writes it. Each recap covers the competencies of the round's chosen questions, with
// two to four statements each; every statement is a short plain sentence in the words of the candidate line it cites
// (mock/interviews-records.ts holds the lines), so the screen shows the statement once and the quoted line beside it.
// The seeded content is exactly what the recap guard (lib/interviews/recap/parse.ts) keeps of it: no statement is
// dropped for drift, repetition or a missing source, and the rest of each cited answer is already cited
// (mock/__tests__/interviews-milo-texts.test.ts runs every seeded recap through the guard and the judgement detector).
// Each lead's open is seeded with the ratings their seeded scorecard kept, at the time the recap was written (the
// first open writes it). Registered from its own module (lib/interviews/recap/store.ts imports it).
// Times follow mock/interviews.ts's `at()`: working days from today (mock/interviews-days.ts), computed on read.
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import type { RecapAttempt, RecapOpen, RecapRecord } from '../lib/interviews/recap/store.js';

const PROMPT_VERSION = 'recap-2026-11-17.1';
const MODEL = 'scripted-recap';

/** Working days from today at an hour UTC (mock/interviews-days.ts). */
const at = seedAt;

/** One statement: Milo's short sentence, and the candidate line it rests on (its number and its words, whole). */
const claim = (text: string, seq: number, quote: string) => ({ text, seq, quote });

const recap = (interviewId: string, writtenAt: string, competencies: RecapRecord['content']['competencies']): RecapRecord => ({
  interviewId, state: 'ready', writtenAt, modelId: MODEL, promptVersion: PROMPT_VERSION, attempts: 1, droppedCodes: [], droppedClaims: 0,
  // Every competency of the round's questions has statements, so nothing of the round is "not covered".
  content: { competencies, notCovered: [] },
});

export const interviewRecapsFixture = defineFixture<RecapRecord>({
  key: 'interviews.recaps',
  scenarios: {
    default: () => [
      // Ingrid's coding round (Hugo; ended at -9 15:00): the rate limiter, then retries with an idempotency key.
      recap('iv-d7q4n9xe', at(-9, 15, 40), [
        { id: 'problem-solving', evidence: [
          claim('Keeps the tokens and the time of the last refill, and works out the refill when a request arrives.', 6,
            "I'll keep the tokens and the time of the last refill, and work the refill out when a request arrives instead of on a timer."),
          claim('Adds elapsed time times the rate, caps at capacity, and takes one token.', 8,
            'Then allow: add elapsed time times the rate, cap at capacity, and take one token if there is one.'),
          claim('Fixed the call: allow was called without the time.', 10,
            "That's a mistake of mine: I called allow without the time, so the call is wrong. Fixing the call."),
          claim('A lock per key around the refill and the take.', 12,
            'A lock around the refill and the take. I would keep it per key so different keys do not wait on each other.'),
        ] },
        { id: 'code-quality', evidence: [
          claim('A refill test with a fake clock that drains the bucket.', 15,
            'A refill test with a fake clock: drain the bucket, move the clock one second, expect exactly R tokens back.'),
          claim('One key per charge, sent on every attempt.', 17,
            'The key is made once per charge and sent on every attempt, so a retry can never double-charge.'),
          claim('Backoff doubles with jitter, and only timeouts and server errors retry.', 18,
            'Backoff starts at a hundred milliseconds, doubles, adds jitter, and I only retry timeouts and server errors.'),
          claim("A day: longer than the retry window plus the provider's dedupe window.", 20,
            "Longer than the longest retry window plus the provider's own dedupe window, so a day is a reasonable default."),
        ] },
      ]),
      // Ingrid's "Working together" round (Wen; ended at -6 13:45): an incident she led, then a disagreement.
      recap('iv-f2b6t5zh', at(-6, 14, 50), [
        { id: 'communication', evidence: [
          claim('Opened the incident channel and posted what they knew.', 7,
            "I opened the incident channel and posted what we knew and what we didn't, so nobody had to ask."),
          claim('Paged the on-call lead and split the investigation: database side and network path.', 8,
            'I paged the on-call lead and we split the investigation: she took the database side and I took the network path.'),
          claim('Posted an update every fifteen minutes, even when nothing had changed.', 16,
            'The on-call lead first, then the payments product manager once we knew customers were affected. I posted an update every fifteen minutes even when nothing had changed.'),
          claim('Added a pool settings check to the config review and an alert on pool wait time.', 20,
            'We added a check on pool settings to the config review, and an alert on pool wait time, not just on errors.'),
        ] },
        { id: 'collaboration', evidence: [
          claim('Wrote up the failover time of each, and asked for thirty minutes in the design review.', 23,
            "I wrote up the failover time we'd get with each, with numbers from the last two incidents, and asked for thirty minutes in the design review."),
          claim('Stayed active-passive for the first release, with a date agreed to look again.', 25,
            'We stayed active-passive for the first release, which was the right call for the deadline, and we agreed a date to look at it again.'),
          claim('Helped build it, wrote the failover runbook, and made the active-active move two quarters later.', 27,
            'I helped build it. I wrote the failover runbook, and we made the active-active move two quarters later.'),
          claim('Numbers before the decision, not after.', 29, "I'd bring the numbers before the decision, not after it."),
        ] },
      ]),
      // Mateo's coding round (Hugo; ended at -3 15:00): the rate limiter, then retries with an idempotency key.
      recap('iv-j6x2d9sb', at(-3, 16, 0), [
        { id: 'problem-solving', evidence: [
          claim('Keeps a map from key to a bucket record: tokens left and the last refill time.', 6,
            "Then I'd keep a map from key to a small bucket record: the tokens left and the last time it was refilled."),
          claim('Adds the time passed times R, caps at N, and takes one token.', 7,
            "On each request I'd work out how much time has passed, add that times R, cap it at N, and then take one token if there is one."),
          claim('Guards each bucket with a lock, or a compare-and-set loop.', 14,
            "In one process I'd guard each bucket with a lock, or do the update in a compare-and-set loop. Across processes it changes."),
          claim('Lands in the new window at the reset: twice the limit in a couple of seconds.', 24,
            "It lands in the new window, so a client can send a full window's worth just before the reset and another just after. That's twice the limit in a couple of seconds, which is what the bucket avoids."),
        ] },
        { id: 'code-quality', evidence: [
          claim('Starts with the bucket type and a clock it can pass in, so it is testable without sleeping.', 11,
            "I'll start with the bucket type and a clock I can pass in, so it's testable without sleeping."),
          claim('Makes the key once per charge and sends the same key on every retry.', 26,
            "The key comes first. I'd make it once per charge from our side and send the same key on every retry, so the provider can drop a duplicate."),
          claim('Backoff doubles with jitter; only timeouts and server errors retry, never a decline.', 27,
            "Backoff doubles from a hundred milliseconds with some jitter, capped at a few seconds, and I'd only retry timeouts and server errors, never a decline."),
          claim('Saves the key before the first call, so the next attempt reuses it.', 29,
            "Then the next attempt reuses the stored key, the provider returns the original result, and we record it. That's why the key has to be saved before the first call."),
        ] },
      ]),
      // Ravi's coding round in Swift (Wen; ended at -2 16:00): a paged list, then a debounced search.
      recap('iv-p2v7j4ye', at(-2, 17, 10), [
        { id: 'swift', evidence: [
          claim('Holds the pending work as a task, cancels it on every keystroke and starts a new one that sleeps first.', 18,
            'I would hold the pending work as a task, cancel it on every keystroke and start a new one that sleeps first.'),
          claim('Cancelling the task cancels the request awaited inside it.', 19,
            'Cancelling the task also cancels the request it started, as long as the request is awaited inside it.'),
          claim('A clock the test controls, so the test moves time forward.', 21,
            'Pass in a clock the test controls, so the test moves time forward instead of sleeping.'),
          claim('Two quick changes: the first search is cancelled and only the second returns.', 22,
            'Running it with two quick changes: the first search is cancelled and only the second returns.'),
        ] },
        { id: 'app-architecture', evidence: [
          claim('Paging in a model object, with the list asking it to load more near the end.', 4,
            "I'd put the paging in a model object and have the list ask it to load more when a row near the end appears."),
          claim('Keeps a set of the pages already requested and checks it before asking.', 6,
            'I keep a set of the pages already requested and check it before asking, so a fast scroll cannot send the same request twice.'),
          claim('Marks the page before the request starts, not when it returns.', 14,
            'That I need to mark the page before the request starts, not when it returns. I will move that line up.'),
          claim('The pages already loaded, a small banner and a retry.', 16,
            'The pages already loaded, and a small banner saying the next page could not be reached, with a retry.'),
        ] },
      ]),
    ],
    empty: () => [],
  },
});

export const interviewRecapOpensFixture = defineFixture<RecapOpen>({
  key: 'interviews.recap-opens',
  scenarios: {
    default: () => [
      // The leads opened the recap after rating, with the ratings their scorecards then kept (so nothing changed after it).
      { interviewId: 'iv-d7q4n9xe', interviewerId: 'u-hugo', openedAt: at(-9, 15, 40),
        ratings: [{ competencyId: 'problem-solving', rating: 4 }, { competencyId: 'code-quality', rating: 4 }] },
      { interviewId: 'iv-f2b6t5zh', interviewerId: 'u-wen', openedAt: at(-6, 14, 50),
        ratings: [{ competencyId: 'communication', rating: 3 }, { competencyId: 'collaboration', rating: 3 }] },
      { interviewId: 'iv-j6x2d9sb', interviewerId: 'u-hugo', openedAt: at(-3, 16, 0),
        ratings: [{ competencyId: 'problem-solving', rating: 3 }, { competencyId: 'code-quality', rating: 3 }] },
      { interviewId: 'iv-p2v7j4ye', interviewerId: 'u-wen', openedAt: at(-2, 17, 10),
        ratings: [{ competencyId: 'app-architecture', rating: 3 }, { competencyId: 'swift', rating: 3 }] },
    ],
    empty: () => [],
  },
});

// The model calls made toward a recap not yet written (hardening H4): none seeded, every seeded recap is written. Kept
// as a fixture so the mock world's reset clears it and its rows outlive the service's memory.
export const interviewRecapAttemptsFixture = defineFixture<RecapAttempt>({
  key: 'interviews.recap-attempts',
  scenarios: { default: () => [], empty: () => [] },
});
