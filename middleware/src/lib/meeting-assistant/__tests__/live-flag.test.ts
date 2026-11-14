// MEETING_ASSISTANT_LIVE: off by default, picks the real provider session in the mock world, never in production.
const mockConfig = { region: 'us-east-1', auth: {}, cognito: {}, mock: { aurora: true }, meetingAssistant: { enabled: true, transcriptRetentionDays: 30 } };
jest.mock('../../../config.js', () => ({ config: mockConfig }));

import { assertLiveFlagAllowed, liveFlagRequested, liveForced } from '../live-flag.js';
import { defaultSessionFactory } from '../session-select.js';

const saved = { live: process.env['MEETING_ASSISTANT_LIVE'], key: process.env['OPENAI_API_KEY'], env: process.env['NODE_ENV'], model: process.env['VOICE_MODEL'], deleg: process.env['LIVE_DELEGATION_MODEL'] };
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
afterEach(() => {
  restore('MEETING_ASSISTANT_LIVE', saved.live); restore('OPENAI_API_KEY', saved.key); restore('NODE_ENV', saved.env);
  restore('VOICE_MODEL', saved.model); restore('LIVE_DELEGATION_MODEL', saved.deleg);
});

describe('the flag', () => {
  it('is off unless it is 1 or true', () => {
    for (const v of [undefined, '', '0', 'false', 'yes', 'on']) expect(liveFlagRequested({ MEETING_ASSISTANT_LIVE: v })).toBe(false);
    for (const v of ['1', 'true', ' 1 ']) expect(liveFlagRequested({ MEETING_ASSISTANT_LIVE: v })).toBe(true);
  });

  it('means nothing in production, and a process started that way refuses', () => {
    expect(liveForced({ MEETING_ASSISTANT_LIVE: '1', NODE_ENV: 'development' })).toBe(true);
    expect(liveForced({ MEETING_ASSISTANT_LIVE: '1', NODE_ENV: 'production' })).toBe(false);
    expect(() => assertLiveFlagAllowed({ MEETING_ASSISTANT_LIVE: '1', NODE_ENV: 'production' })).toThrow(/NODE_ENV=production/);
    expect(() => assertLiveFlagAllowed({ MEETING_ASSISTANT_LIVE: '1', NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertLiveFlagAllowed({ NODE_ENV: 'production' })).not.toThrow();
  });
});

describe('which session the mock world gets', () => {
  it('the scripted one by default, even when a provider key is configured', () => {
    delete process.env['MEETING_ASSISTANT_LIVE']; process.env['OPENAI_API_KEY'] = 'test-key-not-real';
    expect(defaultSessionFactory(Date.now)?.kind).toBe('scripted');
  });

  it('the provider\'s with the flag on and the key configured; none (so the invite says 503) when the key is missing', () => {
    process.env['MEETING_ASSISTANT_LIVE'] = '1'; process.env['OPENAI_API_KEY'] = 'test-key-not-real';
    process.env['LIVE_DELEGATION_MODEL'] = process.env['LIVE_DELEGATION_MODEL'] ?? 'gpt-6-luna';
    const s = defaultSessionFactory(Date.now);
    expect(s === null ? 'none' : s.kind).toBe('openai'); // constructed only; it opens no socket until start()
    delete process.env['OPENAI_API_KEY'];
    expect(defaultSessionFactory(Date.now)).toBeNull();
  });

  it('never the provider\'s in production, flag or not', () => {
    process.env['MEETING_ASSISTANT_LIVE'] = '1'; process.env['OPENAI_API_KEY'] = 'test-key-not-real'; process.env['NODE_ENV'] = 'production';
    mockConfig.mock.aurora = true;
    // The mock world itself is off in production, so this is the ordinary production choice: the provider when configured. The flag changed nothing.
    expect(liveForced()).toBe(false);
  });
});
