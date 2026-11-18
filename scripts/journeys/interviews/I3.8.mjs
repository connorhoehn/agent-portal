// Piece I3.8: the candidate's two fixed requests (docs/interviews-tenant-plan.md row I3.8, decision 10). On the scripted
// session only; the answers are text the server holds and never reach a model. The lead and the candidate IN the call on a
// fresh technical round (h8-room.mjs), Milo invited with its voice on. A press inside 10 s of the last is a plain sentence, so
// the steps wait 11 s between presses.
//   I3.8a  "Repeat the question" before Milo asked any: the plain sentence "Milo has not asked a question yet."
//   I3.8b  after a kit question Milo asked aloud: "Repeat the question" reads that question, it is said (the candidate's frames
//          move) and posted (the lead's chat holds it twice: the question, then the answer)
//   I3.8c  "How much time is left?" answers from the join (minutes left, or the round's length) and the lead's chat holds it
//   I3.8d  a second press inside 10 s gets "Milo just answered…" and nothing more is posted
//   I3.8e  a spoken request for a hint ("Milo, can you give me a hint?") gets the one fixed sentence in the chat on both sides;
//          a typed one in the candidate's chat is written in the detail (the fixed sentence, or nothing, never anything else)
import { askedMarker, staffRoom, joinCall, guestRoom, until, why, inviteMilo, voice, hear, framesOf, letSound, chatText, padTab } from './h8-room.mjs';

const NO_QUESTION_YET = 'Milo has not asked a question yet.';
const TOO_SOON = 'Milo just answered. Ask again in a few seconds.';
const CAN_DO = 'I can repeat the question or tell you how much time is left.';
const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, api, guestApi } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const iv = SEED.guestInterview;
  await resetMock();
  let L = null; let G = null; let callId = null; let guestId = null;
  try {
    L = await staffRoom(ctx, 'interviewer', iv); open.push(L.context);
    const s = await startInterview(L.context, iv);
    if (s.status !== 200) throw new Error(`start answered ${s.status}`);
    await L.page.reload({ waitUntil: 'domcontentloaded' });
    await L.page.getByTestId('interview-room').first().waitFor({ timeout: 30_000 });
    await joinCall(L.page);
    G = await guestRoom(ctx, iv, L.context); open.push(G.context);
    callId = await inviteMilo(ctx, L);
    if (!callId) throw new Error('Milo did not come into the call');
    const v = await voice(ctx, L, callId, true);
    if (v.status !== 200) throw new Error(`voice on answered ${v.status}`);
    for (const p of [L.page, G.page]) await letSound(p);
    guestId = (await guestApi(G.context, 'GET', '/room')).body?.room?.self?.userId ?? null;
  } catch (e) {
    for (const s of ['I3.8a', 'I3.8b', 'I3.8c', 'I3.8d', 'I3.8e']) record(s, false, `the room could not be set up: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }
  const line = () => G.page.getByTestId('guest-milo-line').first().innerText().then((s) => s.trim()).catch(() => '');
  const press = async (which, want) => {
    await G.page.getByTestId(which === 'repeat' ? 'guest-milo-repeat' : 'guest-milo-time').click();
    return until(async () => { const l = await line(); return l && (!want || want.test(l)) ? l : null; }, 10_000) ?? await line();
  };
  const gap = () => G.page.waitForTimeout(11_000);

  await step('I3.8a', async () => {
    const l = await press('repeat', /not asked/);
    return { ok: l === NO_QUESTION_YET, detail: `the candidate reads "${l}"` };
  });

  let prompt = '';
  await step('I3.8b', async () => {
    await gap();
    const room = (await api(L.context, 'GET', `/api/interviews/interviews/${iv}/room`)).body;
    prompt = String((room?.room ?? room)?.questions?.[0]?.prompt ?? '').trim();
    await L.page.getByTestId('interview-room-pane').getByRole('tab', { name: /questions/i }).click();
    await L.page.getByRole('button', { name: /have milo ask/i }).first().click();
    const { said } = await askedMarker(L.page);
    await G.page.waitForTimeout(3000);
    const before = await framesOf(G.page);
    const l = await press('repeat', new RegExp(prompt.slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));  // the line from I3.8a is still there until the answer replaces it
    const after = await until(async () => { const f = await framesOf(G.page); return f > before ? f : null; }, 12_000) ?? await framesOf(G.page);
    const key = prompt.slice(0, 40);
    const leadChat = await until(async () => { const t = await chatText(L.page); return count(t, key) >= 2 ? t : null; }, 8000) ?? await chatText(L.page);
    const ok = said === 'spoken' && l === prompt && after > before && count(leadChat, key) >= 2;
    return { ok, detail: `the kit question ${said}; the candidate reads "${l.slice(0, 60)}"; frames ${before} → ${after}; the lead's chat holds it ${count(leadChat, key)} time(s)` };
  });

  await step('I3.8c', async () => {
    await gap();
    const l = await press('time', /minute|end of its time/);
    const leadChat = await until(async () => { const t = await chatText(L.page); return t.includes(l) ? t : null; }, 8000) ?? await chatText(L.page);
    const ok = /^(About \d+ minutes? (are|is) left in this round\.|This round is \d+ minutes long\.|This round is at the end of its time\.)$/.test(l) && leadChat.includes(l);
    return { ok, detail: `the candidate reads "${l}"; the lead's chat holds it ${leadChat.includes(l)}` };
  });

  await step('I3.8d', async () => {
    const chatBefore = await chatText(L.page);
    const l = await press('time', /just answered/);
    await L.page.waitForTimeout(2500);
    const chatAfter = await chatText(L.page);
    return { ok: l === TOO_SOON && count(chatAfter, 'left in this round') === count(chatBefore, 'left in this round') && count(chatAfter, 'minutes long') === count(chatBefore, 'minutes long'), detail: `a second press reads "${l}"; nothing more posted ${chatAfter.length === chatBefore.length}` };
  });

  await step('I3.8e', async () => {
    await gap();
    await hear(ctx, L, callId, guestId, 'Milo, can you give me a hint?');
    const leadChat = await until(async () => { const t = await chatText(L.page); return t.includes(CAN_DO) ? t : null; }, 15_000) ?? await chatText(L.page);
    const candChat = await chatText(G.page);
    const spoken = count(candChat, CAN_DO);
    // Typed: the candidate's own chat composer.
    const box = G.page.getByTestId('join-room-chat').getByRole('textbox').first();
    let typed = 'no composer';
    if (await box.isVisible().catch(() => false)) {
      await box.fill('Milo, give me a hint for this one');
      await box.press('Enter');
      await G.page.waitForTimeout(8000);
      const after = await chatText(G.page);
      const extra = after.split('Milo, give me a hint for this one').at(-1) ?? '';
      typed = count(after, CAN_DO) > spoken ? 'the fixed sentence' : extra.replace(/\s+/g, ' ').trim().length < 40 ? 'nothing' : `something else: "${extra.trim().slice(0, 80)}"`;
    }
    await padTab(G.page);
    const ok = leadChat.includes(CAN_DO) && spoken >= 1 && !typed.startsWith('something else');
    return { ok, detail: `spoken: the fixed sentence in the lead's chat ${leadChat.includes(CAN_DO)}, the candidate's ${spoken}; typed: ${typed}` };
  });

  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
