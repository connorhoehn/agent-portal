// The fleet store's row parsing — where a timezone mistake turns into a box
// that can never be reaped.

import { utcIso, rowToBox } from '../devbox-fleet-rows.js';


describe('Aurora timestamps are read as UTC, not as local time', () => {
  // The Data API returns TIMESTAMPTZ as a NAIVE string with no zone marker.
  // `new Date()` reads a string in that shape as LOCAL time, so on a UTC-4 host
  // a box created at 17:49Z came back as 21:49Z — four hours in the FUTURE.
  const NAIVE = '2026-09-09 17:49:44.532';

  it('reads a zone-less Aurora timestamp as UTC', () => {
    expect(utcIso(NAIVE)).toBe('2026-09-09T17:49:44.532Z');
  });

  it('never returns a future instant for a row written in the past', () => {
    // This is the property that matters, and it is host-timezone independent:
    // `decideReaping` computes `age = now - createdAt`, so a future createdAt
    // makes age negative and the lifetime ceiling never fires again. That is
    // the same defect `trustedCreatedAt` clamps on the write side — hydration
    // deliberately bypasses that clamp to keep stored ages honest, so the
    // parsing here has to be right on its own.
    const parsed = new Date(utcIso(NAIVE)).getTime();
    expect(parsed).toBeLessThan(Date.now());
  });

  it('respects an explicit zone when one is present', () => {
    expect(utcIso('2026-09-09T17:49:44.532Z')).toBe('2026-09-09T17:49:44.532Z');
    expect(utcIso('2026-09-09T13:49:44.532-04:00')).toBe('2026-09-09T17:49:44.532Z');
  });

  it('falls back to now rather than emitting an Invalid Date', () => {
    // A NaN timestamp is worse than a wrong one: `Number.isFinite` guards in
    // decideReaping skip the box entirely, so it would never be reaped at all.
    const out = utcIso('not a timestamp');
    expect(Number.isFinite(new Date(out).getTime())).toBe(true);
  });
});

describe('row → box', () => {
  const ROW = {
    id: 'abc12345',
    session_id: 'f'.repeat(40),
    label: 'restored',
    owner_id: 'u-rachel',
    project_id: null,
    status: 'idle',
    created_at: '2026-09-09 17:49:44.532',
    last_activity_at: '2026-09-09 17:55:00.000',
    spend_usd: 0.42,
    tokens_used: 1234,
    active_model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  };

  it('carries the fields the reaper and the cost centre need', () => {
    const box = rowToBox(ROW);
    expect(box).toMatchObject({
      id: 'abc12345',
      label: 'restored',
      ownerId: 'u-rachel',
      status: 'idle',
      createdAt: '2026-09-09T17:49:44.532Z',
      lastActivityAt: '2026-09-09T17:55:00.000Z',
      spendUsd: 0.42,
      tokensUsed: 1234,
    });
  });

  it('restores the last occupant, so a restart does not forget whose work the box holds', () => {
    expect(rowToBox({ ...ROW, last_occupant: 'u-rachel' }).lastOccupant).toBe('u-rachel');
    expect('lastOccupant' in rowToBox(ROW)).toBe(false);
  });

  it('leaves absent optional columns absent rather than null', () => {
    // `projectId` drives visibility (a box charged to an initiative is shared
    // with everyone on it), so a literal null would be a different claim from
    // "personal box".
    const box = rowToBox(ROW);
    expect('projectId' in box).toBe(false);
  });
});
