// Piece I3.3: Milo's suggestion for the lead (docs/interviews-tenant-plan.md row I3.3, decisions 8 and 20; contract D7). On
// Nadia's leadership round (behavioural, so the coach reads no pad: Wen leads, Hugo on the panel). The call runs on the
// stand-in media of h3-call.mjs; transcript lines come from the mock injector; the coach is the scripted stand-in.
//   I3.3a  the lead in a live room with the candidate in the call and Milo listening gets a suggestion in the footer deck
//          ("Milo suggests", the competency, the question, I'll ask it / Have Milo ask / Skip); the wait for the first one
//          is bounded at 160 s (the coach may wait up to 120 s when consent arrives late); shots at both widths
//   I3.3b  "I'll ask it" from the deck: the log row reads `ask` (the recruiter's export of the suggestion log)
//   I3.3c  the next suggestion (the interviews clock moved past the 90 s gap, a new line said); "Have Milo ask": the log
//          row reads `milo-ask` and the question is posted in the call chat by Milo with the approved mark (the speech
//          itself is row I3.5's, lane H8)
//   I3.3d  the next suggestion; "Skip": the log row reads `skip`
//   I3.3e  the panel member (Hugo) is in the same call: no deck on his page, and his read of the suggestion is not-found
//   I3.3f  panel against candidate: while a suggestion waits, its text is on no page of the candidate's and in none of the
//          candidate's reads (their own routes and their call chat)
//   I3.3g  Milo declined (transcript yes, Milo no): the lead's bar carries the "Milo off" consent line, Invite stays, and
//          with lines said no suggestion comes (the read says none, the deck stays empty)
import { liveRoom, inject, sleep, chatOf, guestReads, guestChatText, words } from './h3-call.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, api, clock, shootPage } = ctx;
  const iv = SEED.panelInterview;
  const WEN = SEED.cast.interviewer2; const HUGO = SEED.cast.interviewer;
  const sgPath = `/api/interviews/interviews/${iv}/suggestion`;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const deckOf = (page) => page.getByTestId('interview-room-ask');
  const deckText = async (page) => ((await deckOf(page).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
  /** The deck shows a suggestion: up to `ms`. → its text or ''. */
  const awaitDeck = async (page, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = await deckText(page);
      if (/Milo suggests/.test(t)) return t;
      await sleep(1000);
    }
    return '';
  };
  const exportRow = async (recruiter, id) => {
    const r = await api(recruiter, 'GET', `/api/interviews/interviews/${iv}/milo-export`);
    const found = [];
    const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.id === id && 'answer' in x) found.push(x); Object.values(x).forEach(walk); } };
    walk(r.body);
    return { status: r.status, row: found[0] ?? null };
  };
  /** Answer the deck's suggestion with one option, as the lead does. → the receipt text. */
  const answerDeck = async (page, label) => {
    await deckOf(page).getByRole('button', { name: label, exact: true }).first().click();
    const end = Date.now() + 10_000;
    while (Date.now() < end && /Milo suggests/.test(await deckText(page))) await sleep(300);
  };
  const CANDIDATE_LINE = 'I paired with him every morning, and we could tell it was working when his reviews got faster.';
  let seq = 0;
  const say = (room, who, text) => inject(ctx, room.callId, [{ userId: who, text }]).then((r) => { seq += 1; return r; });

  await resetMock();
  let room = null;
  const panelSeat = { userId: HUGO, label: 'panel' };
  try {
    room = await liveRoom(ctx, { interviewId: iv, leadId: WEN, extra: [panelSeat] });
  } catch (e) {
    for (const s of ['a', 'b', 'c', 'd', 'e', 'f']) record(`I3.3${s}`, false, `the live room did not open: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  if (room) {
    const hugo = panelSeat.context; const hugoPage = panelSeat.page;
    let first = null;

    await step('I3.3a', async () => {
      // Wen asks the round's chosen question and the candidate's answer meets one of its follow-ups, so the coach's first
      // suggestion is that follow-up keyed to (and quoting) the candidate's line (E4 #41: a suggestion not keyed to a line
      // quotes none, so an off-plan question would get the next chosen question with no quote).
      const inj = await say(room, WEN, 'Tell me about someone on your team who was struggling. What did you do, and what happened?');
      await say(room, room.guest.guestId, CANDIDATE_LINE);
      const t0 = Date.now();
      const text = await awaitDeck(room.leadPage, 160_000);
      const waited = Math.round((Date.now() - t0) / 1000);
      const read = await api(room.lead, 'GET', sgPath);
      first = read.body?.suggestion ?? null;
      const shots = text ? await shootPage(room.leadPage, 'I3.3a-suggestion') : [];
      // The candidate's line is the quote: their words were kept (they joined the call before Milo, all three answers yes).
      const quoted = first?.basedOn === CANDIDATE_LINE;
      const ok = inj.status === 202 && inj.listeners >= 1 && !!first && quoted && text.includes(first.text.slice(0, 40)) && /I’ll ask it/.test(text)
        && /Have Milo ask/.test(text) && /Skip/.test(text) && shots.every((s) => s.ok);
      return { ok, detail: `deck after ${waited} s (bounded at 160 s): "${text.slice(0, 140)}"; based on the candidate's line ${quoted}; listeners ${inj.listeners}; read ${read.status}; shots ${shots.map((s) => s.width).join(', ')}` };
    });

    await step('I3.3f', async () => {
      if (!first) return { ok: false, detail: 'no suggestion to look for' };
      const needle = first.text.slice(0, 40);
      const chat = await guestChatText(room.guest);
      const page = await room.guest.page.innerText('body').catch(() => '');
      const reads = await guestReads(ctx, room.guest.context);
      const inChat = chat.includes(needle);
      const ok = !page.includes(needle) && !reads.includes(needle) && chat.length > 0 && !inChat;
      return { ok, detail: `candidate page has it ${page.includes(needle)}, their reads ${reads.includes(needle)}, their chat pane ("${chat.slice(0, 50)}") ${inChat}` };
    });

    await step('I3.3e', async () => {
      const deck = hugoPage ? await deckText(hugoPage) : 'NO PAGE';
      const read = await api(hugo, 'GET', sgPath);
      const ok = !!hugoPage && !/Milo suggests/.test(deck) && read.status === 404;
      return { ok, detail: `panel deck "${deck.slice(0, 60)}"; panel read ${read.status}` };
    });

    await step('I3.3b', async () => {
      if (!first) return { ok: false, detail: 'no suggestion' };
      // The next suggestion is made right after this answer: the gap is moved past and a new line said first.
      await clock.advance(91_000);
      await say(room, room.guest.guestId, 'After the launch I wrote down what slowed us and we changed how we planned.');
      await say(room, WEN, 'What did you change in how you planned?');
      await answerDeck(room.leadPage, 'I’ll ask it');
      const row = await exportRow(room.recruiter, first.id);
      return { ok: row.row?.answer === 'ask', detail: `export ${row.status}: ${first.id} answer ${row.row?.answer ?? 'none'}` };
    });

    let second = null;
    await step('I3.3c', async () => {
      const text = await awaitDeck(room.leadPage, 160_000);
      second = (await api(room.lead, 'GET', sgPath)).body?.suggestion ?? null;
      if (!second) return { ok: false, detail: `no second suggestion (deck "${text.slice(0, 60)}")` };
      await clock.advance(91_000);
      await say(room, WEN, 'Thank you. Let us move on.');
      await answerDeck(room.leadPage, 'Have Milo ask');
      const row = await exportRow(room.recruiter, second.id);
      const panelChat = await chatOf(ctx, room.lead, room.callId);
      const posted = panelChat.messages.filter((m) => words(m).includes(second.text.slice(0, 40)));
      const byMilo = posted.some((m) => /^agent:/.test(m.userId ?? ''));
      const guestSees = (await guestChatText(room.guest)).includes(second.text.slice(0, 40));
      const ok = row.row?.answer === 'milo-ask' && byMilo && guestSees;
      return { ok, detail: `export: answer ${row.row?.answer ?? 'none'}; in the panel's chat by Milo ${byMilo} (${posted.length}); in the candidate's chat ${guestSees}` };
    });

    await step('I3.3d', async () => {
      await clock.advance(91_000);
      await say(room, WEN, 'Tell me about a disagreement in your team.');
      const text = await awaitDeck(room.leadPage, 160_000);
      const third = (await api(room.lead, 'GET', sgPath)).body?.suggestion ?? null;
      if (!third) return { ok: false, detail: `no third suggestion (deck "${text.slice(0, 60)}")` };
      await answerDeck(room.leadPage, 'Skip');
      const row = await exportRow(room.recruiter, third.id);
      return { ok: row.row?.answer === 'skip', detail: `export: ${third.id} answer ${row.row?.answer ?? 'none'}` };
    });
    await room.close();
  }

  // Milo declined: the transcript yes, Milo no. Invite stays (Milo may keep the transcript), the consent line says Milo is
  // off, and no suggestion is made.
  await resetMock();
  await step('I3.3g', async () => {
    const r = await liveRoom(ctx, { interviewId: iv, leadId: WEN, answers: { recording: true, transcription: true, milo: false } });
    try {
      await inject(ctx, r.callId, [{ userId: WEN, text: 'Tell me about a time you led a team through a hard deadline.' }, { userId: r.guest.guestId, text: 'We split the team into two streams.' }]);
      const chip = (await r.leadPage.getByTestId('interview-consent').first().innerText().catch(() => '')).trim();
      const read = await api(r.lead, 'GET', sgPath);
      await sleep(20_000);
      const deck = await deckText(r.leadPage);
      const ok = chip === 'Milo off' && read.status === 200 && read.body?.suggestion === null && !/Milo suggests/.test(deck);
      return { ok, detail: `consent line "${chip}"; read ${read.status} suggestion ${JSON.stringify(read.body?.suggestion ?? null)}; deck after 20 s "${deck.slice(0, 40)}"` };
    } finally { await r.close(); }
  });
}
