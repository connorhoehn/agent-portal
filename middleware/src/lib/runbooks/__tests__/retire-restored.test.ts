// A restored runbook starts again: what happened before its restore does not retire it a second time.
import { disuseDue } from '../retire.js';
import type { Runbook } from '../types.js';

const DAY = 86_400_000;
const now = Date.parse('2026-11-11T12:00:00Z');
const rb = (over: Partial<Runbook>): Runbook => ({
  id: 'rb-old', status: 'published', created_at: new Date(now - 400 * DAY).toISOString(), updated_at: new Date(now).toISOString(),
  ...over,
} as Runbook);

describe('retirement after a restore', () => {
  it('an old runbook given to no run is due', () => {
    expect(disuseDue(rb({}), [], [], now)?.rule).toBe('disuse-ungiven');
  });
  it('the same runbook measured from its restore is not due', () => {
    const restoredAt = new Date(now - 2 * DAY).toISOString();
    expect(disuseDue(rb({ created_at: restoredAt }), [], [], now)).toBeNull();
  });
});
