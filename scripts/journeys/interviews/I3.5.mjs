// Piece I3.5: Milo asks aloud (docs/interviews-tenant-plan.md row I3.5, decision 9). On the scripted session only (the stack
// runs MOCK_VOICE=1 and no key): the live provider is never called. Three people IN the call on the seeded live round
// (Hugo leads, Wen on the panel, the candidate through a minted link; h8-room.mjs). The candidate's audio is counted the way
// SPEAK's proof counted it: the frames its Milo voice played (`guest-milo-voice` data-voice-frames).
//   I3.5a  "Have Milo ask" on a suggestion (the scripted coach; up to 160 s): the footer's receipt "Milo asked it aloud", the
//          words in the call chat on both sides, Milo's voice played on the lead's, the panel member's and the candidate's
//          side (frames moved; a speaking mark seen while it played is written in the detail), the candidate's line holds it
//   I3.5b  "Have Milo ask" on a kit question in the Questions tab: spoken, the receipt line, in the candidate's chat
//   I3.5c  the scripted session says something of its own ("Milo, what is two plus two?"): the candidate's frame count does
//          not move and the answer is posted nowhere
//   I3.5d  voice off: "Have Milo ask" is chat only, the receipt says so, and the candidate's frames do not move
//   I3.5e  a panel member has no "Have Milo ask" (Questions tab, footer) and the say route is not-found to them
//   I3.5f  the candidate's page holds the question and nothing else of Milo's: no suggestion quote, no prompt deck words,
//          no transcript line, no receipt
//   I3.5g  after the end, the said log (the recruiter's export of what Milo showed): one row per approved ask, oldest first,
//          spoken true for the two said aloud and false for the chat-only one
import { askedMarker, catchText, staffRoom, joinCall, guestRoom, until, why, inviteMilo, voice, hear, framesOf, speakingOn, letSound, chatText, padTab, suggestion } from './h8-room.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, endInterview, api, guestApi } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const iv = SEED.interviews.kwameLive;
  const lead = SEED.cast.interviewer;
  await resetMock();
  let H = null; let W = null; let C = null; let callId = null; let guestId = null;
  try {
    H = await staffRoom(ctx, 'interviewer', iv); open.push(H.context);
    await joinCall(H.page);
    W = await staffRoom(ctx, 'interviewer2', iv); open.push(W.context);
    await joinCall(W.page);
    C = await guestRoom(ctx, iv, H.context); open.push(C.context);
    callId = await inviteMilo(ctx, H);
    if (!callId) throw new Error('Milo did not come into the call');
    const v = await voice(ctx, H, callId, true);
    if (v.status !== 200) throw new Error(`voice on answered ${v.status}`);
    for (const p of [H.page, W.page, C.page]) await letSound(p);
    guestId = (await guestApi(C.context, 'GET', '/room')).body?.room?.self?.userId ?? null;
  } catch (e) {
    for (const s of ['I3.5a', 'I3.5b', 'I3.5c', 'I3.5d', 'I3.5e', 'I3.5f', 'I3.5g']) record(s, false, `the room could not be set up: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }
  const frames = async () => ({ lead: await framesOf(H.page), panel: await framesOf(W.page), candidate: await framesOf(C.page) });
  /** Sample the three speaking marks while `ms` passes. */
  const watchSpeaking = async (ms) => {
    const seen = { lead: false, panel: false, candidate: false };
    const end = Date.now() + ms;
    while (Date.now() < end) {
      seen.lead ||= await speakingOn(H.page); seen.panel ||= await speakingOn(W.page); seen.candidate ||= await speakingOn(C.page);
      await new Promise((r) => setTimeout(r, 150));
    }
    return seen;
  };
  let suggestionText = ''; let basedOn = '';

  await step('I3.5a', async () => {
    const lines = [
      { userId: lead, text: 'Thanks for joining. Let us start with how you would design a rate limiter for a public API.' },
      { userId: guestId, text: 'I would put a token bucket per API key in front of the service, kept in a shared cache so every node agrees.' },
      { userId: lead, text: 'Good. And what happens when that cache is slow or down?' },
      { userId: guestId, text: 'I would fail open for reads with a local fallback bucket, and log it so we can see it happened.' },
    ];
    for (const l of lines) { await hear(ctx, H, callId, l.userId, l.text); await H.page.waitForTimeout(400); }
    const deckText = await suggestion(H.page);
    if (!deckText) return { ok: false, detail: 'no suggestion within 160 s' };
    basedOn = ((await H.page.getByTestId('interview-suggestion-based-on').first().getAttribute('title').catch(() => null)) ?? '').trim();
    const before = await frames();
    await H.page.getByTestId('interview-room-ask').getByRole('button', { name: /have milo ask/i }).click();
    const receiptP = catchText(H.page, 'interview-room-ask', /asked it aloud/, 6000);
    const marks = await watchSpeaking(6000);
    const receipt = await receiptP;
    const after = await until(async () => { const f = await frames(); return f.candidate > before.candidate && f.lead > before.lead && f.panel > before.panel ? f : null; }, 12_000) ?? await frames();
    // The suggestion's words: what the candidate's line now holds (the last question Milo asked).
    suggestionText = ((await C.page.getByTestId('guest-milo-question').first().innerText().catch(() => '')) ?? '').trim();
    const leadChat = await chatText(H.page);
    const candChat = await chatText(C.page);
    await padTab(H.page); await padTab(C.page);
    const key = suggestionText.slice(0, 40);
    const ok = /Milo asked it aloud/.test(receipt) && after.candidate > before.candidate && after.lead > before.lead && after.panel > before.panel
      && !!key && deckText.includes(key.slice(0, 25)) && leadChat.includes(key) && candChat.includes(key);
    return { ok, detail: `receipt "${receipt.slice(0, 80)}"; frames ${JSON.stringify(before)} → ${JSON.stringify(after)}; speaking seen ${JSON.stringify(marks)}; the candidate's line "${key}"; in the lead's chat ${leadChat.includes(key)}, the candidate's ${candChat.includes(key)}` };
  });

  await step('I3.5b', async () => {
    const before = await frames();
    await H.page.getByTestId('interview-room-pane').getByRole('tab', { name: /questions/i }).click();
    const room = (await api(H.context, 'GET', `/api/interviews/interviews/${iv}/room`)).body;
    const q = (room?.room ?? room)?.questions?.[1] ?? (room?.room ?? room)?.questions?.[0];
    await H.page.getByRole('button', { name: /have milo ask/i }).nth((room?.room ?? room)?.questions?.length > 1 ? 1 : 0).click();
    const { said, line } = await askedMarker(H.page);
    const after = await until(async () => { const f = await frames(); return f.candidate > before.candidate ? f : null; }, 12_000) ?? await frames();
    const key = String(q?.prompt ?? '').trim().slice(0, 40);
    const cand = await chatText(C.page);
    await padTab(C.page);
    const ok = said === 'spoken' && /aloud/.test(line) && after.candidate > before.candidate && !!key && cand.includes(key);
    return { ok, detail: `said ${said} "${line}"; the candidate's frames ${before.candidate} → ${after.candidate}; the question in the candidate's chat ${cand.includes(key)}` };
  });

  await step('I3.5c', async () => {
    const before = await frames();
    await hear(ctx, H, callId, lead, 'Milo, what is two plus two?');
    await H.page.waitForTimeout(9000);
    const after = await frames();
    const leadChat = await chatText(H.page);
    const candChat = await chatText(C.page);
    await padTab(C.page);
    const posted = /\bFour\b/.test(leadChat) || /\bFour\b/.test(candChat);
    return { ok: after.candidate === before.candidate && !posted, detail: `the candidate's frames ${before.candidate} → ${after.candidate}; the session's own answer posted ${posted}` };
  });

  await step('I3.5d', async () => {
    const off = await voice(ctx, H, callId, false);
    await H.page.waitForTimeout(1500);
    const before = await frames();
    await H.page.getByTestId('interview-room-pane').getByRole('tab', { name: /questions/i }).click();
    await H.page.getByTestId('interview-room-milo-ask').first().click();
    const said = await until(async () => { const s = await H.page.getByTestId('interview-room-milo-said').first().getAttribute('data-said'); return s === 'chat' || s === 'error' ? s : null; }, 10_000)
      ?? await H.page.getByTestId('interview-room-milo-said').first().getAttribute('data-said').catch(() => null);
    const line = await H.page.getByTestId('interview-room-milo-said').first().innerText().catch(() => '');
    await H.page.waitForTimeout(4000);
    const after = await frames();
    return { ok: off.status === 200 && said === 'chat' && /chat/i.test(line) && after.candidate === before.candidate, detail: `voice off ${off.status}; said ${said} "${line}"; the candidate's frames ${before.candidate} → ${after.candidate}` };
  });

  await step('I3.5e', async () => {
    await W.page.getByTestId('interview-room-pane').getByRole('tab', { name: /questions/i }).click({ timeout: 5000 });
    await W.page.waitForTimeout(800);
    const buttons = await W.page.getByTestId('interview-room-milo-ask').count();
    const deck = await W.page.getByTestId('interview-room-ask').getByRole('button', { name: /have milo ask/i }).count();
    const room = (await api(W.context, 'GET', `/api/interviews/interviews/${iv}/room`)).body;
    const qid = (room?.room ?? room)?.questions?.[0]?.id ?? 'q';
    const say = await api(W.context, 'POST', `/api/interviews/interviews/${iv}/say`, { questionId: qid });
    return { ok: buttons === 0 && deck === 0 && say.status === 404, detail: `the panel member's Have Milo ask buttons ${buttons}, in the footer ${deck}; their say ${say.status}` };
  });

  await step('I3.5f', async () => {
    const page = (await C.page.locator('body').innerText()).replace(/\s+/g, ' ');
    const reads = JSON.stringify([(await guestApi(C.context, 'GET', '/room')).body]);
    const forbidden = [
      ['the suggestion quote', basedOn && basedOn.length > 12 ? basedOn.slice(0, 40) : null],
      ['the deck', 'Have Milo ask'], ['the deck', 'I’ll ask it'], ['the deck', 'Based on'],
      ['a receipt', 'Milo asked it aloud'], ['a receipt', 'In the call chat only'],
      ['a transcript line', 'token bucket per API key'], ['the session\'s own answer', 'Four.'],
    ].filter(([, s]) => s && (page.includes(s) || reads.includes(s)));
    const question = suggestionText && page.includes(suggestionText.slice(0, 30));
    return { ok: forbidden.length === 0 && !!question, detail: `the question on the candidate's page ${!!question}; Milo's other things there: ${forbidden.length ? JSON.stringify(forbidden.map(([w]) => w)) : 'none'}` };
  });

  await step('I3.5g', async () => {
    const e = await endInterview(H.context, iv);
    if (e.status !== 200) return { ok: false, detail: `end answered ${e.status}` };
    const recruiter = await ctx.signIn(SEED.cast.recruiter); open.push(recruiter);
    const x = await api(recruiter, 'GET', `/api/interviews/interviews/${iv}/milo-export`);
    const sections = x.body?.sections ?? x.body ?? {};
    const rows = (Array.isArray(sections) ? sections.find((s) => s.key === 'said-aloud')?.data : sections['said-aloud'] ?? sections.saidAloud) ?? [];
    const list = Array.isArray(rows) ? rows : rows.items ?? rows.lines ?? [];
    const questions = list.filter((r) => r.kind === 'question');
    const spoken = questions.map((r) => r.spoken);
    const ok = x.status === 200 && questions.length === 3 && JSON.stringify(spoken) === '[true,true,false]';
    return { ok, detail: `the export ${x.status}; question rows ${questions.length}, spoken ${JSON.stringify(spoken)}; sources ${JSON.stringify(questions.map((r) => r.source))}${list.length ? '' : `; the export's keys ${JSON.stringify(Object.keys(x.body ?? {})).slice(0, 120)}`}` };
  });

  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
