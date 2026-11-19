// Piece C1: the call chat's unread bubble on the interview room's tabs (hooks/useCallChatUnread.ts; docs/interviews-tenant-plan.md, "Call chat unread").
// Both in the call (h8-room.mjs). The lead is on the Questions tab, the candidate posts a link in Chat; the lead's Chat tab carries "1";
// opening Chat clears it; a reload keeps it cleared (the receipt is the server's). Then the reverse: the candidate on Pad, the lead posts.
//   C1a  the lead's Chat tab shows 1 unread after the candidate's message while the lead is on Questions
//   C1b  opening Chat clears it, and it stays cleared after the lead reloads and rejoins
//   C1c  the candidate's Chat tab shows 1 unread after the lead's message while the candidate is on Pad
//   C1d  Milo in, voice off (the scripted session): "Have Milo ask" posts his line; the lead's Milo tab shows 1, the Chat tab none; opening Milo clears it
import path from 'node:path';
import { staffRoom, joinCall, guestRoom, until, why, inviteMilo } from './h8-room.mjs';

const tabOf = (page, pane, name) => page.getByTestId(pane).getByRole('tab', { name });
const post = async (page, text) => {
  const box = page.getByRole('textbox', { name: /message/i }).last();
  await box.click();
  await box.fill(text);
  await box.press('Enter');
};

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, endInterview, out } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const iv = SEED.guestInterview;
  await resetMock();
  let L = null; let G = null;
  try {
    L = await staffRoom(ctx, 'interviewer', iv); open.push(L.context);
    const s = await startInterview(L.context, iv);
    if (s.status !== 200) throw new Error(`start answered ${s.status}`);
    await L.page.reload({ waitUntil: 'domcontentloaded' });
    await L.page.getByTestId('interview-room').first().waitFor({ timeout: 30_000 });
    await joinCall(L.page);
    G = await guestRoom(ctx, iv, L.context); open.push(G.context);
  } catch (e) {
    for (const s of ['C1a', 'C1b', 'C1c', 'C1d']) record(s, false, `the two could not meet in the call: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }
  const lead = (name) => tabOf(L.page, 'interview-room-pane', name);
  const cand = (name) => tabOf(G.page, 'join-room-pane', name);
  await step('C1a', async () => {
    await lead(/^Questions/).click();
    await cand(/^Chat/).click();
    await post(G.page, 'Here is the doc: https://example.test/spec');
    await cand(/^Pad/).click();
    const got = await until(async () => /Chat\s*1\s*unread/i.test(await lead(/^Chat/).innerText().then((t) => t.replace(/\s+/g, ' ')) + ' ' + ((await lead(/^Chat/).getAttribute('aria-label')) ?? '') ) || /Chat 1 unread/i.test(await lead(/^Chat/).innerText().then((t) => t.replace(/\s+/g, ' '))), 20_000);
    const name = await lead(/^Chat/).evaluate((el) => `${el.textContent} | ${el.getAttribute('aria-label') ?? ''}`);
    await L.page.screenshot({ path: path.join(out, 'chatunread-interview-lead.png') });
    return { ok: !!got, detail: `lead's Chat tab reads "${name.replace(/\s+/g, ' ')}"` };
  });
  await step('C1b', async () => {
    await lead(/^Chat/).click();
    await L.page.waitForTimeout(2500);
    const cleared = !/unread/i.test(await lead(/^Chat/).textContent());
    await L.page.reload({ waitUntil: 'domcontentloaded' });
    await L.page.getByTestId('interview-room').first().waitFor({ timeout: 30_000 });
    await joinCall(L.page);
    await L.page.waitForTimeout(3000);
    const after = await lead(/^Chat/).textContent();
    return { ok: cleared && !/unread/i.test(after), detail: `cleared on open ${cleared}; after reload the tab reads "${after.replace(/\s+/g, ' ')}"` };
  });
  await step('C1c', async () => {
    await lead(/^Chat/).click();
    await post(L.page, 'Thanks, reading it now.');
    const got = await until(async () => /unread/i.test(await cand(/^Chat/).textContent()), 20_000);
    const name = await cand(/^Chat/).textContent();
    await G.page.screenshot({ path: path.join(out, 'chatunread-interview-candidate.png') });
    return { ok: !!got, detail: `candidate's Chat tab reads "${name.replace(/\s+/g, ' ')}"` };
  });
  await step('C1d', async () => {
    const callId = await inviteMilo(ctx, L);
    if (!callId) return { ok: false, detail: 'Milo did not come into the call' };
    await ctx.api(L.context, 'POST', `/api/calls/${encodeURIComponent(callId)}/assistant/voice`, { on: false });
    await lead(/^Chat/).click();
    await L.page.waitForTimeout(2500);
    await lead(/^Questions/).click();
    await L.page.getByTestId('interview-room-milo-ask').first().click();
    const got = await until(async () => /unread/i.test(await lead(/^Milo/).textContent()), 20_000);
    const milo = (await lead(/^Milo/).textContent()).replace(/\s+/g, ' ');
    const chatTab = (await lead(/^Chat/).textContent()).replace(/\s+/g, ' ');
    await L.page.screenshot({ path: path.join(out, 'chatunread-interview-milo.png') });
    await lead(/^Milo/).click();
    await L.page.waitForTimeout(2500);
    const after = (await lead(/^Milo/).textContent()).replace(/\s+/g, ' ');
    return { ok: !!got && !/unread/i.test(chatTab) && !/unread/i.test(after), detail: `Milo tab "${milo}", Chat tab "${chatTab}", Milo tab once opened "${after}"` };
  });
  for (const c of open) await c.close().catch(() => undefined);
  await endInterview?.(L.context, iv).catch(() => undefined);
  await resetMock();
}
