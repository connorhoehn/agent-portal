// A fixture's rows, exported as an ordinary array.
//
// Two constraints meet here.
//
// The floor says rows live behind a fixture, so `resetAll('empty')` and the
// control plane's per-fixture pin reach them (contract.ts bug #4). That means
// every read must go through `fixture.rows()` at READ time — an array captured
// at import is a photograph of whichever world happened to be live when the
// module loaded, and it keeps rendering that world after an auditor has asked
// for another one.
//
// But a dozen call sites import these fixtures as plain arrays and iterate
// them, and one of those call sites is `mock/core/parity/invariants.ts` — the
// judge, which must not be edited to suit the thing it judges. It does
// `for (const a of mockAgents)` and `mockAgents.reduce(...)`, so `mockAgents`
// has to stay an array-shaped export.
//
// `liveRows` satisfies both: an array-shaped Proxy that re-reads
// `fixture.rows()` before every trap. Iteration, `.map`, `.reduce`, `.find`,
// spread and `length` all behave exactly as they did against the old module-
// scope literal — and all of them now see the world the control plane last
// switched to.
//
// IMPLEMENTATION NOTE. The traps operate on a real array kept in sync with the
// fixture's rows rather than forwarding reads to a foreign object. Forwarding
// is where Proxy invariants bite: `length` is a non-configurable own property
// of the target, and a `getOwnPropertyDescriptor` trap that reports it as
// configurable (or reports a different shape than the target actually has)
// throws a TypeError at the call site rather than anywhere near this file.
// Syncing sidesteps every one of those rules — the target IS the answer.
//
// Writes are forwarded to the fixture's own array, not to the synced view, so
// `proxy.push(row)` reaches the live rows a mock POST is meant to extend
// rather than landing in a copy the next read discards.

import type { Fixture } from './core/index.js';

export function liveRows<Row>(fixture: Fixture<Row>): Row[] {
  const view: Row[] = [];

  const sync = (): Row[] => {
    const src = fixture.rows();
    if (view.length !== src.length || view.some((row, i) => row !== src[i])) {
      view.length = 0;
      for (const row of src) view.push(row);
    }
    return view;
  };

  return new Proxy(view, {
    get(target, prop, receiver) {
      sync();
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      sync();
      return Reflect.has(target, prop);
    },
    ownKeys(target) {
      sync();
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      sync();
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
    // Mutations belong to the fixture's array — `reset()` is what takes them
    // back, and a write parked in `view` would vanish on the next sync.
    set(_target, prop, value) {
      return Reflect.set(fixture.rows() as object, prop, value);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(fixture.rows() as object, prop);
    },
  });
}
