// The library catalog's fixture: registered, with its scenarios declared, and
// stamps that come from the clock rather than from import time.

import { fixtureRegistry, freezeClock } from '../core/index.js';
import { libraryAssets, mockLibraryAssets } from '../prompt-library.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});


describe('registration and scenarios', () => {
  it('is in the shared registry, so /api/__mock/state can see it and reset can move it', () => {
    expect(fixtureRegistry.get('library-assets')).toBe(libraryAssets);
  });

  it('declares empty rather than inheriting default there', () => {
    expect(libraryAssets.rows('empty')).toEqual([]);
    expect(libraryAssets.rows('default')).toHaveLength(6);
  });

  it('throws under error — that is how the failed-load state is reachable at all', () => {
    expect(() => libraryAssets.rows('error')).toThrow(/library catalog unavailable/);
  });

  it('reset puts the seeded catalog back after a scenario switch', () => {
    const before = libraryAssets.rows().length;
    fixtureRegistry.resetAll('empty');
    expect(libraryAssets.rows()).toEqual([]);
    fixtureRegistry.resetAll('default');
    expect(libraryAssets.rows()).toHaveLength(before);
  });
});

describe('timestamps come from the clock, not from import', () => {
  it('freezing the clock pins updatedAt exactly', () => {
    const restore = freezeClock('2026-09-06T00:05:00.000Z');
    try {
      // Rebuild under the frozen clock — the factory samples at build time.
      libraryAssets.reset();
      const byId = new Map(libraryAssets.rows().map((a) => [a.id, a.updatedAt]));
      // `lib-csrf-check` is the 3-hours-ago row: 00:05 UTC minus three
      // hours lands YESTERDAY, and that is correct here. Age is the claim —
      // both the table column and the drawer render it through relativeTime —
      // so nothing in this catalog uses `keepWithinToday`, and a clamp would
      // make a three-hour-old asset read as five minutes old.
      expect(byId.get('lib-csrf-check')).toBe('2026-09-05T21:05:00.000Z');
      expect(byId.get('orgiq-supervisor-system-prompt')).toBe('2026-09-04T18:05:00.000Z');
      // 72 hours — the oldest row in the catalog.
      expect(byId.get('orgiq-search-system-prompt')).toBe('2026-09-03T00:05:00.000Z');
    } finally {
      restore();
      libraryAssets.reset();
    }
  });

  it('the same rows re-age after a reset under a different instant', () => {
    const first = freezeClock('2026-09-06T00:05:00.000Z');
    libraryAssets.reset();
    const before = libraryAssets.rows().find((a) => a.id === 'lib-csrf-check')?.updatedAt;
    first();

    const second = freezeClock('2026-09-07T00:05:00.000Z');
    libraryAssets.reset();
    const after = libraryAssets.rows().find((a) => a.id === 'lib-csrf-check')?.updatedAt;
    second();
    libraryAssets.reset();

    expect(before).toBe('2026-09-05T21:05:00.000Z');
    expect(after).toBe('2026-09-06T21:05:00.000Z');
  });
});
