// The offline microVM fleet — the rows Computer Lab multiplexes.
//
// `providers/devbox-fleet-store.ts::loadFleet()` opened with
// `if (!usable()) return []`, and `usable()` is false whenever Aurora is
// mocked, so the fleet was empty BY CONSTRUCTION in the whole dev:mock demo:
// Computer Lab rendered "No computers to lab · Provision at least one
// computer" in every demo anyone ever gave. Its empty state is phrased as an
// instruction, so the surface did not read as unseeded — it read as waiting
// for you, and the obvious next move offline is to provision against a
// runtime that is not there.
//
// These pin the properties the seed exists for, not the row contents: a seed
// that drifts into five identical boxes would still be five boxes and would
// still exercise a third of the visibility rule.

import { fixtureRegistry, freezeClock, unfreezeClock } from '../core/index.js';
import { devboxBoxes } from '../devbox-fleet.js';
import { canSeeBox } from '../../lib/devbox-visibility.js';

const AT = '2026-09-16T15:20:00.000Z';
let restore: () => void;

beforeEach(() => { restore = freezeClock(AT); fixtureRegistry.resetAll('default'); });
afterEach(() => { restore(); unfreezeClock(); fixtureRegistry.resetAll('default'); });

describe('devboxBoxes — the fleet Computer Lab actually shows', () => {
  it('is not empty, which is the entire bug it was added for', () => {
    expect(devboxBoxes.rows().length).toBeGreaterThan(0);
  });

  it('carries all three visibility shapes, so canSeeBox is exercised rather than asserted', () => {
    const rows = devboxBoxes.rows();
    expect(rows.some((b) => b.projectId)).toBe(true);                        // shared
    expect(rows.some((b) => b.ownerId && !b.projectId)).toBe(true);          // personal
    expect(rows.some((b) => !b.ownerId && !b.projectId)).toBe(true);         // unattributed
  });

  it('an SME on one initiative sees strictly fewer boxes than an org-wide role', () => {
    const rows = devboxBoxes.rows();
    const orgWide = rows.filter((b) => canSeeBox(b, {
      sub: 'u-rachel', role: 'hr-admin', attachedInitiatives: new Set(),
    }));
    const oneInitiative = rows.filter((b) => canSeeBox(b, {
      sub: 'u-layla', role: 'sme', attachedInitiatives: new Set(['p-observability']),
    }));
    expect(orgWide).toHaveLength(rows.length);
    expect(oneInitiative.length).toBeGreaterThan(0);
    expect(oneInitiative.length).toBeLessThan(orgWide.length);
  });

  it('never seeds `stopped` — loadFleet filters and prunes those, so it is a state the loader guarantees never arrives', () => {
    for (const b of devboxBoxes.rows()) expect(b.status).not.toBe('stopped');
  });

  it('covers the statuses the lab renders differently, not five of one', () => {
    const statuses = new Set(devboxBoxes.rows().map((b) => b.status));
    expect(statuses.has('running')).toBe(true);
    expect(statuses.has('idle')).toBe(true);
    expect(statuses.has('waiting')).toBe(true);
  });

  it('every timestamp comes from the frozen clock — no wall-clock leak', () => {
    const now = new Date(AT).getTime();
    for (const b of devboxBoxes.rows()) {
      expect(Date.parse(b.createdAt)).toBeLessThanOrEqual(now);
      expect(Date.parse(b.lastActivityAt)).toBeLessThanOrEqual(now);
      // Activity cannot predate creation — the kind of thing a hand-typed
      // offset gets wrong and nothing notices until a duration renders negative.
      expect(Date.parse(b.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(b.createdAt));
    }
  });

  it('contextUsed is a fraction, never a token count', () => {
    for (const b of devboxBoxes.rows()) {
      if (b.contextUsed === undefined) continue;
      expect(b.contextUsed).toBeGreaterThan(0);
      expect(b.contextUsed).toBeLessThanOrEqual(1);
    }
  });

  it('declares an `empty` scenario — a fresh account is the one case where "provision one" is honest', () => {
    expect(devboxBoxes.rows('empty')).toEqual([]);
  });
});
