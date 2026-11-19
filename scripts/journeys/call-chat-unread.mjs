// journey:call-chat-unread — the call chat's unread bubble on the Work huddle's Message control and the Social hangout's
// Conversation control (hooks/useCallChatUnread.ts). The interview room's tabs are piece C1 of the interviews journey.
// Two people share a call without media (the SFU stood in, as meeting-assistant.mjs does): the second posts while the first
// has the chat closed; the first sees the bubble; opening the chat clears it.
//   cd portal && npm run journey:call-chat-unread -- --out <dir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(path.join(ROOT, 'portal', 'package.json'));
const playwright = await import(pathToFileURL(req.resolve('playwright')).href);
const chromium = playwright.chromium ?? playwright.default.chromium;
const args = process.argv.slice(2);
const OUT = args[args.indexOf('--out') + 1];
fs.mkdirSync(OUT, { recursive: true });
const PORTAL = process.env.PORTAL_URL.replace(/\/$/, '');
const MIDDLEWARE = process.env.MIDDLEWARE_URL.replace(/\/$/, '');
const SFU = 'http://call-chat-unread.test';
const KEY = 'orgiq.call-prejoin.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; let v = await fn().catch(() => null); while (!v && Date.now() < end) { await sleep(400); v = await fn().catch(() => null); } return v; };
const results = [];
const record = (step, ok, detail) => { results.push({ step, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${detail}`); };
const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, String(e instanceof Error ? e.message : e).split('\n').slice(0, 5).join(' ').replace(/\s+/g, ' ').slice(0, 600)); } };

await fetch(`${MIDDLEWARE}/api/__mock/reset`, { method: 'POST' });
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
async function person(userId, tenant, role, landing) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const login = await context.request.post(`${PORTAL}/api/session/login`, { data: { userId } });
  if (login.status() !== 200) throw new Error(`login ${userId}: ${login.status()}`);
  await context.request.post(`${PORTAL}/api/session/role`, { data: { tenant, role } });
  await context.addInitScript(([k]) => { try { localStorage.setItem(k, JSON.stringify({ micOn: false, cameraOn: false, remember: true })); } catch { /* off */ } }, [KEY]);
  await context.route('**/api/session/realtime-token', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), platformApiUrl: SFU, videoUrl: null } });
  });
  await context.route(`${SFU}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${userId}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'signalling-only', recording: { enabled: false, reason: 'default' } } });
  });
  const page = await context.newPage();
  await page.goto(`${PORTAL}${landing}`, { waitUntil: 'domcontentloaded', timeout: 40_000 });
  return { context, page };
}
const text = async (loc) => (await loc.first().innerText()).replace(/\s+/g, ' ').trim();
const post = async (page, msg) => { const box = page.getByRole('textbox', { name: /^(Huddle )?message$/i }).last(); await box.click(); await box.fill(msg); await box.press('Enter'); };
const open = [];

// Work: a huddle on an initiative page. Vera starts it, Nora accepts; Nora's chat stays closed while Vera posts.
await step('W1 Work huddle', async () => {
  const vera = await person('u-vera', 'orgiq', 'org-leader', '/iq/projects/p-observability'); open.push(vera.context);
  const nora = await person('u-nora', 'orgiq', 'sme', '/iq/projects/p-observability'); open.push(nora.context);
  await vera.page.getByTestId('initiative-header').waitFor({ timeout: 30_000 });
  await nora.page.getByTestId('initiative-header').waitFor({ timeout: 30_000 });
  await sleep(4000);
  await vera.page.getByTestId('initiative-start-call').click();
  await nora.page.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30_000 });
  await vera.page.getByTestId('shell-call-dock').waitFor({ timeout: 30_000 });
  await nora.page.getByTestId('shell-call-dock').waitFor({ timeout: 30_000 });
  if (!(await vera.page.getByRole('textbox', { name: /^(Huddle )?message$/i }).last().isVisible().catch(() => false))) await vera.page.getByTestId('shell-call-dock-chat').click();
  const control = nora.page.getByTestId('shell-call-dock-chat');
  // The huddle pane (the call's conversation) is open by default: Nora closes hers first, so nothing she is shown counts as seen.
  const pane = nora.page.getByText('Huddle dialogue', { exact: true });
  if (await pane.isVisible().catch(() => false)) { await nora.page.getByTestId('page-conversation-pane-close').click(); await pane.waitFor({ state: 'hidden', timeout: 8000 }); }
  await post(vera.page, 'Pushed the dashboard link to the initiative.');
  // The count is drawn by the footer next to the button (the library's HuddleBar chatUnread), outside the button's own text.
  const around = () => control.first().evaluate((el) => (el.parentElement?.textContent ?? '').replace(/\s+/g, ' ').replace(el.textContent, '').trim());
  const got = await until(async () => /\d/.test(await around()) || null);
  const label = `Message + "${await around()}"`;
  await nora.page.screenshot({ path: path.join(OUT, 'chatunread-work.png') });
  await control.first().click();
  await sleep(2500);
  const after = await around();
  return { ok: !!got && !/\d/.test(after), detail: `Nora's Message control reads ${label}; once opened the count beside it is "${after}"` };
});

// Social: a hangout. Mira creates one, Sana joins it; Sana's conversation stays closed while Mira posts.
await step('S1 Social hangout', async () => {
  const mira = await person('u-mira', 'social', 'community-admin', '/social/rooms'); open.push(mira.context);
  const sana = await person('u-sana', 'social', 'participant', '/social/rooms'); open.push(sana.context);
  const joinRoom = async (p) => {
    await p.page.getByTestId('social-room-cards').waitFor({ timeout: 30_000 });
    await p.page.getByRole('button', { name: /^Open (Design crit)$/ }).click();
    await p.page.getByTestId('social-room-join').click({ timeout: 20_000 });
    await p.page.getByRole('dialog').getByRole('button', { name: /join|start|continue/i }).last().click({ timeout: 6000 }).catch(() => undefined);
  };
  await joinRoom(mira); await joinRoom(sana);
  await mira.page.getByTestId('social-room-back').waitFor({ state: 'hidden', timeout: 1000 }).catch(() => undefined);
  const conv = (p) => p.page.getByRole('button', { name: /^Conversation/ }).first();
  await conv(mira.page ? mira : mira).waitFor({ timeout: 40_000 });
  await conv(sana).waitFor({ timeout: 40_000 });
  await sleep(3000);
  await conv(mira).click();
  await post(mira.page, 'Sharing the agenda link for this hangout.');
  const got = await until(async () => /unread/i.test(await conv(sana).innerText()) || /\d/.test(await conv(sana).innerText()));
  const label = (await conv(sana).innerText()).replace(/\s+/g, ' ');
  await sana.page.screenshot({ path: path.join(OUT, 'chatunread-social.png') });
  await conv(sana).click();
  await sleep(2500);
  const after = (await conv(sana).innerText()).replace(/\s+/g, ' ');
  return { ok: !!got && !/\d/.test(after), detail: `Sana's Conversation control reads "${label}"; once opened "${after}"` };
});

for (const c of open) await c.close().catch(() => undefined);
await browser.close();
fs.writeFileSync(path.join(OUT, 'call-chat-unread.json'), JSON.stringify(results, null, 2));
console.log(`journey:call-chat-unread ${results.filter((r) => r.ok).length} passed; ${results.filter((r) => !r.ok).length} failed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
