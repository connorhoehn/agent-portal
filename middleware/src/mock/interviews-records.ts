// The interview record's stand-in (docs/interviews-tenant-plan.md decision 19, "Recordings in the mock world", row I5.1).
//
// The mock world has no media server and the meeting assistant's memory store starts empty, so two finished interviews of
// mock/interviews.ts carry what a real call would have left behind: a recording row (when it started and how long it ran,
// nothing playable) and the transcript lines the meeting assistant would have stored. lib/interviews/record/ reads both
// only in the mock world and only when no stored call of that interview is found.
//
//   iv-mateo-coding      Mateo's coding round, Hugo leads: a rate limiter, then retries with an idempotency key.
//   iv-ingrid-together   Ingrid's "Working together" round, Wen leads: an incident she led, then a disagreement.
//
// The words line up with mock/interviews-suggestions.ts (the quotes those suggestions were based on, and the questions the
// lead asked once they were answered). Seeded names only. Times follow mock/interviews.ts's `at()`: days from today's UTC
// midnight, computed on read.
import { clock, defineFixture } from './core/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function at(days: number, hour: number, minute = 0, second = 0): string {
  const now = clock.now().getTime();
  const midnight = now - (now % DAY_MS);
  return new Date(midnight + days * DAY_MS + ((hour * 60 + minute) * 60 + second) * 1000).toISOString();
}

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

const MATEO = 'guest:iv-mateo-coding';
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

const INGRID = 'guest:iv-ingrid-together';
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

export const interviewRecordingsFixture = defineFixture<RecordingStandIn>({
  key: 'interviews.recordings',
  scenarios: {
    default: () => [
      { interviewId: 'iv-mateo-coding', startedAt: mateoStart(), durationSeconds: 58 * 60 + 20 },
      { interviewId: 'iv-ingrid-together', startedAt: ingridStart(), durationSeconds: 44 * 60 + 50 },
    ],
    empty: () => [],
  },
});

export const interviewRecordLinesFixture = defineFixture<RecordLineSeed>({
  key: 'interviews.record-lines',
  scenarios: {
    default: () => [...lines('iv-mateo-coding', mateoStart, MATEO_SAID), ...lines('iv-ingrid-together', ingridStart, INGRID_SAID)],
    empty: () => [],
  },
});
