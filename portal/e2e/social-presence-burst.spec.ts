import { test, expect } from '@playwright/test';
import { loginAs } from './realSession';

// Regression: "Maximum update depth exceeded" during Social walks (DEFECTS #3,
// 2026-10-06). The shell's workspace presence (EmbeddedSocial.tsx
// ShellSocialPresence) mirrored every presence frame into the provider from a
// passive effect, so each frame cost two commits and a burst of frames chained
// more than React's 50 nested passive updates. Real BFF and gateway; only the
// burst itself is injected on this page's own socket. A minimal React DevTools
// hook counts commits in which the provider's mirrored people list changed.

const PEOPLE = ['u-lena', 'u-asha', 'u-jonas', 'u-nora', 'u-rachel', 'u-farah', 'u-theo', 'u-vera'];

test('a presence frame burst neither re-mirrors unchanged rosters nor exceeds update depth', async ({ context, page, baseURL }) => {
  test.setTimeout(90_000);
  await loginAs(context, 'u-sana', baseURL, true);
  await context.addInitScript(() => {
    const changes: number[] = [];
    (window as unknown as { __mirrorChanges: number[] }).__mirrorChanges = changes;
    type Fiber = { tag: number; type: { name?: string } | null; alternate: Fiber | null; memoizedState: Hook | null; child: Fiber | null; sibling: Fiber | null };
    type Hook = { memoizedState: unknown; queue: { dispatch?: unknown } | null; next: Hook | null };
    const visit = (fiber: Fiber | null) => {
      for (let f = fiber; f; f = f.sibling) {
        if (f.tag === 0 && f.type?.name === 'EmbeddedSocialProvider' && f.alternate) {
          let hook = f.memoizedState, prev = f.alternate.memoizedState, index = 0;
          while (hook && prev) { if (hook.queue?.dispatch && hook.memoizedState !== prev.memoizedState) changes.push(index); hook = hook.next; prev = prev.next; index++; }
        }
        visit(f.child);
      }
    };
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { configurable: true, value: {
      supportsFiber: true, renderers: new Map(), isDisabled: false, checkDCE() {}, inject() { return 1; },
      onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {},
      onCommitFiberRoot(_id: number, root: { current: Fiber }) { visit(root.current.child); },
    } });
  });
  let client: { send(message: string): void } | null = null;
  await context.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer(); client = socket;
    socket.onClose(() => { void server.close().catch(() => undefined); });
    server.onClose(() => { void socket.close().catch(() => undefined); });
  });
  const depth: string[] = [];
  page.on('console', message => { if (/Maximum update depth/.test(message.text())) depth.push(message.text()); });
  await page.goto('/social/channels');
  // Workspace presence is live once the footer counts this user online.
  await expect(page.getByTestId('shell-social-bar')).toContainText(/[1-9]\d* online/, { timeout: 30_000 });
  await page.waitForTimeout(2_000);
  const frame = (userId: string, status: string) => JSON.stringify({ type: 'presence', action: 'update', presence: {
    clientId: `burst-${userId}`, status, metadata: { userId, displayName: userId }, channels: ['social:lobby'] } });
  // Join everyone once, then replay the same announcements: the shape a reconnect produces.
  for (const userId of PEOPLE) client!.send(frame(userId, 'online'));
  await page.waitForTimeout(1_000);
  const before = await page.evaluate(() => (window as unknown as { __mirrorChanges: number[] }).__mirrorChanges.length);
  for (let i = 0; i < 240; i++) { client!.send(frame(PEOPLE[i % PEOPLE.length]!, 'online')); await page.waitForTimeout(i % 3 === 0 ? 2 : 4); }
  await page.waitForTimeout(1_000);
  const unchanged = await page.evaluate(n => (window as unknown as { __mirrorChanges: number[] }).__mirrorChanges.length - n, before);
  // Then a burst of genuine changes.
  for (let i = 0; i < 200; i++) { client!.send(frame(PEOPLE[i % PEOPLE.length]!, i % 2 ? 'online' : 'away')); await page.waitForTimeout(3); }
  await page.waitForTimeout(1_500);
  const replayed = await page.evaluate(n => (window as unknown as { __mirrorChanges: number[] }).__mirrorChanges.slice(n), before);
  expect(depth, 'no update-depth warning during the burst').toEqual([]);
  expect(unchanged, 'replayed, unchanged announcements are not re-mirrored').toBe(0);
  expect(replayed.length, 'each genuine change publishes at most once').toBeLessThanOrEqual(200);
});
