// Piece C2: the lead's room while the call is drawn (InterviewRoomPage.tsx, RoomCallPane). Both in the call (h8-room.mjs), on a
// design round (the board). The call's tiles sit in the shell's right pane; closing that pane must not silence the call.
//   C2a  in the call, the header line does not tell the lead to join the call they are in
//   C2b  every tab body keeps the page's side inset while the shell's gutter is folded (Questions, Details, Provided design)
//   C2c  closing the Call pane (×) keeps the call's media in the document (the shell's hidden outlet holds it, so it keeps
//        playing); a closed SidePane would detach it, and a detached media element is paused
//   C2d  the header's "Show the call" brings the Call pane and its tiles back
import path from 'node:path';
import { staffRoom, joinCall, guestRoom, until, why } from './h8-room.mjs';

/** Where the call's media is drawn on a page, and whether its elements are still in the document. */
const mediaOf = (page) => page.evaluate(() => {
  const all = [...document.querySelectorAll('[data-testid="shell-call-media"]')];
  const docks = all.filter((d) => d.isConnected);
  const els = [...document.querySelectorAll('[data-testid="shell-call-media"] video, [data-testid="shell-call-media"] audio')];
  return {
    docks: docks.length,
    // Drawn in the room's Call pane: the dock is on screen right of the room's workspace.
    inPane: docks.some((d) => { const r = d.getBoundingClientRect(); const w = document.querySelector('[data-testid="interview-room-pane"]')?.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !!w && r.left >= w.right - 1; }),
    visible: docks.filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length,
    tiles: docks.reduce((n, d) => n + d.querySelectorAll('[data-testid*="tile"]').length, 0),
    placement: docks.map((d) => d.dataset.placement).join(',') || 'none',
    under: docks.map((d) => { const ids = []; for (let e = d.parentElement; e && ids.length < 3; e = e.parentElement) if (e.dataset?.testid) ids.push(e.dataset.testid); return ids.join('<'); }).join(' | '),
    media: els.length,
    connected: els.filter((e) => e.isConnected).length,
    paused: els.filter((e) => e.paused).length,
  };
});
const said = (m) => `docks ${m.docks} (placement ${m.placement}, visible ${m.visible}, tiles ${m.tiles}), in the Call pane ${m.inPane}, media elements ${m.media} (connected ${m.connected}, paused ${m.paused})`;

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
    for (const s of ['C2a', 'C2b', 'C2c', 'C2d']) record(s, false, `the two could not meet in the call: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }
  const page = L.page;
  const tab = (name) => page.getByTestId('interview-room-pane').getByRole('tab', { name });
  await step('C2a', async () => {
    // The prompt on the board, opened as the room opens it (the zoom control must sit clear of its red note).
    await page.getByTestId('interview-board-insert').first().click({ timeout: 30_000 }).catch(() => undefined);
    await page.getByRole('menuitem').first().click({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(7000);
    await page.screenshot({ path: path.join(out, 'callpane-lead-board.png') });
    const header = (await page.getByTestId('interview-room-idle').first().innerText()).replace(/\s+/g, ' ');
    return { ok: !/join (it|the call)/i.test(header), detail: `the header reads "${header.slice(0, 200)}"` };
  });
  await step('C2b', async () => {
    const insets = [];
    for (const [name, id] of [[/^Questions/, 'interview-room-tab-questions'], [/^Details/, 'interview-room-tab-details'], [/^Provided design/, 'interview-room-tab-design']]) {
      await tab(name).click();
      const body = page.getByTestId(id).first();
      await body.waitFor({ timeout: 8000 });
      const inset = await body.evaluate((el) => {
        const first = el.firstElementChild; const pane = el.closest('[data-testid="interview-room-pane"]');
        return first && pane ? Math.round(first.getBoundingClientRect().left - pane.getBoundingClientRect().left) : -1;
      });
      insets.push(`${id.replace('interview-room-tab-', '')} ${inset}px`);
    }
    await tab(/^Board/).click();
    return { ok: insets.every((s) => Number(s.split(' ')[1].replace('px', '')) >= 12), detail: insets.join(', ') };
  });
  await step('C2c', async () => {
    const before = await mediaOf(page);
    await page.getByRole('button', { name: /hide the call|collapse call/i }).first().click({ timeout: 8000 });
    const after = await until(async () => { const m = await mediaOf(page); return m.docks > 0 ? m : null; }, 8000) ?? await mediaOf(page);
    await page.screenshot({ path: path.join(out, 'callpane-closed.png') });
    return { ok: before.inPane && after.docks > 0 && !after.inPane && after.connected >= before.connected, detail: `before: ${said(before)}; after ×: ${said(after)}` };
  });
  await step('C2d', async () => {
    const show = page.getByTestId('interview-room-show-call');
    if (!(await show.count())) return { ok: false, detail: 'the header offers no way back to the call' };
    await show.first().click({ timeout: 5000 });
    const back = await until(async () => { const m = await mediaOf(page); return m.inPane ? m : null; }, 8000);
    return { ok: !!back, detail: back ? `the Call pane is back: ${said(back)}` : `not back: ${said(await mediaOf(page))}` };
  });
  await G.page.screenshot({ path: path.join(out, 'callpane-candidate.png') });
  for (const c of open) await c.close().catch(() => undefined);
  if (iv) await endInterview?.(L.context, iv).catch(() => undefined);
  await resetMock();
}
