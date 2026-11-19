// The consents fixture (docs/interviews-tenant-plan.md decision 5, row I2.3): the mock world's interview_consents.
//
// The five finished interviews in mock/interviews.ts carry a consent record (all three accepted under the
// current notice, given twenty minutes before the call); the upcoming ones carry none, so the staff read shows
// both cases. Registered from its own module (lib/interviews/consent/store.ts imports it), so mock/interviews.ts
// is untouched. Times follow mock/interviews.ts's `at()`: working days from today (mock/interviews-days.ts), computed on read.
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import { CONSENT_NOTICE } from '../lib/interviews/consent/notice.js';
import type { ConsentRecord } from '../lib/interviews/consent/store.js';
import { LIVE_INTERVIEW_ID, liveStart } from './interviews.js';

/** Working days from today at an hour UTC (mock/interviews-days.ts). */
const at = seedAt;

function accepted(interviewId: string, given: string): ConsentRecord {
  const version = CONSENT_NOTICE.version;
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
      accepted('iv-b8w3q6ld', at(-7, 13, 40)),
      accepted('iv-f2b6t5zh', at(-6, 12, 40)),
      accepted('iv-j6x2d9sb', at(-3, 13, 40)),
      accepted('iv-p2v7j4ye', at(-2, 14, 40)),
      accepted('iv-g9r1y8lp', at(-1, 15, 40)),
      // Kwame's round, live now: his three answers (all yes) were given twenty minutes before it started.
      accepted(LIVE_INTERVIEW_ID, new Date(Date.parse(liveStart()) - 20 * 60_000).toISOString()),
    ],
  },
});
