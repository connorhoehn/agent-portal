// Catch-up-once semantics. The middleware is a laptop process, so a cron bot
// sleeps with it; the rule under test is the boot decision — never-ran or
// >24h-stale fires once, anything fresher waits for its schedule. The
// "once" half is structural (the decision is taken from a single boot-time
// snapshot), so the pure predicate is the whole testable surface.

// The predicate is pure; the mocks only keep the module loadable — config.ts
// and ingest-scheduler.ts use import.meta, which the CJS test transform
// cannot compile.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));
jest.mock('../ingest-scheduler.js', () => ({ validateCronExpr: () => true }));

import { shouldCatchUp, parseRdsTimestamp } from '../bot-scheduler.js';

const NOW = new Date('2026-08-21T12:00:00Z');
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('shouldCatchUp', () => {
  it('fires a bot that has never run', () => {
    expect(shouldCatchUp(null, NOW)).toBe(true);
  });

  it('fires a bot whose last run is older than 24h', () => {
    expect(shouldCatchUp(hoursAgo(25), NOW)).toBe(true);
  });

  it('waits for the schedule when the last run is within 24h', () => {
    expect(shouldCatchUp(hoursAgo(23), NOW)).toBe(false);
    expect(shouldCatchUp(hoursAgo(1), NOW)).toBe(false);
  });

  it('treats exactly-24h as fresh — the boundary belongs to the schedule, not the catch-up', () => {
    expect(shouldCatchUp(hoursAgo(24), NOW)).toBe(false);
  });

  it('fires on an unparseable timestamp rather than trusting garbage to mean "recent"', () => {
    expect(shouldCatchUp('not-a-date', NOW)).toBe(true);
  });

  it('reads RDS "YYYY-MM-DD HH:MM:SS" as UTC, not host-local time', () => {
    // 23h ago in UTC, RDS form. Parsed as local time on a UTC-negative host it
    // would look >24h stale and double-fire; as UTC it is fresh.
    expect(shouldCatchUp('2026-08-20 13:00:00', NOW)).toBe(false);
    expect(shouldCatchUp('2026-08-20 11:00:00', NOW)).toBe(true); // 25h ago
  });
});

describe('parseRdsTimestamp', () => {
  const utc = Date.parse('2026-08-20T13:00:00Z');

  it('pins zoneless RDS timestamps to UTC', () => {
    expect(parseRdsTimestamp('2026-08-20 13:00:00')).toBe(utc);
    expect(parseRdsTimestamp('2026-08-20 13:00:00.000')).toBe(utc);
  });

  it('leaves an explicit zone alone', () => {
    expect(parseRdsTimestamp('2026-08-20 13:00:00+00')).toBe(utc);
    expect(parseRdsTimestamp('2026-08-20 08:00:00-05:00')).toBe(utc);
    expect(parseRdsTimestamp('2026-08-20T13:00:00Z')).toBe(utc);
  });

  it('still NaNs on garbage so the caller can treat it as never-ran', () => {
    expect(Number.isFinite(parseRdsTimestamp('not-a-date'))).toBe(false);
  });
});
