// A missed round (ledger row C-17): the rule at its boundary, and the row that carries it from the tenant's clock.
import { isMissed } from '../missed.js';
import type { Interview } from '../types.js';

const START = Date.parse('2031-03-04T14:00:00.000Z');
const round = (over: Partial<Pick<Interview, 'state' | 'scheduledAt' | 'minutes'>> = {}) => ({ state: 'ready' as Interview['state'], scheduledAt: new Date(START).toISOString(), minutes: 60, ...over });

describe('isMissed', () => {
  it('a not-yet-live round is missed only once more than its own length has passed since its start', () => {
    expect(isMissed(round(), START + 59 * 60_000)).toBe(false);
    expect(isMissed(round(), START + 60 * 60_000)).toBe(false);
    expect(isMissed(round(), START + 60 * 60_000 + 1)).toBe(true);
    expect(isMissed(round({ minutes: 10 }), START + 11 * 60_000)).toBe(true);
  });
  it('assigned, accepted and ready can be missed; live, finished and closed rounds and a round without a time cannot', () => {
    const late = START + 3 * 3_600_000;
    for (const state of ['assigned', 'accepted', 'ready'] as const) expect(isMissed(round({ state }), late)).toBe(true);
    for (const state of ['live', 'ended', 'scored', 'reviewed', 'declined', 'cancelled'] as const) expect(isMissed(round({ state }), late)).toBe(false);
    expect(isMissed(round({ scheduledAt: null }), late)).toBe(false);
  });
});
