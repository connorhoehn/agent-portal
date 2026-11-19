// Piece C3: the room's call in three states (components/calls/RoomCallGallery.tsx, lib/roomCallMode.ts). Both in the
// call (h8-room.mjs), on a design round (the board). A technical round's call floats by default: a draggable gallery flush
// in the bottom-right corner, 1rem above the footer; its own controls dock it into the Call pane or minimise it to a pill,
// and the docked pane floats it back. The call's media has exactly one connected holder in every state, so it keeps playing.
//   C3a  the lead's gallery: flush bottom-right (1rem margins, just above the footer), tiles drawn, the room full width
//   C3b  dragged by its header, it moves and the media holder stays in it, connected
//   C3c  "Minimise": a pill names who is in the call; the shell's hidden outlet holds the media (one holder, connected)
//   C3d  the pill restores the gallery and its tiles
//   C3e  the candidate's room: the same gallery, flush above the guest footer, no Call pane
//   C3f  "Dock the call": the Call pane holds the tiles (one holder); its "Float the call" brings the gallery back
import path from 'node:path';
import { staffRoom, joinCall, guestRoom, until, why } from './h8-room.mjs';

const STEPS = ['C3a', 'C3b', 'C3c', 'C3d', 'C3e', 'C3f'];
/** The call's media on a page: where its dock is drawn and whether its elements are still in the document. */
const mediaOf = (page, galleryId) => page.evaluate((gid) => {
  const docks = [...document.querySelectorAll('[data-testid="shell-call-media"]')].filter((d) => d.isConnected);
  const els = [...document.querySelectorAll('[data-testid="shell-call-media"] video, [data-testid="shell-call-media"] audio')];
  const gallery = document.querySelector(`[data-testid="${gid}"]`);
  const g = gallery?.getBoundingClientRect() ?? null;
  // The board draws its help "?" in the footer beside the zoom controls (helpButton="start"); the corner one is hidden.
  const help = [...document.querySelectorAll('.excalidraw .help-icon')].map((h) => h.getBoundingClientRect()).find((r) => r.width > 0) ?? null;
  const tilesBox = gallery?.querySelector('[data-testid="shell-call-media"]')?.getBoundingClientRect() ?? null;
  return {
    docks: docks.length,
    placement: docks.map((d) => d.getAttribute('data-placement')).join(','),
    help: help ? { left: Math.round(help.left), top: Math.round(help.top), right: Math.round(help.right), bottom: Math.round(help.bottom) } : null,
    tilesBox: tilesBox ? { top: Math.round(tilesBox.top), bottom: Math.round(tilesBox.bottom) } : null,
    inGallery: !!gallery && docks.some((d) => gallery.contains(d)),
    tiles: gallery ? gallery.querySelectorAll('[data-testid*="tile"]').length : 0,
    gallery: g ? { left: Math.round(g.left), top: Math.round(g.top), right: Math.round(g.right), bottom: Math.round(g.bottom) } : null,
    media: els.length,
    connected: els.filter((e) => e.isConnected).length,
    paused: els.filter((e) => e.paused).length,
  };
}, galleryId);
const said = (m) => `holders ${m.docks} (${m.placement}), in the gallery ${m.inGallery} (tiles ${m.tiles}${m.gallery ? `, at ${m.gallery.left},${m.gallery.top} to ${m.gallery.right},${m.gallery.bottom}` : ''}), media ${m.media} (connected ${m.connected}, paused ${m.paused})`;
/** The top of the page's footer: the guest page's own footer, or the shell's published floor (its call bar and Social row). */
const footerTop = (page) => page.evaluate(() => {
  const f = document.querySelector('[data-testid="join-room-footer"]');
  if (f) return Math.round(f.getBoundingClientRect().top);
  const floor = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--shell-collaboration-floor')) || 0;
  return Math.round(window.innerHeight - floor);
});
/** Flush in the corner: 1rem (give or take a few px) from the right edge and above the footer. */
const flush = (g, floor, width) => !!g && Math.abs(width - 16 - g.right) <= 4 && Math.abs(floor - 16 - g.bottom) <= 6;
/** The help button against the gallery: covered, beside it (within 24px), or clear. */
const helpNote = (m) => {
  if (!m.help || !m.gallery) return 'help button not found';
  const h = m.help, g = m.gallery;
  const overlap = h.left < g.right && h.right > g.left && h.top < g.bottom && h.bottom > g.top;
  const near = h.left < g.right + 24 && h.right > g.left - 24 && h.top < g.bottom + 24 && h.bottom > g.top - 24;
  return `help button at ${h.left},${h.top} (${overlap ? 'under the gallery' : near ? 'beside the gallery' : 'clear of the gallery'})`;
};

export default async function run(ctx) {
  const { SEED, record, resetMock, endInterview, out, portal } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  await resetMock();
  let L = null; let G = null; let iv = null;
  try {
    // A fresh design round led by Hugo, prepared and started (the board is its surface).
    const recruiter = await ctx.signIn(SEED.cast.recruiter); open.push(recruiter);
    const api = (p) => `${portal}/api/interviews/interviews${p}`;
    const made = await recruiter.request.post(api(''), { data: { applicationId: 'app-7b69njmx', roundId: 'rd-design', leadId: SEED.cast.interviewer, panelIds: [] } });
    iv = (await made.json().catch(() => ({}))).interview?.id ?? null;
    if (!iv) throw new Error(`the round was not assigned (${made.status()})`);
    L = await staffRoom(ctx, 'interviewer', iv); open.push(L.context);
    const row = async () => (await (await L.context.request.get(api(`/${iv}`))).json()).interview;
    const notice = await (await L.context.request.get(api('/panel-notice'))).json().catch(() => ({}));
    if (notice.acknowledged === false && notice.notice?.version) await L.context.request.post(api(`/${iv}/panel-notice`), { data: { version: notice.notice.version } });
    await L.context.request.post(api(`/${iv}/answer`), { data: { revision: (await row()).revision, answer: 'accept' } });
    const when = new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000).toISOString();
    await recruiter.request.put(api(`/${iv}/time`), { data: { revision: (await row()).revision, scheduledAt: when } });
    await L.context.request.put(api(`/${iv}/questions`), { data: { revision: (await row()).revision, questionIds: ['q-be-twitter'] } });
    const s = await L.context.request.post(api(`/${iv}/start`), { data: { revision: (await row()).revision } });
    if (!s.ok()) throw new Error(`start answered ${s.status()}`);
    await L.page.reload({ waitUntil: 'domcontentloaded' });
    await L.page.getByTestId('interview-room').first().waitFor({ timeout: 30_000 });
    await joinCall(L.page);
    G = await guestRoom(ctx, iv, L.context); open.push(G.context);
    await L.page.locator('[data-testid="interview-room"][data-room-live="true"]').first().waitFor({ timeout: 20_000 });
  } catch (e) {
    for (const s of STEPS) record(s, false, `the two could not meet in the call: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }
  const page = L.page;
  await page.setViewportSize({ width: 1440, height: 900 });
  await G.page.setViewportSize({ width: 1440, height: 900 });
  const GID = 'interview-room-gallery';
  let first = null;
  await step('C3a', async () => {
    await page.getByTestId('interview-board-insert').first().click({ timeout: 30_000 }).catch(() => undefined);
    await page.getByRole('menuitem').first().click({ timeout: 10_000 }).catch(() => undefined);
    first = await until(async () => { const m = await mediaOf(page, GID); return m.inGallery && m.tiles > 0 ? m : null; }, 20_000) ?? await mediaOf(page, GID);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(out, 'callfloat-lead.png') });
    const width = await page.getByTestId('interview-room-pane').first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const floor = await footerTop(page);
    const g = first.gallery;
    const bands = g && first.tilesBox ? `bands ${first.tilesBox.top - g.top}px above the tiles (header included) and ${g.bottom - first.tilesBox.bottom}px below` : 'no tiles box';
    // The gallery's switches sit in its title bar (FloatingPanel headerActions), not beside the tiles.
    const inHeader = await page.evaluate((gid) => !!document.querySelector(`[data-testid="${gid}"] [data-testid="floating-panel-header"] [data-testid="${gid}-to-docked"]`), GID);
    const ok = first.inGallery && first.docks === 1 && first.tiles > 0 && flush(g, floor, 1440) && width >= 1380 && inHeader && !helpNote(first).includes('under the gallery');
    return { ok, detail: `${said(first)}; the footer's top ${floor}px; the room ${width}px wide; ${bands}; ${helpNote(first)}; Dock in the header ${inHeader}` };
  });
  await step('C3b', async () => {
    const header = page.getByTestId(GID).getByTestId('floating-panel-header').first();
    const box = await header.boundingBox();
    if (!box) return { ok: false, detail: 'no gallery header to drag' };
    await page.mouse.move(box.x + 40, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 260, box.y - 220, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const m = await mediaOf(page, GID);
    const moved = !!m.gallery && !!first?.gallery && (Math.abs(m.gallery.left - first.gallery.left) > 100 || Math.abs(m.gallery.top - first.gallery.top) > 100);
    return { ok: moved && m.inGallery && m.docks === 1 && m.connected >= (first?.connected ?? 1) && m.paused <= (first?.paused ?? 0), detail: `dragged: ${said(m)}` };
  });
  await step('C3c', async () => {
    // The gallery's × is "Minimise" (FloatingPanel closeIcon="minimize"); the panel draws its own pill.
    await page.getByTestId(GID).getByRole('button', { name: 'Minimise', exact: true }).first().click({ timeout: 8000 });
    const pill = page.getByRole('button', { name: /^Show Call · / }).first();
    await pill.waitFor({ timeout: 8000 });
    await page.waitForTimeout(800);
    const m = await mediaOf(page, GID);
    const words = (await pill.innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: path.join(out, 'callfloat-lead-minimised.png') });
    return { ok: /in the call/.test(words) && m.docks === 1 && m.placement === 'footer' && !m.inGallery && m.connected >= (first?.connected ?? 1) && m.paused <= (first?.paused ?? 0), detail: `pill "${words}"; ${said(m)}` };
  });
  await step('C3d', async () => {
    await page.getByRole('button', { name: /^Show Call · / }).first().click({ timeout: 5000 });
    const back = await until(async () => { const m = await mediaOf(page, GID); return m.inGallery && m.tiles > 0 ? m : null; }, 8000);
    return { ok: !!back, detail: back ? `restored: ${said(back)}` : `not back: ${said(await mediaOf(page, GID))}` };
  });
  await step('C3e', async () => {
    const m = await until(async () => { const x = await mediaOf(G.page, 'join-room-gallery'); return x.inGallery && x.tiles > 0 ? x : null; }, 15_000) ?? await mediaOf(G.page, 'join-room-gallery');
    await G.page.waitForTimeout(2000);
    await G.page.screenshot({ path: path.join(out, 'callfloat-candidate.png') });
    const pane = await G.page.getByTestId('join-room-call-pane').count();
    const floor = await footerTop(G.page);
    const ok = m.inGallery && m.docks === 1 && m.tiles > 0 && pane === 0 && flush(m.gallery, floor, 1440);
    await G.page.getByTestId('join-room-gallery').getByRole('button', { name: 'Minimise', exact: true }).first().click({ timeout: 5000 }).catch(() => undefined);
    await G.page.getByRole('button', { name: /^Show Call · / }).first().waitFor({ timeout: 5000 }).catch(() => undefined);
    await G.page.waitForTimeout(600);
    const mm = await mediaOf(G.page, 'join-room-gallery');
    await G.page.screenshot({ path: path.join(out, 'callfloat-candidate-minimised.png') });
    await G.page.getByRole('button', { name: /^Show Call · / }).first().click({ timeout: 5000 }).catch(() => undefined);
    return { ok: ok && mm.docks === 1 && mm.placement === 'footer', detail: `${said(m)}; Call pane drawn ${pane}; the footer's top ${floor}px; ${helpNote(m)}; minimised: ${said(mm)}` };
  });
  await step('C3f', async () => {
    await page.getByTestId(`${GID}-to-docked`).first().click({ timeout: 8000 });
    const pane = page.getByTestId('interview-room-stage');
    await pane.first().waitFor({ timeout: 8000 });
    const docked = await until(async () => { const m = await page.evaluate(() => {
      const holders = [...document.querySelectorAll('[data-testid="shell-call-media"]')].filter((d) => d.isConnected);
      const p = document.querySelector('[data-testid="interview-room-stage"]');
      return { docks: holders.length, inPane: !!p && holders.some((d) => p.contains(d)), float: !!document.querySelector('[data-testid="interview-room-stage-to-floating"]') };
    }); return m.inPane ? m : null; }, 8000);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, 'callfloat-lead-docked.png') });
    await page.getByTestId('interview-room-stage-to-floating').first().click({ timeout: 5000 });
    const back = await until(async () => { const m = await mediaOf(page, GID); return m.inGallery && m.tiles > 0 ? m : null; }, 8000);
    return { ok: !!docked && docked.docks === 1 && docked.float && !!back && back.docks === 1,
      detail: `docked: ${docked ? `holders ${docked.docks}, in the pane ${docked.inPane}, Float the call ${docked.float}` : 'the pane never held the tiles'}; floated back: ${back ? said(back) : 'not back'}` };
  });
  for (const c of open) await c.close().catch(() => undefined);
  if (iv) await endInterview?.(L.context, iv).catch(() => undefined);
  await resetMock();
}
