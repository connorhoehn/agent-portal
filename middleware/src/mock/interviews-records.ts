// The interview record's stand-in (docs/interviews-tenant-plan.md decision 19, "Recordings in the mock world", row I5.1).
//
// The mock world has no media server and the meeting assistant's memory store starts empty, so two finished interviews of
// mock/interviews.ts carry what a real call would have left behind: a recording row (when it started and how long it ran,
// nothing playable) and the transcript lines the meeting assistant would have stored. lib/interviews/record/ reads both
// only in the mock world and only when no stored call of that interview is found.
//
//   iv-j6x2d9sb      Mateo's coding round, Hugo leads: a rate limiter, then retries with an idempotency key.
//   iv-f2b6t5zh   Ingrid's "Working together" round, Wen leads: an incident she led, then a disagreement.
//   iv-d7q4n9xe   Ingrid's coding round, Hugo leads: the rate limiter again, then the retries.
//   iv-p2v7j4ye   Ravi's coding round in Swift, Wen leads: a paged list, then a debounced search.
//   iv-g9r1y8lp   Jonah's leadership round, Wen leads: a teammate who struggled, then a slipped deadline.
//
// The words line up with mock/interviews-suggestions.ts (the quotes those suggestions were based on, and the questions the
// lead asked once they were answered). Seeded names only. Times follow mock/interviews.ts's `at()`: days from today's UTC
// midnight, computed on read.
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';

/** Working days from today at an hour UTC (mock/interviews-days.ts). */
const at = seedAt;

/** What the media server would have kept for one interview's call: when it started and how long it ran. No media. */
export interface RecordingStandIn { interviewId: string; startedAt: string; durationSeconds: number }

/** One line as the meeting assistant would have stored it: who spoke (a staff id or the candidate's guest id), when, and the words. */
export interface RecordLineSeed { interviewId: string; seq: number; at: string; userId: string | null; text: string }

const HUGO = 'u-hugo';
const WEN = 'u-wen';

type Said = [minute: number, second: number, who: string | null, text: string];

function lines(interviewId: string, start: () => string, said: Said[]): RecordLineSeed[] {
  const base = Date.parse(start());
  return said.map(([m, s, who, text], i) => ({ interviewId, seq: i + 1, at: new Date(base + (m * 60 + s) * 1000).toISOString(), userId: who, text }));
}

const MATEO = 'guest:iv-j6x2d9sb';
const mateoStart = () => at(-3, 14);
const MATEO_SAID: Said[] = [
  [0, 20, HUGO, "Hi Mateo, thanks for joining. I'm Hugo, I lead the payments platform team. We have about an hour, mostly coding."],
  [0, 35, MATEO, 'Hi Hugo, thanks for having me. Sounds good.'],
  [1, 10, HUGO, 'The first problem: implement a rate limiter that allows bursts of up to N requests and refills at R tokens per second. Talk me through your thinking before you write anything.'],
  [1, 40, MATEO, 'Sure. Is this per client, per API key, or global?'],
  [1, 52, HUGO, 'Per API key. Assume a single process to start with.'],
  [2, 30, MATEO, "Then I'd keep a map from key to a small bucket record: the tokens left and the last time it was refilled."],
  [3, 15, MATEO, "On each request I'd work out how much time has passed, add that times R, cap it at N, and then take one token if there is one."],
  [3, 40, HUGO, "What does the caller get when there isn't a token?"],
  [4, 5, MATEO, "A rejection with a retry-after, worked out from how long until the next token. I'd rather not block the request thread."],
  [6, 30, HUGO, "Good. Go ahead and write it, and say what you're doing as you go."],
  [7, 10, MATEO, "I'll start with the bucket type and a clock I can pass in, so it's testable without sleeping."],
  [9, 45, MATEO, "Here's the refill: elapsed seconds times the rate, then the smaller of that plus the current tokens and the capacity."],
  [11, 20, HUGO, 'How do you handle two requests for the same key at the same moment?'],
  [11, 50, MATEO, "In one process I'd guard each bucket with a lock, or do the update in a compare-and-set loop. Across processes it changes."],
  [12, 40, HUGO, "Say it's across processes. What would you do?"],
  [13, 30, MATEO, "I'd move the bucket into Redis and do the refill and the take in one script, so it's atomic on the server."],
  [14, 45, HUGO, "Earlier you mentioned you'd built something like this at your current company. How was that one done?"],
  [15, 20, MATEO, 'We used a simpler scheme for the driver app\'s location pings.'],
  [16, 5, MATEO, 'Honestly it was a fixed-window counter: each key gets a fixed window that resets every minute, and we count requests in it.'],
  [16, 40, HUGO, 'Why that rather than a bucket?'],
  [17, 5, MATEO, 'It was one counter and one expiry per key, cheap to run, and the traffic was smooth enough that nobody noticed the edges.'],
  [17, 40, HUGO, 'Okay.'],
  [18, 35, HUGO, 'What happens to a request that arrives just as the window resets?'],
  [19, 10, MATEO, "It lands in the new window, so a client can send a full window's worth just before the reset and another just after. That's twice the limit in a couple of seconds, which is what the bucket avoids."],
  [24, 0, HUGO, "Let's move to the second problem: wrap a flaky payment-provider call with retries, backoff and an idempotency key."],
  [25, 10, MATEO, "The key comes first. I'd make it once per charge from our side and send the same key on every retry, so the provider can drop a duplicate."],
  [27, 30, MATEO, "Backoff doubles from a hundred milliseconds with some jitter, capped at a few seconds, and I'd only retry timeouts and server errors, never a decline."],
  [31, 15, HUGO, 'What if our process dies after the provider charged but before we saved the result?'],
  [32, 0, MATEO, "Then the next attempt reuses the stored key, the provider returns the original result, and we record it. That's why the key has to be saved before the first call."],
  [52, 30, HUGO, "We're near time. What questions do you have for me?"],
  [53, 5, MATEO, 'How does the team decide when to pay down something like that fixed-window limiter?'],
  [57, 40, HUGO, 'Thanks Mateo, that was a good session. Greta will be in touch about next steps.'],
];

const INGRID = 'guest:iv-f2b6t5zh';
const ingridStart = () => at(-6, 13);
const INGRID_SAID: Said[] = [
  [0, 15, WEN, "Hi Ingrid, I'm Wen. This round is about how you work with other people, so it's stories rather than code."],
  [0, 30, INGRID, 'Hi Wen. Happy to.'],
  [1, 5, WEN, 'Tell me about an incident you led from detection to the write-up. What changed afterwards?'],
  [1, 50, INGRID, "The one I'd pick is the authorisation service in the spring. Card approvals started timing out in one region on a Friday evening."],
  [2, 40, INGRID, 'The alerts fired on the error rate first, and within ten minutes about a fifth of approvals were failing.'],
  [3, 20, WEN, 'What did you do in the first few minutes?'],
  [3, 55, INGRID, "I opened the incident channel and posted what we knew and what we didn't, so nobody had to ask."],
  [4, 40, INGRID, 'I paged the on-call lead and we split the investigation: she took the database side and I took the network path.'],
  [5, 30, WEN, 'How did you decide on that split?'],
  [6, 5, INGRID, 'Those were the two places a timeout could come from, and we each knew one of them better.'],
  [7, 0, INGRID, 'It turned out to be connection pool exhaustion after a config change raised the timeout on a downstream call.'],
  [7, 45, WEN, 'How long until it was back?'],
  [8, 10, INGRID, 'About forty minutes to mitigate by rolling the config back, and the write-up was on the Tuesday.'],
  [8, 40, WEN, 'Mm-hm.'],
  [9, 25, WEN, 'Who did you bring in first when the alerts started, and how did you keep them updated?'],
  [10, 5, INGRID, 'The on-call lead first, then the payments product manager once we knew customers were affected. I posted an update every fifteen minutes even when nothing had changed.'],
  [11, 0, WEN, 'Why every fifteen minutes, even with nothing new?'],
  [11, 30, INGRID, "Because silence reads as nobody working on it. A short note saying we're still on it and when the next update is saves ten people asking."],
  [12, 30, WEN, 'And what changed afterwards?'],
  [13, 10, INGRID, 'We added a check on pool settings to the config review, and an alert on pool wait time, not just on errors.'],
  [15, 0, WEN, 'Second question. Describe a time you disagreed with a technical decision your team had already made. What did you do?'],
  [15, 45, INGRID, "We'd chosen to move the service to a second region as active-passive, and I thought active-active was worth the extra work."],
  [16, 40, INGRID, "I wrote up the failover time we'd get with each, with numbers from the last two incidents, and asked for thirty minutes in the design review."],
  [17, 50, WEN, 'How did that go?'],
  [18, 20, INGRID, 'We stayed active-passive for the first release, which was the right call for the deadline, and we agreed a date to look at it again.'],
  [19, 30, WEN, 'What did you do once the decision went the other way?'],
  [20, 0, INGRID, 'I helped build it. I wrote the failover runbook, and we made the active-active move two quarters later.'],
  [22, 10, WEN, "Is there anything you'd do differently?"],
  [22, 45, INGRID, "I'd bring the numbers before the decision, not after it."],
  [41, 0, WEN, "We're almost at time. What would you like to ask me?"],
  [41, 30, INGRID, 'How does the team run its incident reviews? Does someone outside the team read them?'],
  [44, 20, WEN, 'Thanks Ingrid, it was good to talk. Greta will be in touch.'],
];

const INGRID_CODE = 'guest:iv-d7q4n9xe';
const ingridCodeStart = () => at(-9, 14);
const INGRID_CODE_SAID: Said[] = [
  [0, 20, HUGO, "Hi Ingrid, I'm Hugo, I lead the payments platform team. This one is mostly coding, so we'll share a pad."],
  [0, 40, INGRID_CODE, 'Hi Hugo, great to meet you. Ready when you are.'],
  [1, 35, HUGO, 'The first problem is a rate limiter: bursts of up to N requests, refilling at R tokens a second. Say what you are thinking as you go.'],
  [2, 10, INGRID_CODE, 'Can I assume a single process and one limiter per key?'],
  [2, 25, HUGO, 'Yes, to start with.'],
  [3, 30, INGRID_CODE, "I'll keep the tokens and the time of the last refill, and work the refill out when a request arrives instead of on a timer."],
  [6, 20, INGRID_CODE, "I'm writing the constructor now: capacity, rate, tokens start full."],
  [8, 40, INGRID_CODE, 'Then allow: add elapsed time times the rate, cap at capacity, and take one token if there is one.'],
  [12, 30, INGRID_CODE, "Let me run it with a burst of five and see what comes back."],
  [13, 5, INGRID_CODE, "That's a mistake of mine: I called allow without the time, so the call is wrong. Fixing the call."],
  [14, 10, HUGO, 'While you fix it, what would you do if two threads called allow at once?'],
  [14, 50, INGRID_CODE, 'A lock around the refill and the take. I would keep it per key so different keys do not wait on each other.'],
  [15, 50, INGRID_CODE, 'Running it again.'],
  [16, 20, HUGO, 'Good, that passes. What is the one test you would add?'],
  [16, 55, INGRID_CODE, 'A refill test with a fake clock: drain the bucket, move the clock one second, expect exactly R tokens back.'],
  [26, 40, HUGO, 'Second problem: wrap a flaky payment-provider call with retries, backoff and an idempotency key.'],
  [27, 40, INGRID_CODE, 'The key is made once per charge and sent on every attempt, so a retry can never double-charge.'],
  [29, 10, INGRID_CODE, "Backoff starts at a hundred milliseconds, doubles, adds jitter, and I only retry timeouts and server errors."],
  [32, 30, HUGO, 'How long do you keep the key?'],
  [33, 5, INGRID_CODE, 'Longer than the longest retry window plus the provider\'s own dedupe window, so a day is a reasonable default.'],
  [34, 45, INGRID_CODE, 'Running it against a provider that fails twice first.'],
  [35, 20, HUGO, 'Three calls, one charge. That is what I wanted to see.'],
  [52, 10, HUGO, 'We are near time. What would you like to ask me?'],
  [52, 40, INGRID_CODE, 'What does on-call look like for the payments team?'],
  [55, 10, HUGO, 'Thanks Ingrid. Greta will be in touch about the next step.'],
];

const RAVI_CODE = 'guest:iv-p2v7j4ye';
const raviStart = () => at(-2, 15);
const RAVI_SAID: Said[] = [
  [0, 20, WEN, "Hi Ravi, I'm Wen. We'll build two small things in Swift on a shared pad. Talk through it as you go."],
  [0, 40, RAVI_CODE, 'Hi Wen, thanks for having me.'],
  [1, 25, WEN, 'First: a paginated list that loads the next page as the user nears the end, and keeps the pages it has when the app goes offline.'],
  [2, 15, RAVI_CODE, "I'd put the paging in a model object and have the list ask it to load more when a row near the end appears."],
  [3, 5, WEN, 'How do you avoid loading the same page twice?'],
  [3, 40, RAVI_CODE, 'I keep a set of the pages already requested and check it before asking, so a fast scroll cannot send the same request twice.'],
  [6, 30, RAVI_CODE, "I'm writing the list view first, with the row's appear handler calling the model."],
  [9, 20, RAVI_CODE, 'I have the model from an earlier project, so I will paste it in and adapt it rather than retype it.'],
  [11, 10, WEN, 'Fine. Say what you are changing.'],
  [12, 0, RAVI_CODE, 'The page number comes from the item count, and I insert it into the set before the request goes out.'],
  [14, 40, RAVI_CODE, "Let me run it to see the loading call happen once."],
  [15, 20, RAVI_CODE, 'It stops with the fatal error. The second call asked for page two again, so my guard is too late.'],
  [16, 10, WEN, 'What does that tell you?'],
  [16, 45, RAVI_CODE, 'That I need to mark the page before the request starts, not when it returns. I will move that line up.'],
  [20, 30, WEN, 'And what does the user see while offline?'],
  [21, 10, RAVI_CODE, 'The pages already loaded, and a small banner saying the next page could not be reached, with a retry.'],
  [31, 40, WEN, 'Second problem: debounce a search field so a request goes out only after the user stops typing for 300 milliseconds, and cancel the one already in flight.'],
  [32, 30, RAVI_CODE, 'I would hold the pending work as a task, cancel it on every keystroke and start a new one that sleeps first.'],
  [36, 15, RAVI_CODE, 'Cancelling the task also cancels the request it started, as long as the request is awaited inside it.'],
  [38, 50, WEN, 'How would you test the timing without waiting in the test?'],
  [39, 30, RAVI_CODE, 'Pass in a clock the test controls, so the test moves time forward instead of sleeping.'],
  [41, 15, RAVI_CODE, 'Running it with two quick changes: the first search is cancelled and only the second returns.'],
  [42, 0, WEN, 'That is the behaviour I was after.'],
  [54, 30, WEN, 'We are almost at time. What questions do you have?'],
  [55, 0, RAVI_CODE, 'How are the iOS and Android teams split on shared features?'],
  [57, 10, WEN, 'Thanks Ravi. Greta will be in touch.'],
];

const JONAH = 'guest:iv-g9r1y8lp';
const jonahStart = () => at(-1, 16);
const JONAH_SAID: Said[] = [
  [0, 15, WEN, "Hi Jonah, I'm Wen. This round is about how you lead a team, so we'll mostly talk through real situations."],
  [0, 35, JONAH, 'Hi Wen, thanks. Looking forward to it.'],
  [1, 20, WEN, 'Tell me about someone on your team who was struggling. What did you notice first?'],
  [2, 10, JONAH, 'A senior engineer who had been quick to review started leaving pull requests for days. I noticed it in the review queue before anyone told me.'],
  [3, 0, JONAH, "I didn't want to guess, so I asked him in our one-to-one how the work was going and listened."],
  [4, 20, WEN, 'What did he say?'],
  [4, 50, JONAH, 'That he had been moved onto an on-call rotation without being asked and was tired, and that he felt he could not say so.'],
  [6, 10, WEN, 'What did you do about it?'],
  [6, 55, JONAH, 'I took him out of the rotation for a month and asked the team to cover it, and I told the team why in general terms.'],
  [8, 30, JONAH, 'I also asked myself why he could not raise it, and that was on me. I had never said out loud that it was fine to push back.'],
  [9, 40, WEN, 'Mm-hm.'],
  [10, 40, WEN, 'How did the conversation start?'],
  [11, 15, JONAH, 'I set up a weekly one-to-one with him and we agreed a plan: the rotation change, a lighter month, and a check-in at the end.'],
  [12, 30, WEN, 'What did you say in that first conversation, and what did you agree to check on afterwards?'],
  [13, 20, JONAH, 'I said what I had seen, not what I had decided. We agreed to look at his review times and at how he felt about the load, in a month.'],
  [15, 30, WEN, 'And how did it turn out?'],
  [16, 10, JONAH, 'His review times came back in three weeks. He took the rotation again after the month, with a fairer schedule.'],
  [18, 40, WEN, 'Would you do anything differently?'],
  [19, 20, JONAH, 'I would have noticed sooner. I now look at review times and on-call load every month, before anyone has to tell me.'],
  [24, 0, WEN, "Second question. Your team's roadmap slips by a quarter. Walk me through how you tell your stakeholders and what you change."],
  [24, 50, JONAH, 'It happened to me last year with a migration for a large customer. I told the team on Monday we would be a week late and I told the customer the same day.'],
  [26, 30, JONAH, "I'd rather hand over a late date early than an on-time date I did not believe."],
  [28, 10, WEN, 'What did the customer say?'],
  [28, 40, JONAH, 'They were unhappy for a day and then asked for a daily note, which we gave them. We shipped on the new date.'],
  [31, 30, WEN, 'What did you change in how you plan?'],
  [32, 10, JONAH, 'I ask the team for a range, not a date, and I put the risky piece first.'],
  [52, 0, WEN, "We're nearly at time. What would you like to ask me?"],
  [52, 30, JONAH, 'How does the team decide who takes the on-call rotation, and how often is it reviewed?'],
  [53, 20, WEN, 'Thanks Jonah. Greta will be in touch.'],
];

export const interviewRecordingsFixture = defineFixture<RecordingStandIn>({
  key: 'interviews.recordings',
  scenarios: {
    default: () => [
      { interviewId: 'iv-j6x2d9sb', startedAt: mateoStart(), durationSeconds: 58 * 60 + 20 },
      { interviewId: 'iv-f2b6t5zh', startedAt: ingridStart(), durationSeconds: 44 * 60 + 50 },
      { interviewId: 'iv-d7q4n9xe', startedAt: ingridCodeStart(), durationSeconds: 55 * 60 + 40 },
      { interviewId: 'iv-p2v7j4ye', startedAt: raviStart(), durationSeconds: 57 * 60 + 10 },
      { interviewId: 'iv-g9r1y8lp', startedAt: jonahStart(), durationSeconds: 53 * 60 + 40 },
    ],
    empty: () => [],
  },
});

export const interviewRecordLinesFixture = defineFixture<RecordLineSeed>({
  key: 'interviews.record-lines',
  scenarios: {
    default: () => [...lines('iv-j6x2d9sb', mateoStart, MATEO_SAID), ...lines('iv-f2b6t5zh', ingridStart, INGRID_SAID),
      ...lines('iv-d7q4n9xe', ingridCodeStart, INGRID_CODE_SAID), ...lines('iv-p2v7j4ye', raviStart, RAVI_SAID), ...lines('iv-g9r1y8lp', jonahStart, JONAH_SAID)],
    empty: () => [],
  },
});
