// Every interviews setting this deployment runs with (docs/interviews-tenant-plan.md row I6.4; contract F3), for the
// hardening pass and the deploy checklist. No route, no page. Each entry calls the reader that already exists, so a
// value here is exactly the value the code uses; nothing is parsed twice and no reader moved.
//
// `value` is what the reader answers with the deployment's environment; `default` is what it answers with the setting
// unset (for the flag and guest realtime that follows the world: on under the mock providers, off on a cluster).
// A bad value shows here as the reader's fallback, and the reader has already warned once about it.

import { interviewsEnabled } from './flag.js';
import { guestRealtimeEnabled } from './invite/realtime.js';
import { DEFAULT_PERIODS, DELETION_DAYS_SETTING, MEDIA_DAYS_SETTING, RECORD_YEARS_SETTING, retentionPeriods } from './retention/periods.js';
import { SOON_MINUTES, SOON_MINUTES_SETTING, soonMinutes } from './soon.js';
import { REQUIRED_CONSENTS_SETTING, requiredConsents } from './consent/required.js';
import { DEFAULT_INTERVIEW_CAP_USD, defaultInterviewCapUsd } from './spend.js';
import { DEFAULT_RUN_PRICE_USD, RUN_PRICE_SETTING, runPriceUsd } from './runs/service.js';

export type SettingValue = boolean | number | string[];

export interface InterviewsSetting {
  name: string;
  value: SettingValue;
  default: SettingValue;
  /** What it governs, in one line, for a checklist. */
  about: string;
}

const NO_WARN = (): void => undefined;

/** The settings, in a fixed order. Never throws. */
export function interviewsSettings(env: NodeJS.ProcessEnv = process.env): InterviewsSetting[] {
  const periods = retentionPeriods(env);
  return [
    { name: 'INTERVIEWS_ENABLED', value: interviewsEnabled(env), default: interviewsEnabled({}), about: 'The tenant is on: every interviews route answers.' },
    { name: MEDIA_DAYS_SETTING, value: periods.mediaDays, default: DEFAULT_PERIODS.mediaDays, about: 'Days the recording, transcript, minutes and code log are kept after the interview.' },
    { name: RECORD_YEARS_SETTING, value: periods.recordYears, default: DEFAULT_PERIODS.recordYears, about: 'Years the scorecards, consents and Milo log are kept after the interview.' },
    { name: DELETION_DAYS_SETTING, value: periods.deletionDays, default: DEFAULT_PERIODS.deletionDays, about: 'Days a deletion request may take to finish.' },
    { name: SOON_MINUTES_SETTING, value: soonMinutes(env), default: SOON_MINUTES, about: 'Minutes before the start the starting-soon bell rings.' },
    { name: REQUIRED_CONSENTS_SETTING, value: requiredConsents(env), default: requiredConsents({}, NO_WARN), about: 'Consents the call cannot start without (declining is still stored).' },
    { name: 'INTERVIEWS_INTERVIEW_CAP_USD', value: defaultInterviewCapUsd(env), default: DEFAULT_INTERVIEW_CAP_USD, about: 'Dollars an interview may spend when its opening sets no cap.' },
    { name: RUN_PRICE_SETTING, value: runPriceUsd(env), default: DEFAULT_RUN_PRICE_USD, about: 'Dollars held and booked for each run of the code pad (the mock executor\'s price).' },
    { name: 'INTERVIEWS_GUEST_REALTIME', value: guestRealtimeEnabled(env), default: guestRealtimeEnabled({}), about: 'A candidate may hold a realtime token for the call.' },
  ];
}
