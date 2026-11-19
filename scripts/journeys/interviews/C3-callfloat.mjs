// Piece C3: the call floats (components/calls/RoomCallGallery.tsx). Both in the call (h8-room.mjs), on a design round
// (the board). While the call is drawn, its tiles sit in a draggable floating gallery in the bottom-right corner, above
// the footer and clear of the board's own controls; the board keeps the page's width. The gallery can be minimised to a
// pill and restored; the call's media stays in the document (playing) in every state.
//   C3a  the lead's gallery: drawn bottom-right over the board, holding the tiles, above the footer; the room is full width
//   C3b  dragged by its header, it moves and the call's media stays attached
//   C3c  minimised (x): a pill names who is in the call; the media is still attached (the shell's hidden outlet holds it)
//   C3d  the pill restores the gallery and its tiles
//   C3e  the candidate's room: the same gallery, the pad or board full width, no Call pane
import path from 'node:path';
import { staffRoom, joinCall, guestRoom, until, why } from './h8-room.mjs';

const STEPS = ['C3a', 'C3b', 'C3c', 'C3d', 'C3e'];
/** The call's media on a page: where its dock is drawn and whether its elements are still in the document. */
const mediaOf = (page, galleryId) => page.evaluate((gid) => {
  const docks = [...document.querySelectorAll('[data-testid="shell-call-media"]')].filter((d) => d.isConnected);
  const els = [...document.querySelectorAll('[data-testid="shell-call-media"] video, [data-testid="shell-call-media"] audio')];
  const gallery = document.querySelector(`[data-testid="${gid}"]`);
  const g = gallery?.getBoundingClientRect() ?? null;
  return {
    docks: docks.length,
    inGallery: !!gallery && docks.some((d) => gallery.contains(d)),
    tiles: gallery ? gallery.querySelectorAll('[data-testid*="tile"]').length : 0,
    gallery: g ? { left: Math.round(g.left), top: Math.round(g.top), right: Math.round(g.right), bottom: Math.round(g.bottom) } : null,
    media: els.length,
    connected: els.filter((e) => e.isConnected).length,
    paused: els.filter((e) => e.paused).length,
  };
}, galleryId);
const said = (m) => `docks ${m.docks}, in the gallery ${m.inGallery} (tiles ${m.tiles}${m.gallery ? `, at ${m.gallery.left},${m.gallery.top} to ${m.gallery.right},${m.gallery.bottom}` : ''}), media ${m.media} (connected ${m.connected}, paused ${m.paused})`;
/** The top of the page's footer (the shell's call bar or the guest page's footer). */
const footerTop = (page) => page.evaluate(() => {
  const f = document.querySelector('[data-testid="join-room-footer"], [data-testid="social-footer"], footer');
  return f ? Math.round(f.getBoundingClientRect().top) : window.innerHeight;
});

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
    const ok = first.inGallery && first.tiles > 0 && !!g && g.right > 1440 - 400 && g.bottom <= floor - 32 && width >= 1400;
    return { ok, detail: `${said(first)}; the footer's top ${floor}px; the room ${width}px wide` };
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
    return { ok: moved && m.inGallery && m.connected >= (first?.connected ?? 1) && m.paused <= (first?.paused ?? 0), detail: `dragged: ${said(m)}` };
  });
  await step('C3c', async () => {
    await page.getByTestId(GID).getByTestId('floating-panel-close').first().click({ timeout: 8000 });
    const pill = page.getByTestId(`${GID}-pill`).first();
    await pill.waitFor({ timeout: 8000 });
    await page.waitForTimeout(800);
    const m = await mediaOf(page, GID);
    const words = (await pill.innerText()).replace(/\s+/g, ' ');
    await page.screenshot({ path: path.join(out, 'callfloat-lead-minimised.png') });
    return { ok: /in the call/.test(words) && m.docks > 0 && !m.inGallery && m.connected >= (first?.connected ?? 1) && m.paused <= (first?.paused ?? 0), detail: `pill "${words}"; ${said(m)}` };
  });
  await step('C3d', async () => {
    await page.getByTestId(`${GID}-restore`).first().click({ timeout: 5000 });
    const back = await until(async () => { const m = await mediaOf(page, GID); return m.inGallery && m.tiles > 0 ? m : null; }, 8000);
    return { ok: !!back, detail: back ? `restored: ${said(back)}` : `not back: ${said(await mediaOf(page, GID))}` };
  });
  await step('C3e', async () => {
    const m = await until(async () => { const x = await mediaOf(G.page, 'join-room-gallery'); return x.inGallery && x.tiles > 0 ? x : null; }, 15_000) ?? await mediaOf(G.page, 'join-room-gallery');
    await G.page.waitForTimeout(2000);
    await G.page.screenshot({ path: path.join(out, 'callfloat-candidate.png') });
    const pane = await G.page.getByTestId('join-room-call-pane').count();
    const floor = await footerTop(G.page);
    return { ok: m.inGallery && m.tiles > 0 && pane === 0 && !!m.gallery && m.gallery.bottom <= floor - 32, detail: `${said(m)}; Call pane drawn ${pane}; the footer's top ${floor}px` };
  });
  for (const c of open) await c.close().catch(() => undefined);
  if (iv) await endInterview?.(L.context, iv).catch(() => undefined);
  await resetMock();
}
