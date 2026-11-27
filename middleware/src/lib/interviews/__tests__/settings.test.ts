// The interviews settings list (row I6.4; contract F3): every setting by name, its value and its default, from the
// existing readers.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, mock: { aurora: true } } }));
jest.mock('../../role-registry.js', () => ({ roleRegistry: () => [] }));

import { interviewsSettings } from '../settings.js';

const byName = (env: NodeJS.ProcessEnv) => Object.fromEntries(interviewsSettings(env).map((s) => [s.name, s]));

describe('interviewsSettings', () => {
  it('lists every setting with its default when nothing is set', () => {
    const all = interviewsSettings({});
    expect(all.map((s) => s.name)).toEqual([
      'INTERVIEWS_ENABLED', 'INTERVIEWS_MEDIA_RETENTION_DAYS', 'INTERVIEWS_RECORD_RETENTION_YEARS', 'INTERVIEWS_DELETION_WITHIN_DAYS',
      'INTERVIEWS_SOON_MINUTES', 'INTERVIEWS_SCORECARD_OVERDUE_HOURS', 'INTERVIEWS_REQUIRED_CONSENTS', 'INTERVIEWS_INTERVIEW_CAP_USD', 'INTERVIEWS_RUN_PRICE_USD', 'INTERVIEWS_GUEST_REALTIME',
      'INTERVIEWS_RUN_BACKEND', 'INTERVIEWS_CODE_INTERPRETER_ID',
    ]);
    for (const s of all) expect([s.name, s.value]).toEqual([s.name, s.default]);
    expect(byName({})['INTERVIEWS_SOON_MINUTES']!.default).toBe(15);
    expect(byName({})['INTERVIEWS_REQUIRED_CONSENTS']!.default).toEqual([]);
    expect(byName({})['INTERVIEWS_MEDIA_RETENTION_DAYS']!.default).toBe(90);
  });

  it('lists the runner choice read-only, as the selector reads it', () => {
    expect(byName({})['INTERVIEWS_RUN_BACKEND']).toMatchObject({ value: 'mock', default: 'mock' });
    const s = byName({ INTERVIEWS_RUN_BACKEND: 'agentcore', INTERVIEWS_CODE_INTERPRETER_ID: ' ci-1 ' });
    expect(s['INTERVIEWS_RUN_BACKEND']!.value).toBe('agentcore');
    expect(s['INTERVIEWS_CODE_INTERPRETER_ID']).toMatchObject({ value: 'ci-1', default: '' });
    expect(byName({ INTERVIEWS_RUN_BACKEND: 'lambda' })['INTERVIEWS_RUN_BACKEND']!.value).toBe('none');
  });

  it('shows the values the readers use, a bad one as the reader\'s fallback', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const s = byName({
        INTERVIEWS_ENABLED: 'false', INTERVIEWS_MEDIA_RETENTION_DAYS: '30', INTERVIEWS_SOON_MINUTES: '45', INTERVIEWS_REQUIRED_CONSENTS: 'milo',
        INTERVIEWS_INTERVIEW_CAP_USD: '4.5', INTERVIEWS_RUN_PRICE_USD: '0.01', INTERVIEWS_GUEST_REALTIME: '0', INTERVIEWS_RECORD_RETENTION_YEARS: 'forever',
      });
      expect(s['INTERVIEWS_ENABLED']!.value).toBe(false);
      expect(s['INTERVIEWS_MEDIA_RETENTION_DAYS']!.value).toBe(30);
      expect(s['INTERVIEWS_SOON_MINUTES']!.value).toBe(45);
      expect(s['INTERVIEWS_REQUIRED_CONSENTS']!.value).toEqual(['transcription', 'milo']);
      expect(s['INTERVIEWS_INTERVIEW_CAP_USD']!.value).toBe(4.5);
      expect(s['INTERVIEWS_RUN_PRICE_USD']!.value).toBe(0.01);
      expect(byName({ INTERVIEWS_RUN_PRICE_USD: '-1' })['INTERVIEWS_RUN_PRICE_USD']!.value).toBe(0.0017);
      expect(s['INTERVIEWS_GUEST_REALTIME']!.value).toBe(false);
      expect(s['INTERVIEWS_RECORD_RETENTION_YEARS']!.value).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });
});

// Lane H5 (OWED O-180): the deletion period and the flag.
describe('the deletion period (INTERVIEWS_DELETION_WITHIN_DAYS)', () => {
  it('is 30 days with the flag off and the setting unset, and a bad value falls back to 30', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const off = byName({ INTERVIEWS_ENABLED: 'false' });
      expect(off['INTERVIEWS_ENABLED']!.value).toBe(false);
      expect(off['INTERVIEWS_DELETION_WITHIN_DAYS']).toMatchObject({ value: 30, default: 30 });
      for (const bad of ['0', '91', '30.5', '-30', 'thirty', ' ']) {
        expect(byName({ INTERVIEWS_ENABLED: 'false', INTERVIEWS_DELETION_WITHIN_DAYS: bad })['INTERVIEWS_DELETION_WITHIN_DAYS']!.value).toBe(30);
      }
      // The setting is read whatever the flag: a deployment that turns the tenant on later keeps its period.
      expect(byName({ INTERVIEWS_ENABLED: 'false', INTERVIEWS_DELETION_WITHIN_DAYS: '45' })['INTERVIEWS_DELETION_WITHIN_DAYS']!.value).toBe(45);
      expect(byName({ INTERVIEWS_DELETION_WITHIN_DAYS: '1' })['INTERVIEWS_DELETION_WITHIN_DAYS']!.value).toBe(1);
      expect(byName({ INTERVIEWS_DELETION_WITHIN_DAYS: '90' })['INTERVIEWS_DELETION_WITHIN_DAYS']!.value).toBe(90);
      // No warning names another setting's value.
      for (const [line] of warn.mock.calls) expect(String(line)).not.toMatch(/thirty|30\.5/);
    } finally {
      warn.mockRestore();
    }
  });

  it('sets how long a request may take: its due date is that many days after it was asked', async () => {
    const { deletionDueByMs } = await import('../retention/rules.js');
    const { retentionPeriods } = await import('../retention/periods.js');
    const asked = Date.parse('2026-11-17T10:00:00.000Z');
    expect(deletionDueByMs(asked, retentionPeriods({ INTERVIEWS_ENABLED: 'false' }))).toBe(asked + 30 * 86_400_000);
    expect(deletionDueByMs(asked, retentionPeriods({ INTERVIEWS_DELETION_WITHIN_DAYS: '7' }))).toBe(asked + 7 * 86_400_000);
  });
});
