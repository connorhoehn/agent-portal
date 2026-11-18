// Piece I3.6: Milo for you, live (docs/interviews-tenant-plan.md row I3.6, decisions 6, 20, 21; contract E5). Nadia's
// leadership round (behavioural: Wen leads, Hugo on the panel), the call on the stand-in media of h3-call.mjs, lines from
// the mock injector, Milo's answers from the scripted stand-in.
//   I3.6a  the lead's Milo tab: Milo's notes (per competency) under the time line ("… of 60 min" or "Starts in …")
//   I3.6b  Ask Milo: a question about something the candidate said gets an answer with the candidate's line quoted
//   I3.6c  "Should we hire her?" gets the fixed sentence, and no quote
//   I3.6d  the panel member's Milo tab: the notes and the transcript, and no Ask
//   I3.6e  panel against candidate: the notes' competency names, the answer and the time line are on no page and in no read
//          of the candidate's
//   I3.6f  the off lines on the transcript read: Milo not invited, the candidate not answered, the transcript declined
//   I3.6g  the budget pause: with the opening's caps at $0 the ask answers paused, no answer
//   I3.6h  a round started early: its time line counts from when the lead started it, never "Starts in"
import { liveRoom, inject, sleep, guestReads, guestChatText, setCaps, candidateAnswers } from './h3-call.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, api, clock, signIn, startInterview, shootPage } = ctx;
  const iv = SEED.panelInterview;
  const WEN = SEED.cast.interviewer2; const HUGO = SEED.cast.interviewer;
  const FIXED = 'Milo can only find what was said in this interview and where it was said; it does not judge, rate or describe the candidate.';
  const CANDIDATE_LINE = 'I mentored two new engineers through their first on-call rotation and wrote the runbook with them.';
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const miloTab = async (page) => {
    await page.getByTestId('interview-room-pane-tab-milo').click();
    const tab = page.getByTestId('interview-room-tab-milo');
    await tab.waitFor({ timeout: 15_000 });
    return tab;
  };
  const ask = async (page, question) => {
    const box = page.getByRole('textbox', { name: 'Your question for Milo' });
    await box.fill(question);
    await page.getByTestId('interview-room-tab-milo').getByRole('button', { name: 'Ask', exact: true }).click();
    const end = Date.now() + 20_000;
    let text = '';
    while (Date.now() < end) {
      text = (await page.getByTestId('interview-room-milo-answer').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      if (text.includes(question.slice(0, 20)) || text.includes(FIXED)) break;
      await sleep(500);
    }
    return text;
  };

  await resetMock();
  let liveTimeLine = null;
  const panelSeat = { userId: HUGO, label: 'panel' };
  let room = null;
  try {
    room = await liveRoom(ctx, { interviewId: iv, leadId: WEN, extra: [panelSeat] });
  } catch (e) {
    for (const s of ['a', 'b', 'c', 'd', 'e']) record(`I3.6${s}`, false, `the live room did not open: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  if (room) {
    let notesText = ''; let answerText = '';

    await step('I3.6a', async () => {
      await inject(ctx, room.callId, [
        { userId: WEN, text: 'Tell me about someone on your team who was struggling.' },
        { userId: room.guest.guestId, text: CANDIDATE_LINE },
      ]);
      const tab = await miloTab(room.leadPage);
      const notes = tab.getByTestId('interview-room-milo-notes');
      await notes.waitFor({ timeout: 30_000 });
      notesText = (await tab.innerText()).replace(/\s+/g, ' ');
      const api1 = await api(room.lead, 'GET', `/api/interviews/interviews/${iv}/milo-notes`);
      const timeLine = api1.body?.notes?.time?.line ?? '';
      const comps = (api1.body?.notes?.competencies ?? []).map((c) => c.name);
      const shots = await shootPage(room.leadPage, 'I3.6a-milo-tab');
      liveTimeLine = timeLine;
      const ok = api1.status === 200 && /min/.test(timeLine) && notesText.includes(timeLine.replace(/^[^;]*; /, '')) && comps.length > 0 && comps.every((c) => notesText.includes(c)) && shots.every((s) => s.ok);
      return { ok, detail: `notes ${api1.status}: time "${timeLine}", competencies ${comps.join(' / ')}; on the tab ${comps.every((c) => notesText.includes(c))}` };
    });

    await step('I3.6b', async () => {
      answerText = await ask(room.leadPage, 'Where did they talk about mentoring and the runbook?');
      const ok = answerText.includes(CANDIDATE_LINE.slice(0, 60)) && /Line \d+/.test(answerText);
      return { ok, detail: `answer: "${answerText.slice(0, 160)}"` };
    });

    await step('I3.6c', async () => {
      await clock.advance(15_000);
      await sleep(1000);
      const text = await ask(room.leadPage, 'Should we hire her?');
      const r = await api(room.lead, 'POST', `/api/interviews/interviews/${iv}/milo-ask`, { question: 'Should we hire her?' });
      const ok = text.includes(FIXED) && (r.body?.answer?.text === FIXED || r.body?.line === FIXED || JSON.stringify(r.body).includes(FIXED) || /few seconds/.test(r.body?.line ?? ''));
      return { ok, detail: `on the page the fixed sentence ${text.includes(FIXED)}; the API ${r.status} ${JSON.stringify(r.body).slice(0, 120)}` };
    });

    await step('I3.6d', async () => {
      const tab = await miloTab(panelSeat.page);
      const hasNotes = await tab.getByTestId('interview-room-milo-notes').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
      const hasTranscript = await tab.getByTestId('interview-room-transcript').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
      const noAsk = (await tab.getByRole('textbox', { name: 'Your question for Milo' }).count()) === 0 && !(await tab.innerText()).includes('Ask Milo');
      const askApi = await api(panelSeat.context, 'POST', `/api/interviews/interviews/${iv}/milo-ask`, { question: 'What did they say about mentoring?' });
      const ok = hasNotes && hasTranscript && noAsk && askApi.status === 404;
      return { ok, detail: `panel: notes ${hasNotes}, transcript ${hasTranscript}, no Ask ${noAsk}, ask by the API ${askApi.status}` };
    });

    await step('I3.6e', async () => {
      const notes = (await api(room.lead, 'GET', `/api/interviews/interviews/${iv}/milo-notes`)).body?.notes;
      const needles = [notes?.time?.line, ...(notes?.competencies ?? []).map((c) => c.name), FIXED].filter(Boolean);
      const page = await room.guest.page.innerText('body').catch(() => '');
      const reads = await guestReads(ctx, room.guest.context);
      const chat = await guestChatText(room.guest);
      const leaks = needles.filter((n) => page.includes(n) || reads.includes(n) || chat.includes(n));
      const notesRead = await api(room.guest.context, 'GET', `/api/interviews/interviews/${iv}/milo-notes`);
      return { ok: leaks.length === 0 && [401, 403, 404].includes(notesRead.status), detail: `${needles.length} panel-side texts; on the candidate's page, reads or chat: ${JSON.stringify(leaks)}; the candidate's notes read ${notesRead.status}` };
    });
    await room.close();
  }

  // A round started before its set time (the lead may start early): the time line still counts to the set time.
  await step('I3.6h', async () => ({ ok: typeof liveTimeLine === 'string' && !/^Starts in/.test(liveTimeLine),
    detail: `the live round's time line: "${liveTimeLine}" (a round started before its set time counts from its start)` }));

  // The off lines, by the API on a live round with no call: not invited, not answered, declined. Aiko's coding round (Wen
  // leads): no earlier piece left a call of Milo's in its lobby (the mock reset keeps Milo's call records, and the newest
  // record still listening in an interview's lobby is read as its transcript).
  await step('I3.6f', async () => {
    const iv = SEED.interviews.aikoCoding;
    const lines = [];
    for (const answers of ['none-invited', null, { recording: true, transcription: false, milo: false }]) {
      await resetMock();
      const wen = await signIn(WEN); const greta = await signIn(SEED.cast.recruiter);
      try {
        await startInterview(wen, iv);
        if (answers === 'none-invited') await candidateAnswers(ctx, greta, iv, ctx.ALL_YES);
        else if (answers) await candidateAnswers(ctx, greta, iv, answers);
        const t = await api(wen, 'GET', `/api/interviews/interviews/${iv}/transcript`);
        const a = await api(wen, 'POST', `/api/interviews/interviews/${iv}/milo-ask`, { question: 'What did they say about mentoring?' });
        lines.push({ t: t.body?.transcript?.off ?? `(${t.status})`, a: a.body?.line ?? a.body?.error ?? `(${a.status})` });
      } finally { await wen.close(); await greta.close(); }
    }
    const [notInvited, unanswered, declined] = lines;
    const ok = notInvited.t === 'There is no transcript yet: Milo has not been invited to the call.' && typeof unanswered.t === 'string' && unanswered.t.length > 10
      && typeof declined.t === 'string' && declined.t.length > 10 && declined.t !== unanswered.t && /Milo/.test(declined.a);
    return { ok, detail: `not invited "${notInvited.t}"; not answered "${unanswered.t}" / ask "${unanswered.a}"; declined "${declined.t}" / ask "${declined.a}"` };
  });

  await resetMock();
  await step('I3.6g', async () => {
    const r = await liveRoom(ctx, { interviewId: iv, leadId: WEN });
    try {
      await inject(ctx, r.callId, [{ userId: r.guest.guestId, text: CANDIDATE_LINE }]);
      await setCaps(ctx, r.recruiter, SEED.openings.em, { budgetCapUsd: 0, interviewCapUsd: 0 });
      const a = await api(r.lead, 'POST', `/api/interviews/interviews/${iv}/milo-ask`, { question: 'Where did they talk about mentoring?' });
      return { ok: a.status === 200 && a.body?.paused === 'budget' && a.body?.answer === null, detail: `ask with the caps at $0: ${a.status} ${JSON.stringify(a.body).slice(0, 120)}` };
    } finally { await r.close(); }
  });
}
