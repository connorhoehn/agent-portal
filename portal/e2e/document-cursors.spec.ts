import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { signIn } from './realSession';

// Collaborative cursors on one assessment document (realtime-parity gap 4):
// two readers see each other's pointer move and vanish on leave, with the
// token's name; a session with no document access never gets the channel.
//
// Needs the offline stack (middleware on :3001 with the gateway on, portal on
// :5183). Skips otherwise, with the reason.

const DOC_URL = `/assessment/workspace?doc=${encodeURIComponent('page:100002')}`;
const CHANNEL = 'assessment:doc:page:100002';
type Person = { page: Page; context: BrowserContext; userId: string };

async function open(browser: Browser, userId: string): Promise<Person> {
  const context = await browser.newContext({ viewport: { width: 1672, height: 941 } });
  const page = await context.newPage();
  await page.goto('/');
  await signIn(page, userId);
  await page.goto(DOC_URL);
  await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('document-canvas-slot')).toBeVisible({ timeout: 20_000 });
  return { page, context, userId };
}

test.describe('document cursors on the gateway', () => {
  let farah: Person; let jonas: Person;
  test.beforeAll(async ({ browser, request }) => {
    const health = await request.get('/api/health').then(r => r.json()).catch(() => null) as { realtime?: { gateway?: string } } | null;
    test.skip(health?.realtime?.gateway !== 'on', 'the :3001 middleware is unreachable or REALTIME_GATEWAY is not on');
    farah = await open(browser, 'u-farah');
    jonas = await open(browser, 'u-jonas');
  });
  test.afterAll(async () => { await farah?.context.close(); await jonas?.context.close(); });

  const pointers = (p: Person) => p.page.getByTestId('cursor-overlay-pointer');

  test('a peer pointer follows the other reader, labelled from the token, and vanishes on leave', async () => {
    const slot = farah.page.getByTestId('document-canvas-slot');
    const box = (await slot.boundingBox())!;
    await expect(async () => {
      await farah.page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3, { steps: 4 });
      await farah.page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 4 });
      await expect(pointers(jonas)).toHaveCount(1, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    // Moves again: the pointer's position follows.
    const first = await pointers(jonas).first().boundingBox();
    await expect(async () => {
      await farah.page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 4 });
      const next = await pointers(jonas).first().boundingBox();
      expect(next!.x).toBeGreaterThan(first!.x + 20);
    }).toPass({ timeout: 10_000 });
    // The wire carries identity from the token, nothing farah typed.
    await expect(jonas.page.getByTestId('document-canvas-slot')).toContainText(/Farah|FA/);
    await farah.page.goto('/');
    await expect(pointers(jonas)).toHaveCount(0, { timeout: 15_000 });
  });

  test('a session with no document access is refused the cursor channel', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await signIn(page, 'u-theo');
    const frames = await page.evaluate(async (channel: string) => {
      const { token } = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string };
      return new Promise<Array<Record<string, unknown>>>((resolve) => {
        const out: Array<Record<string, unknown>> = [];
        const ws = new WebSocket('ws://localhost:3001/ws', ['bearer-token-v1', token]);
        ws.onopen = () => {
          ws.send(JSON.stringify({ service: 'cursor', action: 'subscribe', channel }));
          ws.send(JSON.stringify({ service: 'cursor', action: 'update', channel, position: { x: 0.5, y: 0.5 } }));
        };
        ws.onmessage = e => out.push(JSON.parse(String(e.data)));
        setTimeout(() => { ws.close(); resolve(out); }, 2_000);
      });
    }, CHANNEL);
    expect(frames.some(f => f['type'] === 'error' && f['code'] === 'AUTHZ_CHANNEL_DENIED')).toBe(true);
    expect(frames.some(f => f['type'] === 'cursor')).toBe(false);
    await context.close();
  });
});
