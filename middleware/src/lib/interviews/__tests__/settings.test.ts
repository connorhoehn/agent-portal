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
      'INTERVIEWS_SOON_MINUTES', 'INTERVIEWS_REQUIRED_CONSENTS', 'INTERVIEWS_INTERVIEW_CAP_USD', 'INTERVIEWS_GUEST_REALTIME',
    ]);
    for (const s of all) expect([s.name, s.value]).toEqual([s.name, s.default]);
    expect(byName({})['INTERVIEWS_SOON_MINUTES']!.default).toBe(15);
    expect(byName({})['INTERVIEWS_REQUIRED_CONSENTS']!.default).toEqual([]);
    expect(byName({})['INTERVIEWS_MEDIA_RETENTION_DAYS']!.default).toBe(90);
  });

  it('shows the values the readers use, a bad one as the reader\'s fallback', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const s = byName({
        INTERVIEWS_ENABLED: 'false', INTERVIEWS_MEDIA_RETENTION_DAYS: '30', INTERVIEWS_SOON_MINUTES: '45', INTERVIEWS_REQUIRED_CONSENTS: 'milo',
        INTERVIEWS_INTERVIEW_CAP_USD: '4.5', INTERVIEWS_GUEST_REALTIME: '0', INTERVIEWS_RECORD_RETENTION_YEARS: 'forever',
      });
      expect(s['INTERVIEWS_ENABLED']!.value).toBe(false);
      expect(s['INTERVIEWS_MEDIA_RETENTION_DAYS']!.value).toBe(30);
      expect(s['INTERVIEWS_SOON_MINUTES']!.value).toBe(45);
      expect(s['INTERVIEWS_REQUIRED_CONSENTS']!.value).toEqual(['transcription', 'milo']);
      expect(s['INTERVIEWS_INTERVIEW_CAP_USD']!.value).toBe(4.5);
      expect(s['INTERVIEWS_GUEST_REALTIME']!.value).toBe(false);
      expect(s['INTERVIEWS_RECORD_RETENTION_YEARS']!.value).toBe(4);
    } finally {
      warn.mockRestore();
    }
  });
});
