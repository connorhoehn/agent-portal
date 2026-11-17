// The classes, the periods and when each is due (lib/interviews/retention/rules.ts, periods.ts; row I6.3).
import { DEFAULT_PERIODS, DELETION_DAYS_SETTING, MEDIA_DAYS_SETTING, RECORD_YEARS_SETTING, resetPeriodWarnings, retentionPeriods } from '../periods.js';
import { DAY_MS, REDACTED_CONTACT, addYears, candidateRecordsDue, deletionDueByMs, dueAtMs, isDue, isRedacted, periodStartMs } from '../rules.js';
import type { Interview } from '../../types.js';

const END = Date.parse('2026-01-10T15:00:00.000Z');
const iv = (over: Partial<Interview> = {}): Interview => ({
  id: 'iv-x', applicationId: 'app-x', roundId: 'rd', type: 'technical', leadId: 'u-lead', panelIds: [], scheduledAt: '2026-01-10T14:00:00.000Z', minutes: 60,
  state: 'ended', questionIds: [], assignedBy: 'u-r', assignedAt: '2026-01-01T09:00:00.000Z', inviteTokenHash: null, callId: null,
  endedAt: new Date(END).toISOString(), acceptances: [], declines: [], revision: 1, ...over,
});
const p = DEFAULT_PERIODS;

describe('periods', () => {
  beforeEach(() => resetPeriodWarnings());
  it('defaults to 90 days, 4 years and 30 days', () => {
    expect(retentionPeriods({})).toEqual({ mediaDays: 90, recordYears: 4, deletionDays: 30 });
  });
  it('reads each setting per call', () => {
    expect(retentionPeriods({ [MEDIA_DAYS_SETTING]: '60', [RECORD_YEARS_SETTING]: '2', [DELETION_DAYS_SETTING]: '14' })).toEqual({ mediaDays: 60, recordYears: 2, deletionDays: 14 });
  });
  it('falls back to the default for a nonsense value and says so once per value', () => {
    const lines: string[] = [];
    const env = { [MEDIA_DAYS_SETTING]: 'ninety', [RECORD_YEARS_SETTING]: '0', [DELETION_DAYS_SETTING]: '1.5' };
    expect(retentionPeriods(env, (l) => lines.push(l))).toEqual(DEFAULT_PERIODS);
    expect(retentionPeriods(env, (l) => lines.push(l))).toEqual(DEFAULT_PERIODS);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/INTERVIEWS_MEDIA_RETENTION_DAYS must be a whole number from 1 to 3650; using the default, 90/);
  });
});

describe('when each class is due', () => {
  it('media: not at 89 days after the end, due at 91', () => {
    expect(isDue(iv(), 'media', p, END + 89 * DAY_MS)).toBe(false);
    expect(isDue(iv(), 'media', p, END + 91 * DAY_MS)).toBe(true);
  });
  it('records: not just under four years after the end, due just over', () => {
    const four = addYears(END, 4);
    expect(isDue(iv(), 'record', p, four - 60_000)).toBe(false);
    expect(isDue(iv(), 'record', p, four + 60_000)).toBe(true);
  });
  it('an open interview is never due, whatever its age', () => {
    for (const state of ['assigned', 'accepted', 'ready', 'live'] as const) {
      expect(periodStartMs(iv({ state, endedAt: null }))).toBeNull();
      expect(isDue(iv({ state, endedAt: null }), 'media', p, END + 10_000 * DAY_MS)).toBe(false);
    }
  });
  it('an ended interview without an end time counts from its scheduled end', () => {
    expect(periodStartMs(iv({ endedAt: null }))).toBe(Date.parse('2026-01-10T15:00:00.000Z'));
  });
  it('a declined interview counts from the last decline, a cancelled one from its assignment', () => {
    const declined = iv({ state: 'declined', endedAt: null, declines: [{ userId: 'u', seat: 'lead', reason: 'r', at: '2026-01-03T00:00:00.000Z' }, { userId: 'v', seat: 'panel', reason: 'r', at: '2026-01-04T00:00:00.000Z' }] });
    expect(periodStartMs(declined)).toBe(Date.parse('2026-01-04T00:00:00.000Z'));
    expect(periodStartMs(iv({ state: 'cancelled', endedAt: null }))).toBe(Date.parse('2026-01-01T09:00:00.000Z'));
  });
  it('four calendar years from 29 February is 1 March', () => {
    expect(new Date(addYears(Date.parse('2028-02-29T12:00:00.000Z'), 4)).toISOString()).toBe('2032-02-29T12:00:00.000Z');
    expect(new Date(addYears(Date.parse('2028-02-29T12:00:00.000Z'), 1)).toISOString()).toBe('2029-03-01T12:00:00.000Z');
  });
  it('a deletion is due within the deletion period', () => {
    expect(deletionDueByMs(END, p)).toBe(END + 30 * DAY_MS);
    expect(dueAtMs(iv(), 'media', p)).toBe(END + 90 * DAY_MS);
  });
  it('a candidate\'s own details are due only when every interview is past its record period', () => {
    const late = addYears(END, 4) + DAY_MS;
    expect(candidateRecordsDue([iv(), iv({ id: 'b' })], p, late)).toBe(true);
    expect(candidateRecordsDue([iv(), iv({ id: 'b', state: 'ready', endedAt: null })], p, late)).toBe(false);
    expect(candidateRecordsDue([], p, late)).toBe(false);
  });
});

describe('redaction', () => {
  it('leaves a placeholder name and empty contact fields, and knows a redacted row', () => {
    expect(REDACTED_CONTACT).toEqual({ name: 'Name removed', email: '', headline: '', location: '', notes: '' });
    expect(isRedacted(REDACTED_CONTACT)).toBe(true);
    expect(isRedacted({ name: 'A Person', email: 'a@example.test' })).toBe(false);
  });
});
