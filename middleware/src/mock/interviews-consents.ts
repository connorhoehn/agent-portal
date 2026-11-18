// The consents fixture (docs/interviews-tenant-plan.md decision 5, row I2.3): the mock world's interview_consents.
//
// The five finished interviews in mock/interviews.ts carry a consent record (all three accepted under the
// notice in force that day, given twenty minutes before the call); the upcoming ones carry none, so the staff read shows
// both cases. Registered from its own module (lib/interviews/consent/store.ts imports it), so mock/interviews.ts
// is untouched. Times follow mock/interviews.ts's `at()`: working days from today (mock/interviews-days.ts), computed on read.
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import { CONSENT_NOTICE } from '../lib/interviews/consent/notice.js';
import type { ConsentRecord } from '../lib/interviews/consent/store.js';
import { LIVE_INTERVIEW_ID, liveStart } from './interviews.js';

/** Working days from today at an hour UTC (mock/interviews-days.ts). */
const at = seedAt;

/**
 * The notice an answer was given under (E4 finding 45): the current one from its day on; before that, the one it
 * replaced. An answer is never shown under a notice dated after it. Only rounds still open read the version (an answer
 * under an older notice is asked again); the finished rounds' answers stand as given.
 */
export const PREVIOUS_NOTICE_VERSION = '2026-10-26.1';
export function noticeAt(given: string): string {
  const day = Date.parse(`${CONSENT_NOTICE.version.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(day) || Date.parse(given) >= day ? CONSENT_NOTICE.version : PREVIOUS_NOTICE_VERSION;
}

function accepted(interviewId: string, given: string): ConsentRecord {
  const version = noticeAt(given);
  return {
    interviewId, noticeVersion: version,
    recording: true, recordingAt: given, transcription: true, transcriptionAt: given, milo: true, miloAt: given,
    answeredAt: given, changedAt: given,
    history: [{ at: given, noticeVersion: version, recording: true, transcription: true, milo: true, miloForcedOff: false }],
    revision: 1,
  };
}

export const interviewConsentsFixture = defineFixture<ConsentRecord>({
  key: 'interviews.consents',
  scenarios: {
    default: () => [
      // Twenty minutes before each finished interview's start (mock/interviews.ts).
      accepted('iv-d7q4n9xe', at(-9, 13, 40)),
      accepted('iv-f2b6t5zh', at(-6, 12, 40)),
      accepted('iv-j6x2d9sb', at(-3, 13, 40)),
      accepted('iv-p2v7j4ye', at(-2, 14, 40)),
      accepted('iv-g9r1y8lp', at(-1, 15, 40)),
      // Kwame's round, live now: his three answers (all yes) were given twenty minutes before it started.
      accepted(LIVE_INTERVIEW_ID, new Date(Date.parse(liveStart()) - 20 * 60_000).toISOString()),
    ],
  },
});
