import { readHangoutPlan } from '../social-room-plan.js';
import { ValidationError } from '../async-handler.js';
import { freezeClock } from '../../mock/core/clock.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const cases: Array<{ name: string; input: unknown; valid: boolean }> = JSON.parse(readFileSync(path.join(__dirname, 'fixtures/hangout-plan-cases.json'), 'utf8'));

// Byte-identical corpus in realtime-modules and platform-api; see C8 evidence.
test.each(cases)('$name', ({ input, valid }) => {
  const restore = freezeClock('2026-10-26T12:00:00Z');
  try {
    if (valid) {
      const plan = readHangoutPlan(input, 'authenticated-owner');
      expect(plan.version).toBe((input as { expectedVersion: number }).expectedVersion + 1);
      expect(plan.updatedBy).toBe('authenticated-owner');
      expect(plan.updatedAt).toBe('2026-10-26T12:00:00.000Z');
      expect(plan).not.toHaveProperty('expectedVersion');
    } else expect(() => readHangoutPlan(input, 'owner')).toThrow(ValidationError);
  } finally { restore(); }
});
