// The library catalog's fixture, and the invariant that the distillation
// ladder is a closed loop rather than two surfaces telling separate stories.
//
// WHAT WAS WRONG. `/api/library` answered the same 8,328 bytes in every world
// — `default`, `empty`, `error`, `large`, `fresh` — because `MOCK_ASSETS` was
// a plain array at module scope in providers/prompt-library.ts, registered
// with nothing. The flagship read on this ladder had no auditable empty state
// and no reachable degraded state, and the array's `ago(h)` stamps were minted
// at import, so "updated 2h ago" meant two hours before the process booted.
//
// And the lineage did not close. Every `derivedFrom` block STORED a
// `supportCount`/`sessionCount` pair beside three citations — a banner over
// cards, the exact shape the floor exists to stop — and the ids it cited
// (`exp-441`, `exp-501`, `exp-577`, `exp-233`, …) belonged to no fixture in
// this middleware. The shared-memory store spells observations `obs-NNN`, the
// promotions inbox `obs-<topic>-N`, `lab_experiences` `exp-mock-N`. So the
// Library said a published skill stood on eleven observations across six
// sessions, named three, and not one was a record any surface could open.
//
// The tests below are in two halves, because the two failures are:
//
//   A. THE FIXTURE. Registered, `empty` declared, `error` throws, no stored
//      aggregate on a row, and stamps that move when the clock is frozen.
//   B. THE LINEAGE INVARIANT. Every published artifact resolves to a real
//      Library asset; every asset that claims provenance cites observation
//      ids that really exist in L0; and the banner's two numbers are the
//      count of those rows, not a copy of them. That is the closure — walked
//      in both directions, so neither surface can drift alone.

import { fixtureRegistry, freezeClock } from '../core/index.js';
import {
  artifacts, clusters, libraryLinks, observations,
} from '../distillation.js';
import { derivationFor, libraryAssets, mockLibraryAssets } from '../prompt-library.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

// ─── A. The fixture ────────────────────────────────────────────────────────

describe('registration and scenarios', () => {
  it('is in the shared registry, so /api/__mock/state can see it and reset can move it', () => {
    expect(fixtureRegistry.get('library-assets')).toBe(libraryAssets);
  });

  it('declares empty rather than inheriting default there', () => {
    expect(libraryAssets.rows('empty')).toEqual([]);
    expect(libraryAssets.rows('default')).toHaveLength(10);
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

describe('rows store nothing they could be asked to count', () => {
  it('no row carries derivedFrom — the banner is derived on every read', () => {
    for (const row of libraryAssets.rows()) {
      expect(row).not.toHaveProperty('derivedFrom');
    }
  });
});

describe('timestamps come from the clock, not from import', () => {
  it('freezing the clock pins updatedAt exactly', () => {
    const restore = freezeClock('2026-09-06T00:05:00.000Z');
    try {
      // Rebuild under the frozen clock — the factory samples at build time.
      libraryAssets.reset();
      const byId = new Map(libraryAssets.rows().map((a) => [a.id, a.updatedAt]));
      // `skill-pr-review-scoped` is the 2-hours-ago row: 00:05 UTC minus two
      // hours lands YESTERDAY, and that is correct here. Age is the claim —
      // both the table column and the drawer render it through relativeTime —
      // so nothing in this catalog uses `keepWithinToday`, and a clamp would
      // make a two-hour-old asset read as five minutes old.
      expect(byId.get('skill-pr-review-scoped')).toBe('2026-09-05T22:05:00.000Z');
      expect(byId.get('lib-csrf-check')).toBe('2026-09-05T21:05:00.000Z');
      expect(byId.get('orgiq-supervisor-system-prompt')).toBe('2026-09-04T18:05:00.000Z');
      // 96 hours — the oldest row in the catalog.
      expect(byId.get('insight-arm64-fargate')).toBe('2026-09-02T00:05:00.000Z');
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

// ─── B. The lineage invariant ──────────────────────────────────────────────
//
// One rule, walked both ways: every published artifact reaches a Library
// asset, and every Library asset that claims provenance reaches back to real
// L0 rows. A promoted item with no source finding, or a count that disagrees
// with the rows in its tier, is the class of bug the floor exists to stop.

describe('the lineage is closed', () => {
  it('every library link points at an artifact that exists AND an asset that exists', () => {
    const artifactIds = new Set(artifacts.rows().map((a) => a.id));
    const assetIds = new Set(libraryAssets.rows().map((a) => a.id));
    const links = libraryLinks.rows();
    expect(links.length).toBeGreaterThan(0);

    const broken = links.flatMap((l) => [
      ...(artifactIds.has(l.artifact_id) ? [] : [`${l.artifact_id} (artifact) is not in distillation-artifacts`]),
      ...(assetIds.has(l.library_item_id) ? [] : [`${l.library_item_id} (library item) is not in library-assets`]),
    ]);
    expect(broken).toEqual([]);
  });

  it('every asset that claims provenance cites observation ids that really exist in L0', () => {
    const observationIds = new Set(observations.rows().map((o) => o.id));
    const withProvenance = mockLibraryAssets().filter((a) => a.derivedFrom);
    // Five artifacts are published into the Library by seedLibraryLinks().
    expect(withProvenance).toHaveLength(5);

    const phantom = withProvenance.flatMap((a) =>
      (a.derivedFrom?.top ?? [])
        .filter((t) => !observationIds.has(t.id))
        .map((t) => `${a.id} cites ${t.id}, which no observation carries`));
    expect(phantom).toEqual([]);
  });

  it('the banner numbers are the count of the rows underneath them, not a stored copy', () => {
    for (const asset of mockLibraryAssets()) {
      const derived = asset.derivedFrom;
      if (!derived) continue;

      // Re-walk the lineage independently of derivationFor: link → artifact →
      // its clusters → their members. If the two disagree, the banner is
      // claiming something the store does not say.
      const link = libraryLinks.rows().find((l) => l.library_item_id === asset.id);
      const artifact = artifacts.rows().find((a) => a.id === link?.artifact_id);
      const memberIds = new Set(
        clusters.rows()
          .filter((c) => artifact?.cluster_ids.includes(c.id))
          .flatMap((c) => c.member_observation_ids),
      );
      const supporting = observations.rows().filter((o) => memberIds.has(o.id));

      expect(derived.supportCount).toBe(supporting.length);
      expect(derived.sessionCount).toBe(new Set(supporting.map((o) => o.session_id)).size);
      // `top` is a declared top-k over the same set, never a separate list.
      expect(derived.top.length).toBeLessThanOrEqual(derived.supportCount);
      for (const t of derived.top) {
        expect(supporting.some((o) => o.id === t.id)).toBe(true);
      }
    }
  });

  it('pins the demo corpus exactly, so a seed change has to be looked at', () => {
    const restore = freezeClock('2026-09-06T00:05:00.000Z');
    try {
      fixtureRegistry.resetAll('default');
      const summary = mockLibraryAssets()
        .filter((a) => a.derivedFrom)
        .map((a) => [a.id, a.derivedFrom?.supportCount, a.derivedFrom?.sessionCount])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

      expect(summary).toEqual([
        ['insight-arm64-fargate', 3, 1],
        ['lib-csrf-check', 4, 1],
        ['lib-pii-scan', 3, 1],
        ['skill-cold-start-aurora', 3, 1],
        ['skill-flaky-test-triage', 3, 1],
      ]);

      // The evidence itself, strongest first, capped at the declared k.
      expect(derivationFor('skill-flaky-test-triage')).toEqual({
        fromKind: 'pattern',
        supportCount: 3,
        sessionCount: 1,
        top: [
          {
            id: 'obs-021', kind: 'gotcha', weight: 0.87,
            title: 'Collector integration tests pass alone, flake in parallel CI',
            repo: 'connorhoehnslalom/orgiq-observability',
          },
          {
            id: 'obs-022', kind: 'worked', weight: 0.87,
            title: 'Rerun twice and diff the two outcomes before filing a flake as a real bug',
            repo: 'connorhoehnslalom/orgiq-observability',
          },
          {
            id: 'obs-023', kind: 'failed', weight: 0.87,
            title: 'Quarantining a flaky test without evidence hid a real regression for seed value handling',
            repo: 'connorhoehnslalom/orgiq-observability',
          },
        ],
      });
    } finally {
      restore();
    }
  });
});

describe('the link runs both ways, so emptying one side is visible on the other', () => {
  it('no library links means no asset claims provenance — rather than a stale claim', () => {
    fixtureRegistry.resetAll('fresh'); // `distillation-library-links` is empty in fresh
    expect(libraryLinks.rows()).toEqual([]);
    expect(mockLibraryAssets().filter((a) => a.derivedFrom)).toEqual([]);
    // The catalog itself is untouched — nothing was published, that is all.
    expect(mockLibraryAssets()).toHaveLength(10);
  });

  it('an unreadable store takes the whole catalog read down rather than quietly dropping provenance', () => {
    fixtureRegistry.resetAll('error');
    expect(() => mockLibraryAssets()).toThrow(/library catalog unavailable/);
  });

  it('an asset nothing published into has no derivedFrom at all', () => {
    // A draft skill and a hand-written prompt: real assets, no artifact behind
    // them. Absence is the honest answer, and it used to be a fabricated one.
    expect(derivationFor('skill-pr-review-scoped')).toBeUndefined();
    expect(derivationFor('lib-stakeholder-email')).toBeUndefined();
    expect(derivationFor('lib-adr-summary')).toBeUndefined();
  });
});
