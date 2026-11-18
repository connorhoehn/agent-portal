// Piece I4.2: the pad in the room (docs/interviews-tenant-plan.md row I4.2, decision 11, contract U2). Both sides are IN the
// call (the SFU stood in: h8-room.mjs says why), so the candidate's pane holds the pad.
//   I4.2a  the row's judge line: the lead and the candidate (a minted link) on a fresh technical round type into one pad on
//          the gateway at the same time, and both read the same text with both lines in it
//   I4.2b  each sees the other's named caret: the lead reads "Candidate", the candidate reads the lead's name (the one panel
//          name the candidate is given) and never "Candidate"
//   I4.2c  the shared language: the lead chooses JavaScript and the candidate's select follows; shots of both at 1440 and 1280
//   I4.2d  three people on the seeded live round (Hugo leads, Wen on the panel): each page draws the other two carets; the
//          candidate's carets hold no panel member's name but the lead's
//   I4.2e  only the lead has Insert a question; the insert keeps what was there and adds the prompt as comments and the
//          starter after it, the same text for all three; the candidate's pane is Pad and Chat only
//   I4.2f  "Have Milo ask" on a kit question (Milo invited into the call) puts the question in the pad once, for both people
//   I4.2g  a behavioural round has no Pad tab: the lead's room (Plan, Milo, Chat) and the candidate's pane (no tabs, the chat)
//   I4.2h  the pad's text is the gateway's memory, not the mock world's: resetMock leaves it (pinned; only a restart empties it)
import { askedMarker, staffRoom, joinCall, guestRoom, pad, synced, padText, carets, typeInPad, languageOf, chooseLanguage, until, why, inviteMilo } from './h8-room.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, shootPage, api } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const close = async () => { for (const c of open.splice(0)) await c.close().catch(() => undefined); };
  const lead = SEED.cast.interviewer;
  const leadName = SEED.names[lead];
  const wenName = SEED.names[SEED.cast.interviewer2];

  // ── two people on a fresh technical round ────────────────────────────────────────────────────────────────
  await resetMock();
  const iv = SEED.guestInterview;
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
    for (const s of ['I4.2a', 'I4.2b', 'I4.2c']) record(s, false, `the two could not meet in the call: ${why(e)}`);
  }
  if (L && G) {
    await step('I4.2a', async () => {
      const both = (await synced(L.page)) && (await synced(G.page));
      if (!both) return { ok: false, detail: `the pads did not come into sync (lead ${await pad(L.page).getAttribute('data-connection').catch(() => 'none')}, candidate ${await pad(G.page).getAttribute('data-connection').catch(() => 'none')})` };
      await Promise.all([typeInPad(L.page, '# the lead types here'), typeInPad(G.page, 'print("the candidate types here")')]);
      const same = await until(async () => {
        const [a, b] = [await padText(L.page), await padText(G.page)];
        return a !== null && a === b && a.includes('the lead types here') && a.includes('the candidate types here') ? a : null;
      }, 15_000);
      const [a, b] = [await padText(L.page), await padText(G.page)];
      return { ok: !!same, detail: same ? `both read the same ${same.length} characters with both lines` : `lead ${JSON.stringify(a)} / candidate ${JSON.stringify(b)}` };
    });
    await step('I4.2b', async () => {
      const lc = await until(async () => { const c = await carets(L.page); return c.includes('Candidate') ? c : null; }, 10_000) ?? await carets(L.page);
      const gc = await until(async () => { const c = await carets(G.page); return c.includes(leadName) ? c : null; }, 10_000) ?? await carets(G.page);
      const ok = lc.includes('Candidate') && gc.includes(leadName) && !gc.includes('Candidate') && !gc.includes(wenName);
      return { ok, detail: `the lead's carets ${JSON.stringify(lc)}; the candidate's ${JSON.stringify(gc)}` };
    });
    await step('I4.2c', async () => {
      await chooseLanguage(L.page, 'JavaScript');
      const followed = await until(async () => /JavaScript/.test((await languageOf(G.page)) ?? ''), 10_000);
      await shootPage(L.page, 'I4.2-lead-pad');
      await shootPage(G.page, 'I4.2-candidate-pad');
      return { ok: !!followed && /JavaScript/.test((await languageOf(L.page)) ?? ''), detail: `the lead ${await languageOf(L.page)}, the candidate ${await languageOf(G.page)}` };
    });
  }
  await close();

  // ── three people on the seeded live round ────────────────────────────────────────────────────────────────
  await resetMock();
  const live = SEED.interviews.kwameLive;
  let H = null; let W = null; let C = null; let stage = '';
  try {
    stage = 'the lead joins';
    H = await staffRoom(ctx, 'interviewer', live); open.push(H.context);
    await joinCall(H.page);
    stage = 'the panel member joins';
    W = await staffRoom(ctx, 'interviewer2', live); open.push(W.context);
    await joinCall(W.page);
    stage = 'the candidate joins';
    C = await guestRoom(ctx, live, H.context); open.push(C.context);
  } catch (e) {
    for (const s of ['I4.2d', 'I4.2e', 'I4.2f']) record(s, false, `the three could not meet in the call (${stage}): ${why(e)}`);
  }
  if (H && W && C) {
    await step('I4.2d', async () => {
      const all = (await synced(H.page)) && (await synced(W.page)) && (await synced(C.page));
      if (!all) return { ok: false, detail: 'the three pads did not come into sync' };
      await typeInPad(H.page, '# Hugo');
      await typeInPad(W.page, '\n# Wen');
      await typeInPad(C.page, '\nprint("Kwame")');
      const want = { H: ['Candidate', wenName], W: ['Candidate', leadName], C: [leadName] };
      const seen = async () => ({ H: await carets(H.page), W: await carets(W.page), C: await carets(C.page) });
      const got = await until(async () => { const s = await seen(); return Object.entries(want).every(([k, names]) => names.every((n) => s[k].includes(n))) ? s : null; }, 12_000) ?? await seen();
      const leak = got.C.filter((n) => n !== leadName && n !== 'Candidate');
      const ok = Object.entries(want).every(([k, names]) => names.every((n) => got[k].includes(n))) && leak.length === 0;
      return { ok, detail: `carets: lead ${JSON.stringify(got.H)}, panel ${JSON.stringify(got.W)}, candidate ${JSON.stringify(got.C)}${leak.length ? `; the candidate reads a panel member's name: ${JSON.stringify(leak)}` : ''}` };
    });
    await step('I4.2e', async () => {
      const inserts = { lead: await H.page.getByTestId('interview-pad-insert').count(), panel: await W.page.getByTestId('interview-pad-insert').count(), candidate: await C.page.getByTestId('interview-pad-insert').count() };
      const before = await padText(H.page);
      await H.page.getByTestId('interview-pad-insert').first().click({ timeout: 5000 });
      await H.page.getByRole('menuitem').first().click({ timeout: 5000 });
      const after = await until(async () => { const t = await padText(H.page); return t && t !== before ? t : null; }, 8000);
      const same = after ? await until(async () => ((await padText(W.page)) === after && (await padText(C.page)) === after ? true : null), 10_000) : null;
      const added = after && before !== null && after.startsWith(before) ? after.slice(before.length) : null;
      const commented = !!added && added.split('\n').some((l) => /^\s*(#|\/\/)\s*\S/.test(l));
      const tabs = (await C.page.getByTestId('join-room-pane').getByRole('tab').allInnerTexts()).map((s) => s.trim());
      const ok = inserts.lead === 1 && inserts.panel === 0 && inserts.candidate === 0 && !!same && !!added && commented && JSON.stringify(tabs) === '["Pad","Chat"]';
      return { ok, detail: `Insert a question: ${JSON.stringify(inserts)}; kept what was there ${!!added}, the prompt as comments ${commented}, the same for all three ${!!same}; the candidate's tabs ${JSON.stringify(tabs)}` };
    });
    await step('I4.2f', async () => {
      // Milo joins from the footer's own control (Work's Invite Milo), then the Questions tab's "Have Milo ask".
      const inCall = await inviteMilo(ctx, H);
      const before = await padText(H.page);
      await H.page.getByTestId('interview-room-pane').getByRole('tab', { name: /questions/i }).click({ timeout: 5000 });
      const room = (await api(H.context, 'GET', `/api/interviews/interviews/${live}/room`)).body;
      const prompt = String((room?.room ?? room)?.questions?.[0]?.prompt ?? '').trim();
      await H.page.getByRole('button', { name: /have milo ask/i }).first().click({ timeout: 5000 });
      const { said } = await askedMarker(H.page);
      await H.page.getByTestId('interview-room-pane').getByRole('tab', { name: /^pad$/i }).click({ timeout: 5000 }).catch(() => undefined);
      const after = await until(async () => { const t = await padText(H.page); return t && t !== before ? t : null; }, 15_000);
      const cand = after ? await until(async () => ((await padText(C.page)) === after ? after : null), 10_000) : null;
      const key = prompt.split(/\s+/).slice(0, 4).join(' ');
      const times = after && key ? after.split(key).length - 1 : -1;
      await H.page.waitForTimeout(3000);
      const settled = await padText(H.page);
      const ok = !!inCall && !!said && said !== 'error' && !!cand && times === 1 && settled === after;
      return { ok, detail: `Milo in the call ${!!inCall}; said ${said}; the question in the pad ${times} time(s) ("${key}…"); the candidate's pad the same ${!!cand}; no second insert ${settled === after}` };
    });
  }
  await close();

  // ── a behavioural round: no Pad tab on either side ───────────────────────────────────────────────────────
  await resetMock();
  const behavioural = SEED.panelInterview;
  await step('I4.2g', async () => {
    const B = await staffRoom(ctx, 'interviewer2', behavioural); open.push(B.context);
    const s = await startInterview(B.context, behavioural);
    if (s.status !== 200) return { ok: false, detail: `start answered ${s.status}` };
    await B.page.reload({ waitUntil: 'domcontentloaded' });
    await B.page.getByTestId('interview-room-pane').first().waitFor({ timeout: 30_000 });
    const leadTabs = (await B.page.getByTestId('interview-room-pane').getByRole('tab').allInnerTexts()).map((t) => t.trim());
    await joinCall(B.page);
    const G2 = await guestRoom(ctx, behavioural, B.context); open.push(G2.context);
    const candTabs = (await G2.page.getByTestId('join-room-pane').getByRole('tab').allInnerTexts()).map((t) => t.trim());
    const pads = (await B.page.getByTestId('interview-pad').count()) + (await G2.page.getByTestId('interview-pad').count()) + (await G2.page.getByTestId('join-room-pad').count());
    const chat = await G2.page.getByTestId('join-room-chat').count();
    const ok = !leadTabs.some((t) => /pad/i.test(t)) && leadTabs.length === 3 && candTabs.length === 0 && pads === 0 && chat === 1;
    return { ok, detail: `the lead's tabs ${JSON.stringify(leadTabs)}; the candidate's ${JSON.stringify(candTabs)}; pads drawn ${pads}; the candidate's chat ${chat}` };
  });
  await close();

  // ── the pad's text after a reset ─────────────────────────────────────────────────────────────────────────
  await step('I4.2h', async () => {
    // Write into the seeded live round's pad, reset, open it again.
    await resetMock();
    const A = await staffRoom(ctx, 'interviewer', live); open.push(A.context);
    if (!(await synced(A.page))) return { ok: false, detail: 'the pad did not sync before the reset' };
    await typeInPad(A.page, '# written before the reset');
    await until(async () => ((await padText(A.page)) ?? '').includes('before the reset'), 5000);
    await A.page.waitForTimeout(1500);
    await close();
    await resetMock();
    const B = await staffRoom(ctx, 'interviewer', live); open.push(B.context);
    if (!(await synced(B.page))) return { ok: false, detail: 'the pad did not sync after the reset' };
    await B.page.waitForTimeout(1500);
    const text = (await padText(B.page)) ?? '';
    // Pinned (the walk of 17 Nov): the mock world's reset does not touch the gateway's document, so a pad keeps its text until
    // the middleware restarts. The seeded live round's pad opens empty only on a fresh stack. Reported for the harness.
    const kept = text.includes('written before the reset');
    return { ok: kept, detail: kept ? 'after resetMock the pad still holds what was written: the text lives until the middleware restarts (the reset does not clear the gateway\'s document)' : `after resetMock the pad reads ${JSON.stringify(text.slice(0, 80))}` };
  });
  await close();
  await resetMock();
}
