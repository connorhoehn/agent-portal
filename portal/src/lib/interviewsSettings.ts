// The tenant's read-only Settings (GET /api/interviews/settings; gap audit 2026-11-20, minor): what this deployment runs
// the tenant with, for the recruiter and the admin. Nothing here writes; a setting changes in the deployment's environment.
import { INTERVIEWS_API } from './interviews.ts';

export type SettingGroup = 'retention' | 'consent' | 'runner' | 'other';
export type SettingValue = boolean | number | string[] | string;

export interface SettingRow {
  name: string;
  group: SettingGroup;
  about: string;
  value: SettingValue;
  default: SettingValue;
}

export const SETTINGS_PATH = `${INTERVIEWS_API}/settings`;
export const SETTINGS_HREF = '/interviews/settings';

export const SETTING_GROUP_LABELS: Readonly<Record<SettingGroup, string>> = {
  retention: 'Retention', consent: 'Consent', runner: 'Code runner', other: 'Other',
};
export const SETTING_GROUP_ORDER: readonly SettingGroup[] = ['retention', 'consent', 'runner', 'other'];

/** A value as a person reads it: On / Off, a list or None, Not set for an empty text, a number as it is. */
export function settingValueLabel(v: SettingValue): string {
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  if (Array.isArray(v)) return v.length ? v.join(', ') : 'None';
  if (typeof v === 'number') return String(v);
  return v.trim() ? v : 'Not set';
}

/** Whether the deployment changed the setting from its default. */
export const settingChanged = (s: Pick<SettingRow, 'value' | 'default'>): boolean => settingValueLabel(s.value) !== settingValueLabel(s.default);

/** The rows grouped in the page's order (retention, consent, runner, other), each group keeping the server's order. */
export const orderedSettings = (rows: readonly SettingRow[]): SettingRow[] =>
  SETTING_GROUP_ORDER.flatMap((g) => rows.filter((r) => r.group === g));
