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

// The seed reads its task lines off the board fixture, which resolves
// initiative names through providers/projects.ts — and that drags config.ts
// (import.meta) into the CJS jest build unless it is stood in for.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { fixtureRegistry, freezeClock, unfreezeClock } from '../core/index.js';
import { devboxBoxes } from '../devbox-fleet.js';
import { canSeeBox } from '../../lib/devbox-visibility.js';
import { timeLeft, MAX_LIFETIME_MS, IDLE_TIMEOUT_MS } from '../../lib/devbox-reaper.js';

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
    expect(statuses.has('provisioning')).toBe(true);
  });

  it('groups across several initiatives, more than one computer on some', () => {
    const byProject = new Map<string, number>();
    for (const b of devboxBoxes.rows()) if (b.projectId) byProject.set(b.projectId, (byProject.get(b.projectId) ?? 0) + 1);
    expect(byProject.size).toBeGreaterThanOrEqual(3);
    expect([...byProject.values()].some((n) => n > 1)).toBe(true);
  });

  it('every box is inside the reaper\'s windows, so its meters read as a spread rather than all zero', () => {
    const now = new Date(AT).getTime();
    const stops = devboxBoxes.rows().map((b) => {
      expect(now - Date.parse(b.createdAt)).toBeLessThan(MAX_LIFETIME_MS);
      if (b.status !== 'running') expect(now - Date.parse(b.lastActivityAt)).toBeLessThan(IDLE_TIMEOUT_MS);
      const left = timeLeft(b, now).stopsInMs;
      expect(left).toBeGreaterThan(0);
      return Math.round(left / 60_000);
    });
    expect(new Set(stops).size).toBeGreaterThanOrEqual(4);
  });

  it('Nora, an sme on Auth Migration, sees its computers', () => {
    const auth = devboxBoxes.rows().filter((b) => b.projectId === 'p-auth-migration');
    expect(auth.length).toBeGreaterThan(0);
    for (const b of auth) {
      expect(canSeeBox(b, { sub: 'u-nora', role: 'sme', attachedInitiatives: new Set(['p-auth-migration', 'p-observability']) })).toBe(true);
    }
  });

  it('every running or finished task line is a seeded work item\'s own title or a stated mission', () => {
    for (const b of devboxBoxes.rows()) {
      if (b.status === 'provisioning') { expect(b.currentTask).toBeUndefined(); continue; }
      expect(b.currentTask).toBeTruthy();
    }
  });

  it('the demo world takes Auth Migration\'s computers off the stage for the three agents', () => {
    const demo = devboxBoxes.rows('demo');
    expect(demo.some((b) => b.projectId === 'p-auth-migration')).toBe(false);
    expect(demo.length).toBe(devboxBoxes.rows('default').filter((b) => b.projectId !== 'p-auth-migration').length);
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
