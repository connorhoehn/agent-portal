// The interviews clock (lib/interviews/clock.ts): the wall clock unless the mock plane moved it.
import {
  MAX_CLOCK_OFFSET_MS, interviewsClockOffsetMs, interviewsNow, interviewsNowMs, resetInterviewsClock, setInterviewsClockOffset,
} from '../clock.js';
import { checkTime } from '../assign.js';

const DAY = 86_400_000;

describe('the interviews clock', () => {
  afterEach(() => resetInterviewsClock());

  it('is the wall clock until it is moved', () => {
    expect(interviewsClockOffsetMs()).toBe(0);
    expect(Math.abs(interviewsNowMs() - Date.now())).toBeLessThan(1000);
    expect(Math.abs(interviewsNow().getTime() - Date.now())).toBeLessThan(1000);
  });

  it('moves only for the mock plane, and reset puts it back', () => {
    expect(setInterviewsClockOffset(3 * DAY, false)).toBe(false);
    expect(interviewsClockOffsetMs()).toBe(0);
    expect(setInterviewsClockOffset(3 * DAY, true)).toBe(true);
    expect(Math.abs(interviewsNowMs() - (Date.now() + 3 * DAY))).toBeLessThan(1000);
    resetInterviewsClock();
    expect(interviewsClockOffsetMs()).toBe(0);
  });

  it('refuses what is not a number of milliseconds within ten years, and keeps the offset it had', () => {
    expect(setInterviewsClockOffset(DAY, true)).toBe(true);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, MAX_CLOCK_OFFSET_MS + 1, -MAX_CLOCK_OFFSET_MS - 1]) {
      expect(setInterviewsClockOffset(bad, true)).toBe(false);
    }
    expect(interviewsClockOffsetMs()).toBe(DAY);
    expect(setInterviewsClockOffset(-2 * DAY, true)).toBe(true);
    expect(interviewsClockOffsetMs()).toBe(-2 * DAY);
  });

  it('is what the tenant\'s defaults read: a time that is ahead now is in the past once the clock passes it', () => {
    const state = { state: 'accepted' as const };
    const inAnHour = new Date(Math.ceil((Date.now() + 3_600_000) / 60_000) * 60_000).toISOString();
    expect(checkTime({ scheduledAt: inAnHour }, state).ok).toBe(true);
    setInterviewsClockOffset(2 * DAY, true);
    expect(checkTime({ scheduledAt: inAnHour }, state).ok).toBe(false);
  });
});
