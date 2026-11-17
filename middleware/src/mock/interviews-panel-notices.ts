// The panel's notice fixture (docs/interviews-tenant-plan.md decision 5, its last sentence): the mock world's
// interview_panel_notices.
//
// Wen acknowledged the current notice when she accepted her first seated round, so every round she sits on is
// consistent and her Accept goes straight through. Hugo acknowledged an EARLIER version of the notice when he
// accepted his first round; the notice has changed since, so his rounds already accepted stay accepted and the
// round he still has to answer asks him to read the current one first: the flow the demo shows.
// Registered from its own module (lib/interviews/consent/panel-notice-store.ts imports it), so mock/interviews.ts
// is untouched. Times follow mock/interviews.ts: a day after each round's assignment.
import { clock, defineFixture } from './core/index.js';
import { CONSENT_NOTICE } from '../lib/interviews/consent/notice.js';
import type { PanelNoticeRow } from '../lib/interviews/consent/panel-notice-store.js';
import { HUGO, WEN } from './interviews.js';

/** The version Hugo read: any version other than the current one asks again. */
export const EARLIER_NOTICE_VERSION = '2026-11-02.1';

export const interviewPanelNoticesFixture = defineFixture<PanelNoticeRow>({
  key: 'interviews.panel-notices',
  scenarios: {
    default: () => [
      { userId: HUGO, noticeVersion: EARLIER_NOTICE_VERSION, acknowledgedAt: clock.daysAgo(14), interviewId: 'iv-ingrid-coding' },
      { userId: WEN, noticeVersion: CONSENT_NOTICE.version, acknowledgedAt: clock.daysAgo(13), interviewId: 'iv-ingrid-together' },
    ],
    empty: () => [],
  },
});
