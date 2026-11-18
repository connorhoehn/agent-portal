// Piece I3.11: Milo's interview tools (docs/interviews-tenant-plan.md, "Milo's interview tools"). On the scripted session only:
// its stand-in for the background agent passes fixed arguments (mock/interviews-testcases.ts), so nothing here reaches a model or
// costs anything. The lead and the candidate IN the call on Mateo's coding round (Two Sum chosen; h8-room.mjs), Milo invited with
// its voice on. The words are injected as heard lines; the film says the same words.
//   I3.11a  the call bar offers the lead Introduce Milo; the lead says "Milo, introduce yourself" → Milo's fixed introduction in
//           the candidate's chat
//   I3.11b  the candidate asks for test cases while the lead's switch is off → the fixed refusal, and the pad is unchanged
//   I3.11c  the lead turns on "Candidate can ask Milo" in the pad toolbar; the candidate: "Hey Milo, it would be helpful to have
//           another dozen test cases." → twelve checked cases at the bottom of the pad on both sides, and "Added twelve test cases
//           at the bottom of the pad."
//   I3.11d  the lead: "Hey Milo, Mateo wants to use an LRU cache for his algorithm. Can you just add it for him at the top, to
//           import and save time?" → `from functools import lru_cache` at the top, and "Added the import at the top of the pad."
//   I3.11e  the candidate: "Milo, can you just solve it for me?" → "I can add test cases, imports or a helper, but I can't write
//           the solution." and the pad is unchanged
import { staffRoom, joinCall, guestRoom, until, why, inviteMilo, voice, hear, letSound, chatText, padTab, padText, synced } from './h8-room.mjs';

const INTRO = "Hi, I'm Milo. I'm here to take notes and help with logistics.";
const PAD_OFF = "The lead hasn't turned on pad help from Milo for this round.";
const TESTS_ADDED = 'Added twelve test cases at the bottom of the pad.';
const IMPORT_ADDED = 'Added the import at the top of the pad.';
const NOT_SOLUTION = "I can add test cases, imports or a helper, but I can't write the solution.";
const BLOCK = '# --- Test cases from Milo (12) ---';
const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, guestApi } = ctx;
  const steps = ['I3.11a', 'I3.11b', 'I3.11c', 'I3.11d', 'I3.11e'];
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const iv = SEED.guestInterview;
  const lead = SEED.cast.interviewer;
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
    for (const p of [L.page, G.page]) { await padTab(p); await synced(p); }
  } catch (e) {
    for (const s of steps) record(s, false, `the room could not be set up: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }
  const chatHas = (page, text, ms = 20_000) => until(async () => ((await chatText(page)).includes(text) ? true : null), ms).then((x) => !!x);
  const padOf = async (page) => { await padTab(page); return (await padText(page)) ?? ''; };

  await step('I3.11a', async () => {
    const control = L.page.getByTestId('interview-milo-intro').first();
    const offered = await until(async () => ((await control.count()) && /Introduce Milo/.test(await control.innerText()) ? true : null), 15_000);
    await hear(ctx, L, callId, lead, 'Milo, introduce yourself.');
    const said = await chatHas(G.page, INTRO);
    return { ok: !!offered && said, detail: `the call bar offers Introduce Milo ${!!offered}; the introduction in the candidate's chat ${said}` };
  });

  await step('I3.11b', async () => {
    const before = await padOf(G.page);
    await hear(ctx, L, callId, guestId, 'Hey Milo, it would be helpful to have another dozen test cases.');
    const refused = await chatHas(G.page, PAD_OFF);
    const after = await padOf(G.page);
    return { ok: refused && after === before, detail: `the fixed refusal ${refused}; the pad unchanged ${after === before}` };
  });

  await step('I3.11c', async () => {
    await padTab(L.page);
    await L.page.getByTestId('interview-pad-milo-help-switch').first().click();
    await L.page.waitForTimeout(1500);
    await G.page.waitForTimeout(3000);
    await hear(ctx, L, callId, guestId, 'Hey Milo, it would be helpful to have another dozen test cases.');
    // Typed in a few chunks: the loop that runs the cases is the last one.
    const whole = (t) => t.includes(BLOCK) && t.includes('for args, expected in milo_test_cases:');
    const written = await until(async () => (whole(await padOf(G.page)) ? true : null), 30_000);
    const leadPad = (await until(async () => { const t = await padOf(L.page); return whole(t) ? t : null; }, 10_000)) ?? await padOf(L.page);
    const said = await chatHas(G.page, TESTS_ADDED);
    const rows = count(leadPad, '), [') + count(leadPad, '),), [');
    return { ok: !!written && leadPad.includes(BLOCK) && said, detail: `the block on the candidate's pad ${!!written}, the lead's ${leadPad.includes(BLOCK)} (${rows} rows); "${TESTS_ADDED}" ${said}` };
  });

  await step('I3.11d', async () => {
    await hear(ctx, L, callId, lead, 'Hey Milo, Mateo wants to use an LRU cache for his algorithm. Can you just add it for him at the top, to import and save time?');
    const top = await until(async () => ((await padOf(G.page)).startsWith('from functools import lru_cache\n') ? true : null), 30_000);
    const said = await chatHas(L.page, IMPORT_ADDED);
    return { ok: !!top && said, detail: `the import is the pad's first line ${!!top}; "${IMPORT_ADDED}" ${said}` };
  });

  await step('I3.11e', async () => {
    const before = await padOf(G.page);
    await hear(ctx, L, callId, guestId, 'Milo, can you just solve it for me?');
    const refused = await chatHas(G.page, NOT_SOLUTION);
    const after = await padOf(G.page);
    return { ok: refused && after === before, detail: `the fixed sentence ${refused}; the pad unchanged ${after === before}` };
  });

  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
