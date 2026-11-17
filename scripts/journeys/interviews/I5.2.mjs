// Piece I5.2: Milo's recap (docs/interviews-tenant-plan.md row I5.2, decisions 6 and 14; hardening lane H4). It writes, so it puts
// the mock world back to its seeds first and again at the end.
//   I5.2a  before the end nobody reads a recap: the recruiter and the hiring manager are told not-found on a round not yet
//          held, and the page of a live round draws none
//   I5.2b  after the end, before anyone opens it, the recruiter and the hiring manager read "no recap yet"; once Wen has
//          opened it they read the evidence (a quote and a line on each statement, no ratings, no ask field, no tone); an
//          interviewer of another candidate's round is not found
//   I5.2c  Wen asks Milo where something was said and gets the lines it was said on; a second ask inside 20 seconds gets the
//          refusal line; after the wait a question that asks for a judgement gets the one fixed sentence
//   I5.2d  a panel member opens their own recap and asks (Kwame's round: two seats, no words kept)
//   I5.2e  the states: no transcript (the candidate declined it), none (Milo declined), paused (the budget; the page's rule with
//          the server's answer replaced), and a reviewed round answers the server's line to an ask
// plus the table I5.2.404 (the runner adds that step).
import { miloScoresIn, openBody, rateAllUI, ratingGroups, seen, squash, consentIn, tonesIn, why } from './h4-kit.mjs';

const GUEST_ASK = 'Where did they talk about the risky piece?';
const SECOND_ASK = 'Where did they talk about the deadline?';
const JUDGING_ASK = 'Is the candidate a strong hire?';
const FIXED = 'Milo can only find what was said in this interview and where it was said; it does not judge, rate or describe the candidate.';
const TOO_SOON = 'Milo needs a few seconds between questions. Ask again in a moment.';
const NO_LINES = 'Nothing was said in the transcript, so there is nothing to look through.';

export default async function run(ctx) {
  const { SEED, portal, record, signIn, api, resetMock, shootPage, startInterview, endInterview, mintInvite, guestSession, guestConsents, clock } = ctx;
  await resetMock();
  const I = SEED.interviews;
  const recapApi = (who, id) => api(who, 'GET', `/api/interviews/interviews/${id}/recap`);
  const askApi = (who, id, question) => api(who, 'POST', `/api/interviews/interviews/${id}/recap/ask`, { question });
  const widths = (shots) => shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ''}`).join(' ');

  const greta = await signIn(SEED.cast.recruiter);
  const amara = await signIn(SEED.cast.hiringManager);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const open = [greta, amara, hugo, wen];

  // ── I5.2a: nothing before the end ─────────────────────────────────────────────────────────────────────────────────────
  try {
    const answers = [];
    for (const [who, name] of [[greta, 'recruiter'], [amara, 'hiring manager']]) {
      for (const id of [I.mateoDesign, I.kwameLive]) answers.push([`${name} ${id}`, (await recapApi(who, id)).status]);
    }
    const p = await greta.newPage();
    await p.goto(`${portal}/interviews/rounds/${I.kwameLive}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(p, 'interviews-scorecard');
    await p.waitForTimeout(1500);
    const drawn = await p.getByTestId('interviews-recap').count();
    await p.close();
    record('I5.2a', answers.every(([, s]) => s === 404) && drawn === 0, `before the end: ${answers.map(([k, s]) => `${k}=${s}`).join(', ')}; the live round's page draws ${drawn} recap sections`);
  } catch (e) { record('I5.2a', false, `before the end: ${why(e)}`); }

  // ── I5.2b: after the end, none until opened, then the evidence ────────────────────────────────────────────────────────
  try {
    const states = [];
    for (const [who, name] of [[greta, 'recruiter'], [amara, 'hiring manager']]) {
      const r = await recapApi(who, I.jonahLeadership);
      states.push(`${name} ${r.status}/${r.body?.recap?.state}`);
      if (r.status !== 200 || r.body.recap.state !== 'none') throw new Error(`${name} before the open: ${r.status} ${r.body?.recap?.state}`);
    }
    const pageOf = async (who, name) => {
      const p = await who.newPage();
      await p.goto(`${portal}/interviews/rounds/${I.jonahLeadership}/scorecard`, { waitUntil: 'domcontentloaded' });
      await seen(p, 'interviews-recap-state');
      const line = squash(await p.getByTestId('interviews-recap-state').innerText());
      await p.close();
      return `${name}: "${line}"`;
    };
    const waiting = [await pageOf(greta, 'recruiter'), await pageOf(amara, 'hiring manager')];
    const opened = await api(wen, 'POST', `/api/interviews/interviews/${I.jonahLeadership}/recap/open`, await openBody(ctx, wen, I.jonahLeadership, 3));
    const outsider = await recapApi(hugo, I.jonahLeadership);
    const readers = [];
    for (const [who, name] of [[greta, 'recruiter'], [amara, 'hiring manager']]) {
      const p = await who.newPage();
      await p.goto(`${portal}/interviews/rounds/${I.jonahLeadership}/scorecard`, { waitUntil: 'domcontentloaded' });
      await seen(p, 'interviews-recap-competency');
      const claims = p.getByTestId('interviews-recap-claim');
      const n = await claims.count();
      for (let i = 0; i < n; i += 1) await claims.nth(i).click();
      const texts = [];
      for (let i = 0; i < n; i += 1) texts.push(squash(await claims.nth(i).innerText()));
      const section = p.getByTestId('interviews-recap');
      const text = squash(await section.innerText());
      readers.push({
        name, n, sourced: texts.every((t) => /Line \d+ of the transcript: “[^”]{3,}”/.test(t)), tones: await tonesIn(section), yourRating: /Your rating/.test(text),
        ask: await p.getByTestId('interviews-recap-ask').count(), field: await p.getByLabel('Your question for Milo').count(), scores: miloScoresIn(text), consent: consentIn(text),
      });
      if (name === 'recruiter') await shootPage(p, 'recap-reader');
      await p.close();
    }
    const ok = opened.status === 200 && opened.body?.recap?.state === 'ready' && outsider.status === 404
      && readers.every((r) => r.n >= 1 && r.sourced && r.tones === 0 && !r.yourRating && r.ask === 0 && r.field === 0 && !r.scores && !r.consent);
    record('I5.2b', ok, `before the open ${states.join(', ')} ("${waiting[0].slice(0, 70)}"); Wen opened it (${opened.status}/${opened.body?.recap?.state}); readers: ${readers.map((r) => `${r.name} ${r.n} statements sourced=${r.sourced} tones=${r.tones} ask fields=${r.field}`).join('; ')}; Hugo, not on this candidate: ${outsider.status}`);
  } catch (e) { record('I5.2b', false, `after the end: ${why(e)}`); }

  // ── I5.2c: Wen asks ───────────────────────────────────────────────────────────────────────────────────────────────────
  try {
    const p = await wen.newPage();
    await p.goto(`${portal}/interviews/rounds/${I.jonahLeadership}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(p, 'interviews-scorecard-form');
    await rateAllUI(p, 3);
    await p.getByTestId('interviews-scorecard-to-recap').click();
    await p.getByTestId('interviews-scorecard-ask-option-open').click();
    await seen(p, 'interviews-scorecard-recap-step');
    const ask = async (question) => {
      const field = p.getByLabel('Your question for Milo');
      await field.fill(question);
      await field.press('Enter');
      await p.getByTestId('interviews-recap-ask-answer').first().getByText(question, { exact: true }).waitFor({ timeout: 20_000 });
      return squash(await p.getByTestId('interviews-recap-ask-answer').first().innerText());
    };
    const first = await ask(GUEST_ASK);
    const second = await ask(SECOND_ASK);
    const lines = (await api(wen, 'GET', `/api/interviews/interviews/${I.jonahLeadership}/record`)).body?.record?.transcript?.lines ?? [];
    const cited = [...first.matchAll(/Line (\d+)/g)].map((m) => Number(m[1]));
    const citedOk = cited.length >= 1 && cited.every((n) => lines.find((l) => l.seq === n)?.side === 'candidate') && cited.some((n) => /risky/i.test(lines.find((l) => l.seq === n)?.text ?? ''));
    await clock.advance(25_000);
    const judged = await ask(JUDGING_ASK);
    const shots = await shootPage(p, 'recap-ask');
    const all = squash(await p.getByTestId('interviews-recap-ask').innerText());
    const ok = citedOk && second.includes(TOO_SOON) && judged.includes(FIXED) && !miloScoresIn(all) && !/strong hire|should (we )?hire/i.test(judged.replace(JUDGING_ASK, '')) && shots.every((s) => s.ok);
    record('I5.2c', ok, `first ask quotes lines ${cited.join(', ')} (candidate's, one holds "risky"); a second inside 20 s: "${second.replace(SECOND_ASK, '').trim().slice(0, 70)}"; after the wait a judgement question: "${judged.replace(JUDGING_ASK, '').trim().slice(0, 50)}…"; ${widths(shots)}`);
    await p.close();
  } catch (e) { record('I5.2c', false, `ask: ${why(e)}`); }

  // ── I5.2d: a panel member opens their own and asks ────────────────────────────────────────────────────────────────────
  try {
    const ended = await endInterview(hugo, I.kwameLive);
    const refusedBefore = await askApi(wen, I.kwameLive, GUEST_ASK);
    const p = await wen.newPage();
    await p.goto(`${portal}/interviews/rounds/${I.kwameLive}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(p, 'interviews-scorecard-form');
    await rateAllUI(p, 3);
    await p.getByTestId('interviews-scorecard-to-recap').click();
    await p.getByTestId('interviews-scorecard-ask-option-open').click();
    await seen(p, 'interviews-scorecard-recap-step');
    const state = squash(await p.getByTestId('interviews-recap-state').innerText());
    const field = p.getByLabel('Your question for Milo');
    await field.fill(GUEST_ASK);
    await field.press('Enter');
    await p.getByTestId('interviews-recap-ask-answer').first().getByText(GUEST_ASK, { exact: true }).waitFor({ timeout: 20_000 });
    const answer = squash(await p.getByTestId('interviews-recap-ask-answer').first().innerText());
    const hugoOwn = await recapApi(hugo, I.kwameLive);
    await p.close();
    record('I5.2d', ended.status === 200 && refusedBefore.status === 404 && /without a transcript/.test(state) && answer.includes(NO_LINES) && hugoOwn.status === 404,
      `the panel member's ask before opening: ${refusedBefore.status}; after opening her own: "${state.slice(0, 60)}…" and her ask is answered "${NO_LINES.slice(0, 40)}…"; the lead has not opened his: ${hugoOwn.status}`);
  } catch (e) { record('I5.2d', false, `panel member: ${why(e)}`); }

  // ── I5.2e: the states ─────────────────────────────────────────────────────────────────────────────────────────────────
  /** A round held start to end with the candidate's answers given first (the API-only candidate), as its lead. */
  const hold = async (lead, id, answers) => {
    const invite = await mintInvite(greta, id);
    if (invite.status !== 201) throw new Error(`the link for ${id}: ${invite.status}`);
    const guest = await guestSession(invite.token);
    const put = await guestConsents(guest.context, answers);
    await guest.context.close();
    if (put.status !== 200) throw new Error(`the answers for ${id}: ${put.status}`);
    const started = await startInterview(lead, id);
    const ended = await endInterview(lead, id);
    if (started.status !== 200 || ended.status !== 200) throw new Error(`holding ${id}: ${started.status}/${ended.status}`);
  };
  /** Open the recap from the scorecard page as `who`: rate, continue, and read what the recap step says. */
  const recapStepOf = async (who, id, shape) => {
    const p = await who.newPage();
    try {
      if (shape) await p.route('**/recap/open', async (route) => { const res = await route.fetch(); await route.fulfill({ response: res, json: shape }); });
      await p.goto(`${portal}/interviews/rounds/${id}/scorecard`, { waitUntil: 'domcontentloaded' });
      await seen(p, 'interviews-scorecard-form');
      await rateAllUI(p, 3);
      await p.getByTestId('interviews-scorecard-to-recap').click();
      await p.getByTestId('interviews-scorecard-ask-option-open').click();
      await seen(p, 'interviews-recap-state');
      return squash(await p.getByTestId('interviews-recap-state').innerText());
    } finally { await p.close(); }
  };
  try {
    await hold(wen, I.aikoCoding, { recording: true, transcription: false, milo: false });
    await hold(hugo, I.nadiaDesign, { recording: true, transcription: true, milo: false });
    const noTranscript = await recapStepOf(wen, I.aikoCoding);
    const none = await recapStepOf(hugo, I.nadiaDesign);
    const readerStates = [(await recapApi(greta, I.aikoCoding)).body?.recap?.state, (await recapApi(greta, I.nadiaDesign)).body?.recap?.state];
    // The budget: the server's answer to an open is replaced, as a refused hold would answer it (the mock cannot set a cap below one recap's cost).
    await hold(hugo, I.mateoDesign, { recording: true, transcription: true, milo: true });
    const paused = await recapStepOf(hugo, I.mateoDesign, { recap: { state: 'paused', paused: 'budget', writtenAt: null, competencies: [], notCovered: [] } });
    // A reviewed round: the debrief's decision marks Ingrid's rounds reviewed; the server's answer to an ask is its not-found line.
    const amaraDecide = await api(amara, 'POST', `/api/interviews/applications/${SEED.applications.ingrid}/stage`, {
      decision: 'hold', reason: 'Waiting on the second team before an offer is made.',
      basedOn: (await api(amara, 'GET', `/api/interviews/candidates/${SEED.candidates.ingrid}/debrief`)).body.debrief.applications[0].basedOn,
    });
    const reviewedAsk = await askApi(hugo, I.ingridCoding, GUEST_ASK);
    const ok = /ran without a transcript/.test(noTranscript) && /Milo could not write a recap for this interview/.test(none) && readerStates[0] === 'no-transcript' && readerStates[1] === 'none'
      && /interview budget is used up/.test(paused) && amaraDecide.status === 201 && reviewedAsk.status === 404 && /no recap here that you can open/i.test(reviewedAsk.body?.error ?? '');
    record('I5.2e', ok, `no transcript "${noTranscript.slice(0, 50)}…" (readers: ${readerStates[0]}); none "${none.slice(0, 45)}…" (readers: ${readerStates[1]}); paused "${paused.slice(0, 40)}…"; a reviewed round's ask: ${reviewedAsk.status} "${reviewedAsk.body?.error ?? ''}"`);
  } catch (e) { record('I5.2e', false, `states: ${why(e)}`); }

  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
