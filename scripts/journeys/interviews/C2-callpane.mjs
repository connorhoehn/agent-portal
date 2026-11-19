// Piece C2: the lead's room while the call is drawn (InterviewRoomPage.tsx). Both in the call (h8-room.mjs), on a design
// round (the board). The call's own states (docked, floating, minimised) and its media are C3-callfloat.mjs.
//   C2a  in the call, the header line does not tell the lead to join the call they are in
//   C2b  every tab body keeps the page's side inset while the shell's gutter is folded (Questions, Details, Provided design)
import path from 'node:path';
import { staffRoom, joinCall, guestRoom, why } from './h8-room.mjs';

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
    for (const s of ['C2a', 'C2b']) record(s, false, `the two could not meet in the call: ${why(e)}`);
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
  for (const c of open) await c.close().catch(() => undefined);
  if (iv) await endInterview?.(L.context, iv).catch(() => undefined);
  await resetMock();
}
