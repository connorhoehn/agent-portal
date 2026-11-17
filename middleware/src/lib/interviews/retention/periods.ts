// The three retention periods, per deployment (docs/interviews-tenant-plan.md decision 17; rows I6.3 and the
// periods of I6.4). The candidate's notice (lib/interviews/consent/notice.ts) states the defaults; a deployment
// that sets other values should change the notice with them.
//
//   INTERVIEWS_MEDIA_RETENTION_DAYS   the recording, transcript, Milo's minutes and the code log: days after the
//                                     interview ends (default 90).
//   INTERVIEWS_RECORD_RETENTION_YEARS scorecards, consents and the log of what Milo showed: years after the
//                                     interview ends (default 4).
//   INTERVIEWS_DELETION_WITHIN_DAYS   how long a deletion request may take to finish (default 30): a request whose
//                                     erasers keep failing is retried by every sweep, and the log shows it overdue.
//
// Read on every run, so a change takes effect at the next sweep without a restart. A value that is not a whole
// number in range falls back to the default and says so once per value (never the value of another setting).

export const MEDIA_DAYS_SETTING = 'INTERVIEWS_MEDIA_RETENTION_DAYS';
export const RECORD_YEARS_SETTING = 'INTERVIEWS_RECORD_RETENTION_YEARS';
export const DELETION_DAYS_SETTING = 'INTERVIEWS_DELETION_WITHIN_DAYS';

export interface RetentionPeriods {
  mediaDays: number;
  recordYears: number;
  deletionDays: number;
}

export const DEFAULT_PERIODS: Readonly<RetentionPeriods> = Object.freeze({ mediaDays: 90, recordYears: 4, deletionDays: 30 });

const RANGES: Record<keyof RetentionPeriods, { setting: string; min: number; max: number }> = {
  mediaDays: { setting: MEDIA_DAYS_SETTING, min: 1, max: 3650 },
  recordYears: { setting: RECORD_YEARS_SETTING, min: 1, max: 50 },
  deletionDays: { setting: DELETION_DAYS_SETTING, min: 1, max: 90 },
};

const warned = new Set<string>();
/** Test seam: forget which fallbacks were already reported. */
export function resetPeriodWarnings(): void { warned.clear(); }

/** The periods this deployment runs with now. Never throws. */
export function retentionPeriods(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (l) => console.warn(l)): RetentionPeriods {
  const out = { ...DEFAULT_PERIODS };
  for (const key of Object.keys(RANGES) as (keyof RetentionPeriods)[]) {
    const { setting, min, max } = RANGES[key];
    const raw = env[setting]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (/^\d+$/.test(raw) && Number.isSafeInteger(n) && n >= min && n <= max) { out[key] = n; continue; }
    const once = `${setting}=${raw}`;
    if (!warned.has(once)) {
      warned.add(once);
      warn(`[interviews] ${setting} must be a whole number from ${min} to ${max}; using the default, ${DEFAULT_PERIODS[key]}.`);
    }
  }
  return out;
}
