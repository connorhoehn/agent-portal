import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { openAs, signIn } from './realSession';

// Realtime parity gap 6 (docs/audit-loop/realtime-parity.md): message edit and
// delete through the shared conversation panel. Two real pipelines sessions on
// one run's discussion (BFF gateway on /ws): the author edits and the peer sees
// the edited marker; the author deletes and the peer sees the placeholder; the
// peer never gets an edit control; a forged edit frame from the peer is refused.
test.use({ viewport: { width: 1440, height: 900 }, ...(process.env.PARITY_BASE_URL ? { baseURL: process.env.PARITY_BASE_URL } : {}) });
test.describe.configure({ mode: 'serial' });

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map(c => c.close())); });

async function person(browser: Browser, baseURL: string | undefined, userId: string, url: string): Promise<Page> {
  const { context, page } = await openAs(browser, userId, { baseURL, viewport: { width: 1440, height: 900 }, url });
  contexts.push(context);
  await expect(page.getByTestId('pipeline-discussion-panel-composer-input')).toHaveAttribute('contenteditable', 'true', { timeout: 20_000 });
  return page;
}

test('pipelines discussion: edit shows the marker to the peer, delete shows the placeholder, non-author has no controls and a forged edit is refused', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const boot = await browser.newContext({ baseURL }); contexts.push(boot);
  const bp = await boot.newPage(); await bp.goto('/');
  await signIn(bp, 'u-kofi');
  const runs = (await (await bp.request.get('/api/pipelines/runs')).json()).runs as Array<{ id: string }>;
  const url = `/pipelines/runs/${encodeURIComponent(runs[0]!.id)}`;
  const kofi = await person(browser, baseURL, 'u-kofi', url);
  const ines = await person(browser, baseURL, 'u-ines', url);

  const stamp = Date.now();
  const original = `edit probe ${stamp}`;
  const edited = `edited probe ${stamp}`;
  const input = kofi.getByTestId('pipeline-discussion-panel-composer-input');
  await input.click();
  await kofi.keyboard.type(original);
  await kofi.keyboard.press('Enter');
  const mine = kofi.getByText(original, { exact: true });
  const theirs = ines.getByText(original, { exact: true });
  await expect(mine).toBeVisible({ timeout: 15_000 });
  await expect(theirs).toBeVisible({ timeout: 15_000 });

  // Non-author: no Edit or Delete in the hover bar.
  await theirs.hover();
  await expect(ines.getByRole('button', { name: /^(edit|delete)/i })).toHaveCount(0);

  // Author edits; the peer sees the new words and the edited marker.
  await mine.hover();
  await kofi.getByRole('button', { name: /^edit/i }).first().click();
  const editor = kofi.getByRole('textbox').filter({ hasText: original }).or(kofi.locator('textarea')).last();
  await editor.fill(edited);
  await editor.press('Enter');
  await expect(ines.getByText(edited, { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(ines.getByText(/\(edited\)|edited/i).first()).toBeVisible();

  // A forged edit frame from the non-author is refused and changes nothing.
  const refused = await ines.evaluate(async ({ needle, channel }) => {
    const { token } = await (await fetch('/api/session/realtime-token', { credentials: 'include' })).json() as { token: string };
    return new Promise<string>((resolve) => {
      const ws = new WebSocket('ws://localhost:3001/ws', ['bearer-token-v1', token]);
      let sent = false;
      const timer = setTimeout(() => { ws.close(); resolve('timeout'); }, 15_000);
      ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as { type?: string; code?: string; message?: { id?: string; message?: string; channel?: string } };
        if (frame.type === 'session') {
          // Joining replays history, which carries the message id to forge against.
          ws.send(JSON.stringify({ service: 'chat', action: 'join', channel }));
        }
        // Join replays history (a `messages` list or single frames); find the probe by its words.
        const raw = JSON.stringify(ev.data);
        const found = frame.type === 'chat' && raw.includes(needle) && !sent;
        if (found) {
          const list = ((frame as { messages?: unknown[] }).messages ?? [frame.message]) as Array<{ id?: string; message?: string }>;
          const hit = list.find((m) => m?.message?.includes(needle) && m.id);
          if (hit) { sent = true; ws.send(JSON.stringify({ service: 'chat', action: 'edit', channel, messageId: hit.id, message: 'FORGED' })); }
        }
        if (frame.type === 'error' && sent) { clearTimeout(timer); ws.close(); resolve(frame.code ?? 'error'); }
      };
    });
  }, { needle: String(stamp), channel: `pipelines:run:${runs[0]!.id}` });
  // The library's author check answers with a chat error code; an error frame after the forged send means the edit frame was judged.
  expect(refused).not.toBe('timeout'); // an error frame answered the forged edit (sent only after the probe's id was seen)
  await expect(kofi.getByText('FORGED')).toHaveCount(0);

  // Author deletes; the peer sees the placeholder.
  await kofi.getByText(edited, { exact: true }).hover();
  await kofi.getByRole('button', { name: /^delete/i }).first().click();
  await kofi.getByRole('dialog').getByRole('button', { name: /^delete/i }).click();
  await expect(ines.getByTestId('message-deleted').last()).toBeVisible({ timeout: 15_000 });
  await expect(ines.getByText(edited, { exact: true })).toHaveCount(0);
});
