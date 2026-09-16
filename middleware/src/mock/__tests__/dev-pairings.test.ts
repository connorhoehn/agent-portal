// The env gate is the whole safety of this feature.
//
// Persisting hand-paired machines across a `tsx watch` restart is a dev-loop
// fix: without it, every middleware save silently unpairs the laptop someone
// just walked through pairing, and they get `401 invalid or revoked node
// token` with no hint why. But the mock floor requires a fixture's rows to be
// a pure function of its seed — the wire capture commits shapes replayed
// against a throwaway server, and the jest suites assert seeded counts. A
// default scenario that quietly grew a row from someone's laptop would poison
// both.
//
// So: OFF unless MOCK_PERSIST_PAIRINGS=1, which only `npm run dev:mock` sets.
// These cases pin that, because a regression here is invisible until a
// snapshot mysteriously contains a stranger's machine.

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearDevPairings,
  devPairingsEnabled,
  loadDevPairings,
  saveDevPairing,
} from '../dev-pairings.js';

const STORE = join(process.cwd(), '.dev-pairings.json');
const ORIGINAL = process.env['MOCK_PERSIST_PAIRINGS'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['MOCK_PERSIST_PAIRINGS'];
  else process.env['MOCK_PERSIST_PAIRINGS'] = ORIGINAL;
  try { rmSync(STORE, { force: true }); } catch { /* nothing to clean */ }
});

describe('the env gate', () => {
  it('is off by default — the capture harness and the suites must see the seed', () => {
    delete process.env['MOCK_PERSIST_PAIRINGS'];
    expect(devPairingsEnabled()).toBe(false);
  });

  it('is off for any value other than exactly "1"', () => {
    // Not a truthiness check: `MOCK_PERSIST_PAIRINGS=0` and `=false` must both
    // mean off, and an environment check on NODE_ENV would have turned this on
    // for the two callers that must never see it (capture and jest both run
    // with NODE_ENV=development).
    for (const v of ['0', 'false', 'true', 'yes', '']) {
      process.env['MOCK_PERSIST_PAIRINGS'] = v;
      expect([v, devPairingsEnabled()]).toEqual([v, false]);
    }
  });

  it('writes NOTHING to disk while off, even when asked to save', () => {
    delete process.env['MOCK_PERSIST_PAIRINGS'];
    saveDevPairing({ id: 'node-should-not-persist' });
    expect(existsSync(STORE)).toBe(false);
    expect(loadDevPairings()).toEqual([]);
  });
});

describe('with MOCK_PERSIST_PAIRINGS=1', () => {
  beforeEach(() => { process.env['MOCK_PERSIST_PAIRINGS'] = '1'; });

  it('a saved row comes back — which is the entire point', () => {
    saveDevPairing({ id: 'node-laptop', label: 'my-laptop' });
    expect(loadDevPairings()).toEqual([{ id: 'node-laptop', label: 'my-laptop' }]);
  });

  it('appends rather than replacing, so two machines both survive', () => {
    saveDevPairing({ id: 'a' });
    saveDevPairing({ id: 'b' });
    expect(loadDevPairings()).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('reset clears the file, so reset is not partial', () => {
    saveDevPairing({ id: 'node-laptop' });
    clearDevPairings();
    // Without this the machine reappears on the next boot and `reset` would
    // have meant "reset most of it", which is worse than not offering it.
    expect(loadDevPairings()).toEqual([]);
  });

  it('a corrupt file reads as empty rather than taking the process down', () => {
    // You re-pair once — the old behaviour — instead of a middleware that
    // will not start.
    require('node:fs').writeFileSync(STORE, '{ this is not json');
    expect(loadDevPairings()).toEqual([]);
  });

  it('a JSON file that is not an array is ignored, not spread', () => {
    require('node:fs').writeFileSync(STORE, '{"id":"nope"}');
    expect(loadDevPairings()).toEqual([]);
  });
});
