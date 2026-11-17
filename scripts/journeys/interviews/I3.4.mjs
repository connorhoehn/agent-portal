// Piece I3.4: the suggestion as a footer prompt, and what the candidate reads of Milo (docs/interviews-tenant-plan.md row
// I3.4, decisions 4, 8, 9, 20; contracts D7 and E9). Nadia's leadership round (behavioural: Wen leads, Hugo on the panel), the
// call on the stand-in media of h3-call.mjs, lines from the mock injector, the scripted coach.
//   I3.4a  a suggestion waits behind the knock: the deck asks "The candidate is waiting" first; Admit from the deck, then the
//          suggestion is asked; End interview puts "End the interview" in front of it; Keep going brings the suggestion back
//   I3.4b  Esc hides the suggestion without answering it (the read still holds it); a later suggestion comes back by itself
//          (today it does not: a finding)
//   I3.4b2 answered from another tab, the lead's page rejoined: the next suggestion is asked
//   I3.4c  a 409 from another tab: the suggestion answered by the API first (the other tab); the deck's answer gets the 409
//          and the deck lets the suggestion go (it is not asked again); a further answer reads "This suggestion was already answered."
//   I3.4d  the panel member in the same call has no prompt, and Milo's notice on his bar has "I understand" and no Dismiss
//   I3.4e  E9 (the candidate's chat): after "Have Milo ask" and the candidate's own two requests (repeat, time), the
//          candidate's history holds Milo's approved question and Milo's answers to those two requests, and nothing else of
//          Milo's (not its joining notice, not a reply posted for the panel); the panel's history holds every one of Milo's
//          posts; the candidate's page received none of the others over its socket (the live frames)
//   I3.4f  panel against candidate: the suggestion's text, while it waits, is on no page and in no read of the candidate's
//   I3.4g  the budget-paused line: the opening's caps set to $0, the lead's bar reads "Suggestions paused" and no suggestion comes
//   I3.4h  reads stop at the end: no suggestion read after End; the transcript and notes polls stop after their three misses
//   I3.4i  the Milo-off lines on the lead's bar in place of Invite: "Milo waits for answers" with no answers, "Milo is off" with
//          the transcript declined (after a reload); the panel member's bar carries the consent line ("No transcript or Milo") and no prompt
//   I3.4j  the lead's open bar takes the candidate's answers without a reload (today it does not: a finding)
import { liveRoom, inject, sleep, chatOf, guestReads, guestChatText, words, setCaps, guestIdentity, guestJoinCall, candidateAnswers, stubCallMedia, joinRoomCall } from './h3-call.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, api, guestApi, clock, middleware, shootPage } = ctx;
  const iv = SEED.panelInterview;
  const WEN = SEED.cast.interviewer2; const HUGO = SEED.cast.interviewer;
  const sgPath = `/api/interviews/interviews/${iv}/suggestion`;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const deckOf = (page) => page.getByTestId('interview-room-ask');
  const deckText = async (page) => ((await deckOf(page).first().innerText({ timeout: 1000 }).catch(() => '')) || '').replace(/\s+/g, ' ');
  const awaitDeck = async (page, re, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const t = await deckText(page); if (re.test(t)) return t; await sleep(1000); }
    return await deckText(page);
  };
  const readSuggestion = async (lead) => (await api(lead, 'GET', sgPath)).body?.suggestion ?? null;
  const say = (room, who, text) => inject(ctx, room.callId, [{ userId: who, text }]);

  // ── one room: the candidate knocks and waits while the first suggestion is made ──
  await resetMock();
  const panelSeat = { userId: HUGO, label: 'panel' };
  let room = null;
  try {
    room = await liveRoom(ctx, { interviewId: iv, leadId: WEN, admitGuest: false, extra: [panelSeat] });
  } catch (e) {
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) record(`I3.4${s}`, false, `the live room did not open: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  if (room) {
    // Every frame the candidate's page receives over its socket, for I3.4e.
    const frames = [];
    room.guest.page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload ?? ''))));
    let sg1 = null;

    await step('I3.4a', async () => {
      await say(room, WEN, 'Tell me about a time you led a team through a hard deadline.');
      const knockFirst = await awaitDeck(room.leadPage, /The candidate is waiting/, 30_000);
      const t0 = Date.now();
      while (!sg1 && Date.now() - t0 < 160_000) { sg1 = await readSuggestion(room.lead); if (!sg1) await sleep(3000); }
      const withBoth = await deckText(room.leadPage);
      await deckOf(room.leadPage).getByRole('button', { name: 'Admit', exact: true }).first().click();
      const after = await awaitDeck(room.leadPage, /Milo suggests/, 30_000);
      await guestIdentity(ctx, room.guest);
      await guestJoinCall(room.guest);
      await room.leadPage.getByTestId('interview-end').click();
      const endFirst = await awaitDeck(room.leadPage, /End the interview/, 10_000);
      await deckOf(room.leadPage).getByRole('button', { name: 'Keep going', exact: true }).first().click();
      const back = await awaitDeck(room.leadPage, /Milo suggests/, 10_000);
      const shots = await shootPage(room.leadPage, 'I3.4a-deck');
      const ok = /The candidate is waiting/.test(knockFirst) && !!sg1 && /The candidate is waiting/.test(withBoth) && !/Milo suggests/.test(withBoth.split('The candidate is waiting')[0])
        && /Milo suggests/.test(after) && /End the interview/.test(endFirst) && !/Milo suggests/.test(endFirst.split('End the interview')[0]) && /Milo suggests/.test(back)
        && shots.every((s) => s.ok);
      return { ok, detail: `knock first "${knockFirst.slice(0, 50)}"; suggestion made ${!!sg1}; after Admit "${after.slice(0, 40)}"; End first "${endFirst.slice(0, 40)}"; Keep going → "${back.slice(0, 40)}"` };
    });

    await step('I3.4f', async () => {
      if (!sg1) return { ok: false, detail: 'no suggestion' };
      const needle = sg1.text.slice(0, 40);
      const chat = await guestChatText(room.guest);
      const page = await room.guest.page.innerText('body').catch(() => '');
      const reads = await guestReads(ctx, room.guest.context);
      const inFrames = frames.some((f) => f.includes(needle));
      const ok = !page.includes(needle) && !reads.includes(needle) && !chat.includes(needle) && !inFrames;
      return { ok, detail: `page ${page.includes(needle)}, reads ${reads.includes(needle)}, chat pane ${chat.includes(needle)}, frames ${inFrames} (${frames.length} seen)` };
    });

    await step('I3.4b', async () => {
      // Esc from inside the deck (it arrives without taking focus, so a person's Esc follows a Tab into it).
      await deckOf(room.leadPage).getByRole('button', { name: 'Skip', exact: true }).first().focus().catch(() => undefined);
      await room.leadPage.keyboard.press('Escape');
      await sleep(1500);
      const hidden = !/Milo suggests/.test(await deckText(room.leadPage));
      const still = await readSuggestion(room.lead);
      // A later suggestion: the gap moved past and a new line said. The hidden one still waits (the coach shows the same one
      // again, never a new one beside it) and the page's poll stopped when it arrived, so nothing can bring the deck back.
      await clock.advance(91_000);
      await say(room, WEN, 'How did you split the work between the two streams?');
      const back = await awaitDeck(room.leadPage, /Milo suggests/, 40_000);
      const ok = hidden && still?.id === sg1.id && /Milo suggests/.test(back);
      return { ok, detail: `Esc hid it ${hidden}; the server still holds it waiting ${still?.id === sg1.id}; 40 s later, with the gap passed and a new line, the deck ${/Milo suggests/.test(back) ? 'is back' : 'stays empty (FINDING: after Esc the lead gets no suggestion again in this call; the waiting one blocks new ones and the page has no way to reopen it)'}` };
    });

    // The other tab: the hidden suggestion is answered by the API, and the lead's page rejoins the call so its poll starts again.
    await step('I3.4b2', async () => {
      const a = await api(room.lead, 'POST', `${sgPath}/${sg1.id}/answer`, { answer: 'ask' });
      await room.leadPage.close();
      room.leadPage = (await joinRoomCall(ctx, room.lead, iv)).page;
      const next = await awaitDeck(room.leadPage, /Milo suggests/, 160_000);
      return { ok: a.status === 200 && /Milo suggests/.test(next), detail: `answered elsewhere ${a.status}; after the lead's page rejoined, the next suggestion "${next.slice(0, 60)}"` };
    });

    let sg2 = null;
    await step('I3.4c', async () => {
      sg2 = await readSuggestion(room.lead);
      if (!sg2) return { ok: false, detail: 'no second suggestion' };
      const other = await api(room.lead, 'POST', `${sgPath}/${sg2.id}/answer`, { answer: 'skip' });
      await deckOf(room.leadPage).getByRole('button', { name: 'Skip', exact: true }).first().click();
      const seenLine = await room.leadPage.getByText('This suggestion was already answered.').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
      const after = await deckText(room.leadPage);
      const again = await api(room.lead, 'POST', `${sgPath}/${sg2.id}/answer`, { answer: 'ask' });
      // Today the deck closes on the 409 (the room drops a suggestion answered elsewhere); the line is shown if the deck keeps it.
      const ok = other.status === 200 && (seenLine || !/Milo suggests/.test(after)) && again.status === 409 && again.body?.error === 'This suggestion was already answered.';
      return { ok, detail: `the other tab ${other.status}; the deck's answer showed the line ${seenLine} (deck now "${after.slice(0, 90)}"); a third answer ${again.status} "${again.body?.error ?? ''}"` };
    });

    await step('I3.4d', async () => {
      const deck = await deckText(panelSeat.page);
      const notice = panelSeat.page.getByTestId('assistant-consent-notice');
      const hasNotice = await notice.first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      const buttons = hasNotice ? (await notice.first().getByRole('button').allInnerTexts()).map((t) => t.trim()).filter(Boolean) : [];
      const ok = !/Milo suggests/.test(deck) && hasNotice && buttons.some((b) => /I understand/.test(b)) && !buttons.some((b) => /Dismiss/i.test(b));
      return { ok, detail: `panel deck "${deck.slice(0, 40)}"; Milo's notice ${hasNotice}, buttons [${buttons.join(', ')}]` };
    });

    await step('I3.4e', async () => {
      // A third suggestion, asked by Milo; then the candidate's two requests; then a reply of Milo's meant for the panel.
      await clock.advance(91_000);
      await say(room, WEN, 'Good. Next question.');
      const t = await awaitDeck(room.leadPage, /Milo suggests/, 160_000);
      const sg3 = await readSuggestion(room.lead);
      if (!sg3) return { ok: false, detail: `no third suggestion ("${t.slice(0, 40)}")` };
      await deckOf(room.leadPage).getByRole('button', { name: 'Have Milo ask', exact: true }).first().click();
      await sleep(2000);
      const repeat = await guestApi(room.guest.context, 'POST', '/milo/request', { request: 'repeat' });
      await clock.advance(11_000);
      const time = await guestApi(room.guest.context, 'POST', '/milo/request', { request: 'time' });
      const PANEL_ONLY = 'A reply Milo wrote for the panel alone.';
      const dev = await fetch(`${middleware}/api/dev/calls/${encodeURIComponent(room.callId)}/assistant-messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'reply', text: PANEL_ONLY, askedBy: WEN, askedByName: 'Wen Zhao' }),
      });
      await sleep(3000);
      const isMilo = (m) => /^agent:/.test(m.userId ?? '');
      const panelMilo = (await chatOf(ctx, room.lead, room.callId)).messages.filter(isMilo).map(words);
      const guestPane = await guestChatText(room.guest, 3000);
      const approved = [sg3.text, repeat.body?.line, time.body?.line].filter(Boolean).map((x) => x.slice(0, 30));
      // Everything of Milo's the panel has that is not approved must be absent from the candidate's pane and frames.
      const others = panelMilo.filter((p) => !approved.some((a) => p.includes(a))).map((p) => p.slice(0, 30)).filter((p) => p.length >= 12);
      const leakedPane = others.filter((o) => guestPane.includes(o));
      const leakedFrames = others.filter((o) => frames.some((f) => f.includes(o)));
      const missing = approved.filter((a) => !guestPane.includes(a));
      const panelHasAll = panelMilo.some((p) => p.includes(PANEL_ONLY)) && approved.every((a) => panelMilo.some((p) => p.includes(a)));
      const ok = repeat.status === 200 && time.status === 200 && dev.status === 201 && others.length > 0 && leakedPane.length === 0 && leakedFrames.length === 0 && missing.length === 0 && panelHasAll;
      return { ok, detail: `requests ${repeat.status}/${time.status}, panel reply ${dev.status}; the panel's Milo posts ${panelMilo.length} (all there ${panelHasAll}), ${others.length} not approved; in the candidate's pane: approved missing ${JSON.stringify(missing)}, others ${JSON.stringify(leakedPane)}; in their ${frames.length} frames: others ${JSON.stringify(leakedFrames)}` };
    });

    await step('I3.4g', async () => {
      await setCaps(ctx, room.recruiter, SEED.openings.em, { budgetCapUsd: 0, interviewCapUsd: 0 });
      await clock.advance(91_000);
      await say(room, WEN, 'Tell me about someone you mentored.');
      let paused = null;
      const end = Date.now() + 160_000;
      while (Date.now() < end) { const r = await api(room.lead, 'GET', sgPath); paused = r.body; if (r.body?.paused === 'budget') break; await sleep(5000); }
      const chip = await room.leadPage.getByTestId('interview-suggestions-paused').first().waitFor({ timeout: 150_000 }).then(() => true, () => false);
      const ok = paused?.paused === 'budget' && paused?.suggestion === null && chip;
      return { ok, detail: `read ${JSON.stringify(paused).slice(0, 80)}; "Suggestions paused" on the lead's bar ${chip}` };
    });

    await step('I3.4h', async () => {
      const r = await api(room.lead, 'GET', `/api/interviews/interviews/${iv}`);
      const e = await api(room.lead, 'POST', `/api/interviews/interviews/${iv}/end`, { revision: r.body?.interview?.revision });
      // The suggestion poll stops at once; the transcript and notes polls stop after three reads that find nothing (by design).
      const seen = { early: { suggestion: 0, other: 0 }, late: { suggestion: 0, other: 0 } };
      let windowName = null;
      room.leadPage.on('request', (rq) => {
        const m = /\/(suggestion|transcript|milo-notes)(\?|$)/.exec(new URL(rq.url()).pathname);
        if (m && windowName) seen[windowName][m[1] === 'suggestion' ? 'suggestion' : 'other'] += 1;
      });
      await sleep(3_000);
      windowName = 'early'; await sleep(30_000);
      windowName = 'late'; await sleep(20_000);
      const ok = e.status === 200 && seen.early.suggestion === 0 && seen.late.suggestion === 0 && seen.early.other <= 6 && seen.late.other === 0;
      return { ok, detail: `end ${e.status}; suggestion reads 3-33 s after ${seen.early.suggestion}, 33-53 s ${seen.late.suggestion}; transcript and notes reads 3-33 s ${seen.early.other} (at most three misses each), 33-53 s ${seen.late.other}` };
    });
    await room.close();
  }

  // ── the Milo-off lines. Aiko's coding round (Wen leads; no answers yet, then declined while the lead's page is open: I3.4j),
  // then Nadia's round answered before the lead opens the room (I3.4i) with Hugo on the panel. ──
  await resetMock();
  let liveLine = null; let waits = 'none';
  await step('I3.4j', async () => {
    const aiko = SEED.interviews.aikoCoding;
    const lead = await ctx.signIn(WEN); await stubCallMedia(lead, 'lead');
    const recruiter = await ctx.signIn(SEED.cast.recruiter);
    try {
      await ctx.startInterview(lead, aiko);
      const { page } = await joinRoomCall(ctx, lead, aiko);
      const block = page.getByTestId('assistant-invite-blocked');
      waits = await block.first().waitFor({ timeout: 30_000 }).then(async () => (await block.first().innerText()).trim(), () => 'none');
      await candidateAnswers(ctx, recruiter, aiko, { recording: true, transcription: false, milo: false });
      const end = Date.now() + 45_000;
      while (Date.now() < end) { liveLine = (await block.first().innerText({ timeout: 1000 }).catch(() => 'none')).trim(); if (liveLine === 'Milo is off') break; await sleep(1000); }
      return { ok: liveLine === 'Milo is off', detail: `no answers: "${waits}"; the lead's open bar 45 s after the candidate declined the transcript: "${liveLine}" (FINDING when it still waits: the room reads the answers once, on load)` };
    } finally { for (const c of [lead, recruiter]) await c.close().catch(() => undefined); }
  });

  await resetMock();
  await step('I3.4i', async () => {
    const lead = await ctx.signIn(WEN); await stubCallMedia(lead, 'lead');
    const hugo = await ctx.signIn(HUGO); await stubCallMedia(hugo, 'panel');
    const recruiter = await ctx.signIn(SEED.cast.recruiter);
    try {
      const s = await ctx.startInterview(lead, iv);
      await candidateAnswers(ctx, recruiter, iv, { recording: true, transcription: false, milo: false });
      const { page } = await joinRoomCall(ctx, lead, iv);
      const block = page.getByTestId('assistant-invite-blocked');
      const off = await block.first().waitFor({ timeout: 30_000 }).then(async () => (await block.first().innerText()).trim(), () => 'none');
      const invite = await page.getByTestId('assistant-invite').count();
      const hp = (await joinRoomCall(ctx, hugo, iv)).page;
      const chip = (await hp.getByTestId('interview-consent').first().innerText({ timeout: 30_000 }).catch(() => '')).trim();
      const hugoDeck = await deckText(hp);
      const sg = await api(lead, 'GET', sgPath);
      const shots = await shootPage(page, 'I3.4i-milo-off');
      const ok = s.status === 200 && waits === 'Milo waits for answers' && off === 'Milo is off' && invite === 0 && chip === 'No transcript or Milo'
        && !/Milo suggests/.test(hugoDeck) && sg.body?.suggestion === null && shots.every((x) => x.ok);
      return { ok, detail: `no answers (Aiko's round) "${waits}"; transcript declined "${off}", Invite ${invite}; panel's consent line "${chip}", panel deck "${hugoDeck.slice(0, 30)}"; suggestion ${JSON.stringify(sg.body?.suggestion ?? null)}` };
    } finally { for (const c of [lead, hugo, recruiter]) await c.close().catch(() => undefined); }
  });
}
