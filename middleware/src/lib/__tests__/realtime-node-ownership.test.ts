// Regression for the 2026-10-06 stalled-Redis fault (capacity-latency/
// stall-repro-1-*): the cookie router fenced on its 2 s renewal deadline while
// the /ws router's reply landed ~60 ms inside its own, so /health answered 503
// while the /ws lease kept renewing every 10 s and never expired.
import { linkNodeOwnership, type LeasedOwner } from '../realtime-node-ownership.js';

function owner(ready = true) {
  const state = { ready, shutdowns: 0 };
  const value: LeasedOwner & { state: typeof state } = {
    state,
    isReady: () => state.ready,
    shutdown: async () => { state.shutdowns++; state.ready = false; },
  };
  return value;
}
const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('linkNodeOwnership', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
  afterEach(() => warn.mockRestore());

  it('retires the surviving router when its sibling fences, so no lease outlives the node’s 503', async () => {
    const gateway = owner(), cookie = owner();
    const retired = new Promise<unknown>(resolve => linkNodeOwnership([gateway, cookie], { intervalMs: 5, onRetire: resolve }));
    await tick(20);
    expect(gateway.state.shutdowns + cookie.state.shutdowns).toBe(0);
    cookie.state.ready = false; // fenced on its own renewal deadline
    expect(await retired).toBeUndefined();
    expect(gateway.state.shutdowns).toBe(1);
    expect(cookie.state.shutdowns).toBe(0); // already fenced; its lease expires untouched
    expect(gateway.isReady()).toBe(false);
  });

  it('retires once, even if both fence, and never revives', async () => {
    const a = owner(), b = owner();
    let retires = 0;
    linkNodeOwnership([a, b], { intervalMs: 5, onRetire: () => { retires++; } });
    a.state.ready = false; b.state.ready = false;
    await tick(40);
    expect(retires).toBe(1);
    expect(a.state.shutdowns + b.state.shutdowns).toBe(0);
  });

  it('leaves healthy owners alone and stops checking once unlinked', async () => {
    const a = owner(), b = owner();
    const stop = linkNodeOwnership([a, b], { intervalMs: 5 });
    await tick(20);
    stop();
    a.state.ready = false;
    await tick(20);
    expect(b.state.shutdowns).toBe(0);
  });

  it('is a no-op for a single (local-routing) owner', async () => {
    const only = owner();
    linkNodeOwnership([only], { intervalMs: 5 });
    only.state.ready = false;
    await tick(20);
    expect(only.state.shutdowns).toBe(0);
  });
});
