// MEETING_ASSISTANT_HANDSFREE: off unless 1 or true, read fresh on every call (never cached), and inert on its own.
import { handsfreeEnabled } from '../handsfree-flag.js';
import { HANDSFREE } from '../handsfree/types.js';

const saved = process.env['MEETING_ASSISTANT_HANDSFREE'];
afterEach(() => { if (saved === undefined) delete process.env['MEETING_ASSISTANT_HANDSFREE']; else process.env['MEETING_ASSISTANT_HANDSFREE'] = saved; });

describe('the hands-free flag', () => {
  it('is off unless it is 1 or true', () => {
    for (const v of [undefined, '', '0', 'false', 'yes', 'on', 'TRUE', '2']) expect(handsfreeEnabled({ MEETING_ASSISTANT_HANDSFREE: v })).toBe(false);
    for (const v of ['1', 'true', ' 1 ', 'true\n']) expect(handsfreeEnabled({ MEETING_ASSISTANT_HANDSFREE: v })).toBe(true);
  });

  it('is off with nothing set, in any NODE_ENV', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) expect(handsfreeEnabled({ NODE_ENV })).toBe(false);
    expect(handsfreeEnabled({ NODE_ENV: 'production', MEETING_ASSISTANT_HANDSFREE: '1' })).toBe(true);
  });

  it('reads the process environment each time it is asked, so a change reaches the next call', () => {
    delete process.env['MEETING_ASSISTANT_HANDSFREE'];
    expect(handsfreeEnabled()).toBe(false);
    process.env['MEETING_ASSISTANT_HANDSFREE'] = '1';
    expect(handsfreeEnabled()).toBe(true);
    process.env['MEETING_ASSISTANT_HANDSFREE'] = '0';
    expect(handsfreeEnabled()).toBe(false);
  });
});

describe('the frozen numbers', () => {
  it('agree with each other and with the provider limits the probe measured', () => {
    expect(HANDSFREE.frameBytes).toBe((HANDSFREE.sampleRate * HANDSFREE.frameMs / 1000) * 2);
    expect(HANDSFREE.replayMaxRate).toBeLessThanOrEqual(1.2);
    expect(HANDSFREE.replayBurstMs).toBeLessThanOrEqual(5_000);
    expect(HANDSFREE.preRollMaxMs).toBeLessThanOrEqual(HANDSFREE.ringMs);
    expect(HANDSFREE.followUpMs).toBe(10_000);
    expect(HANDSFREE.holdMaxMs).toBe(30_000);
    expect(Object.isFrozen(HANDSFREE)).toBe(true);
  });
});
