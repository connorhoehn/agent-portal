// The one-release parity assertion between the realtime-modules 0.116 engine
// and the host copies (lib/gateway/authority-parity.ts). The facade contract
// (authority-facade.test.ts) runs every row with parity in `throw` mode, so a
// drift there already fails; this pins the mechanism itself.
import { AuthorityParityError, authorityParityMismatches, authorityParityMode, authorityParitySample, parityAsync, paritySync } from '../authority-parity.js';

describe('authorityParityMode', () => {
  it('is on (throw) outside production, off in production, and explicit when set', () => {
    expect(authorityParityMode({ NODE_ENV: 'test' })).toBe('throw');
    expect(authorityParityMode({ NODE_ENV: 'development' })).toBe('throw');
    expect(authorityParityMode({ NODE_ENV: 'production' })).toBe('off');
    expect(authorityParityMode({ NODE_ENV: 'production', AUTHORITY_PARITY: 'throw' })).toBe('throw');
    expect(authorityParityMode({ NODE_ENV: 'development', AUTHORITY_PARITY: 'sync' })).toBe('sync');
    expect(authorityParityMode({ NODE_ENV: 'development', AUTHORITY_PARITY: 'off' })).toBe('off');
  });
});

describe('authorityParitySample', () => {
  it('compares every async decision under jest, a sample on the shared dev BFF, and honours the override', () => {
    expect(authorityParitySample({ NODE_ENV: 'test' })).toBe(1);
    expect(authorityParitySample({ NODE_ENV: 'development' })).toBe(0.05);
    expect(authorityParitySample({ NODE_ENV: 'development', AUTHORITY_PARITY_SAMPLE: '1' })).toBe(1);
    expect(authorityParitySample({ NODE_ENV: 'development', AUTHORITY_PARITY_SAMPLE: '7' })).toBe(1);
  });
});

describe('parity wrappers', () => {
  const env = process.env['AUTHORITY_PARITY'];
  afterEach(() => { if (env === undefined) delete process.env['AUTHORITY_PARITY']; else process.env['AUTHORITY_PARITY'] = env; });
  beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => jest.restoreAllMocks());

  it('returns the engine verdict when both agree', async () => {
    expect(paritySync('g', () => true, () => true)()).toBe(true);
    await expect(parityAsync('d', async () => 'ok', async () => 'ok')()).resolves.toBe('ok');
  });

  it('throws on a mismatch and records it, naming the subject', async () => {
    const before = authorityParityMismatches.length;
    expect(() => paritySync('lobbyGuard', (_a: unknown, _l: string) => true, () => false)({ userId: 'u1', org: 'orgiq' }, 'orgiq:x')).toThrow(AuthorityParityError);
    await expect(parityAsync('admitChannel', async (_a: unknown) => false, async () => true)({ channel: 'orgiq:work:w1', kind: 'subscribe', ctx: { userId: 'u1', org: 'orgiq' } }))
      .rejects.toThrow(/admitChannel engine=false legacy=true for channel=orgiq:work:w1 kind=subscribe user=u1@orgiq/);
    expect(authorityParityMismatches.length).toBe(before + 2);
  });

  it('never asks the host copy when off; sync mode skips only the async half', async () => {
    const legacy = jest.fn(async () => true);
    process.env['AUTHORITY_PARITY'] = 'off';
    expect(paritySync('g', () => false, () => true)()).toBe(false);
    await expect(parityAsync('d', async () => false, legacy)()).resolves.toBe(false);
    process.env['AUTHORITY_PARITY'] = 'sync';
    expect(() => paritySync('g', () => false, () => true)()).toThrow(AuthorityParityError);
    await expect(parityAsync('d', async () => false, legacy)()).resolves.toBe(false);
    expect(legacy).not.toHaveBeenCalled();
  });
});
