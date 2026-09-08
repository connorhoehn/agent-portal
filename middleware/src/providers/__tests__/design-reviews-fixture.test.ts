// The design-review rows on the fixture floor.
//
// They used to be a module-scope array whose every timestamp was
// `Date.now() - h * 3600_000` evaluated at IMPORT. "8 hours ago" then meant
// eight hours before the process booted, so a dev server left running
// overnight showed a thread whose newest post was a day old and whose "open
// question" was older than the answer above it. Contract rule 3 exists for
// exactly this, and the check below is what makes the fix stick.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { freezeClock, fixtureRegistry } from '../../mock/core/index.js';
import { getDesignThread, listDesignReviews } from '../design-reviews.js';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('design-review rows', () => {
  it('date themselves from the moment they are READ, not from import', async () => {
    const restore = freezeClock('2026-09-06T00:05:00.000Z');
    fixtureRegistry.resetAll('default');
    const first = await getDesignThread('des-auth-rotation');
    restore();

    const later = freezeClock('2026-09-20T00:05:00.000Z');
    fixtureRegistry.resetAll('default');
    const second = await getDesignThread('des-auth-rotation');
    later();

    // Same row, two weeks apart: the age is constant, so the timestamp moved.
    expect(second!.updatedAt).not.toBe(first!.updatedAt);
    expect(Date.parse(second!.updatedAt) - Date.parse(first!.updatedAt))
      .toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('keep a seeded post id stable across a reset, because resolvedBy points at one', async () => {
    const before = (await getDesignThread('des-obs-sampling'))!.posts.map((p) => p.id);
    fixtureRegistry.resetAll('default');
    const after = (await getDesignThread('des-obs-sampling'))!.posts.map((p) => p.id);
    expect(after).toEqual(before);

    const answered = (await getDesignThread('des-obs-sampling'))!
      .posts.find((p) => p.kind === 'question')!;
    expect(after).toContain(answered.resolvedBy);
  });

  it('has an empty world — an initiative with no design thread opened yet', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listDesignReviews()).toEqual([]);
    expect(await getDesignThread('des-obs-sampling')).toBeNull();
  });
});
