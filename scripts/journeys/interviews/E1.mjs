// Piece E1: the whole journey in one pass (docs/interviews-tenant-plan.md row E1; OWED O-282), technical round then
// behavioural round, as the real roles through the pages, each in a browser context of their own. It is a story: each step
// starts from where the one before left the world, so after the first red step the rest are recorded red as "not reached"
// (a cascade of timeouts would say nothing more). It writes, so it puts the mock world back to its seeds first and last.
// The call's media is stood in (lib.mjs standInCall: no real video; the live tiles were proven on the social profile
// separately); seats, the gateway's pad and chat, Milo's record and the scripted coach are real. Nothing is executed (runs go
// to the mock executor) and no model is called (the scripted stand-ins).
//   E1a  Greta adds a candidate for Senior Backend Engineer: the profile opens at the first stage
//   E1b  Greta assigns the Coding round from the profile, Hugo leads: the round is assigned to him
//   E1c  Hugo accepts from My interviews: the panel's notice is shown once (he holds an earlier version), the round is accepted
//   E1d  Hugo prepares: Milo drafts a plan, he uses it and saves it; a reload holds it (the walk's lines then ask its first
//        question aloud, which is what the recap and Milo's notes read as a question asked)
//   E1e  Greta sets the time on Upcoming and makes the invite link (shown once)
//   E1f  Hugo opens the room from Prepare and joins the call from the footer: the interview is live; the Questions tab holds
//        his plan
//   E1g  the candidate opens the link (no account): the token leaves the address; the three answers (yes), the device check,
//        the waiting room
//   E1h  Hugo admits from the footer's prompt; the candidate joins the call; the candidate's pane has Pad and Chat
//   E1i  both type in the pad: each sees the other's lines
//   E1j  the candidate presses Run: both panes show the same run (the printed line, Finished), "Run by you" and "Candidate"
//   E1k  Hugo invites Milo and turns its voice on from the footer; lines are heard; Milo's suggestion arrives; "Have Milo
//        ask": the receipt, the question on the candidate's side (their Milo line and their chat), and none of the deck's words
//   E1l  the candidate asks how much time is left: the fixed sentence, on their side and in the lead's chat
//   E1m  Hugo ends the interview: he lands on its scorecard; the candidate reads the ended page; the round is ended
//   E1n  Hugo's scorecard: ratings, Milo's recap (every statement sourced), one question to Milo (the answer cites a line),
//        a recommendation, submitted
//   E1o  the record on one clock: the run marker and Milo's question marker each move the code and the time together (the code
//        is the pad's snapshot of that moment; the run's output under it), and a transcript line moves the clock and the code
//   E1p  Greta assigns the behavioural round (Working together, Wen leads); Wen accepts without the notice (she holds the
//        current one) and prepares with a plan from Milo; Greta sets its time and makes its link
//   E1q  the behavioural call: Wen joins, the candidate answers, is admitted and joins; no pad on either side (Plan, Milo,
//        Chat for Wen); Milo is invited, lines heard, Milo's notes name the round's competencies; the candidate's page shows
//        none of them
//   E1r  Wen ends; her scorecard with the recap, submitted
//   E1s  Amara (hiring manager) on My openings: the candidate's Last result opens the debrief, both rounds' scorecards side
//        by side, the decision hers
//   E1t  Amara advances to an offer with a reason: the stage is Offer and the profile's history says so under her name. Red
//        today with a FINDING: an added candidate never leaves "applied", so no decision is offered (see the step)
import { standInCall, PREJOIN_KEYS } from './lib.mjs';
import { joinCall, chooseLanguage, synced, typeInPad, padText, outputText, until, why, chatText, padTab, suggestion, catchText, letSound } from './h8-room.mjs';
import { guestJoinCall, watchCallId } from './h3-call.mjs';
import { rateAllUI, openRecapStep, submitFromRecap, seen, squash, msOfClock, miloScoresIn, consentIn } from './h4-kit.mjs';

const SFU = 'http://interviews-e1.test';
const NAME = 'Sunniva Arkwright';
const EMAIL = 'sunniva.arkwright@example.com';
const OPENING = 'Senior Backend Engineer';
const CODING = 'Coding';
const TOGETHER = 'Working together';
const DECK = 'collection-command-composer-prompts';
const TIME_LINE = /^(About \d+ minutes? (are|is) left in this round\.|This round is \d+ minutes long\.|This round is at the end of its time\.)$/;
const CANDIDATE_CODE = '\n// walk the list once and keep the top two\nconsole.log("top two of [3, 9, 4, 9]: 9 and 9")';
const LEAD_NOTE = '\n// lead: and a list with one item?';
const RECAP_QUESTION = 'Where did they talk about duplicates?';
const REASON = 'Both rounds showed clear reasoning and ownership; the panel agrees.';
const pad2 = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

export default async function run(ctx) {
  const { SEED, portal, record, signIn, api, guestApi, resetMock, shootPage, readInterview, browser } = ctx;
  const STEPS = 'abcdefghijklmnopqrst'.split('').map((l) => `E1${l}`);
  let stoppedAt = null;
  const done = new Set();
  /** One step of the story: fn → { ok, detail } or throws. After a red step the rest are recorded "not reached". */
  const step = async (id, fn) => {
    if (stoppedAt) { record(id, false, `not reached: ${stoppedAt} was red`); done.add(id); return; }
    let r;
    try { r = await fn(); } catch (e) { r = { ok: false, detail: why(e) }; }
    record(id, !!r.ok, r.detail);
    done.add(id);
    if (!r.ok) stoppedAt = id;
  };
  const widths = (shots) => shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ''}`).join(' ');
  const S = {};
  const open = [];
  const calls = [];

  await resetMock();
  const staff = async (who) => {
    const c = await signIn(SEED.cast[who]);
    await standInCall(c, { sfu: SFU, label: who, tokenRoute: '**/api/session/realtime-token', prejoinKey: PREJOIN_KEYS.panel, sessionId: 'interviews-e1-signalling-only' });
    open.push(c);
    return c;
  };
  const greta = await staff('recruiter');
  const hugo = await staff('interviewer');
  const wen = await staff('interviewer2');
  const amara = await staff('hiringManager');
  const gp = await greta.newPage();
  const pick = async (page, testId, name) => { await page.getByTestId(testId).click(); await page.getByRole('option', { name }).first().click(); };
  const roundOf = async (roundName) => (await api(greta, 'GET', '/api/interviews/interviews')).body?.items?.find((i) => i.candidate?.id === S.candidateId && i.round?.name === roundName) ?? null;

  /** Greta, on Upcoming: set the round's time a few minutes ahead, then make its link (captured as the page receives it). → linkPath */
  const timeAndLink = async (interviewId) => {
    await gp.goto(`${portal}/interviews/upcoming`, { waitUntil: 'domcontentloaded' });
    const table = gp.getByTestId('interviews-upcoming-table');
    await table.getByText(NAME, { exact: true }).first().waitFor({ timeout: 30_000 });
    const row = table.locator('tbody tr', { hasText: NAME }).first();
    await row.getByTestId('interviews-upcoming-actions').click();
    await gp.getByRole('menuitem', { name: /Set the time/ }).click();
    const at = new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000);
    await gp.getByTestId('interviews-upcoming-time-field-input').fill(localInput(at));
    const deck = gp.getByTestId(DECK);
    await deck.getByText(/Set the time to/).waitFor({ timeout: 15_000 });
    await deck.getByRole('button', { name: /Confirm/ }).click();
    await row.getByTestId('interviews-upcoming-saved').waitFor({ timeout: 30_000 });
    const timed = await readInterview(greta, interviewId);
    await row.getByTestId('interviews-upcoming-actions').click();
    const made = gp.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/interviews/interviews/${interviewId}/invite`, { timeout: 20_000 });
    await gp.getByRole('menuitem', { name: /Make the invite link/ }).click();
    const res = await made;
    const linkPath = (await res.json().catch(() => ({})))?.linkPath ?? null;
    await row.getByTestId('interviews-upcoming-link-once').waitFor({ timeout: 15_000 });
    const once = squash(await row.getByTestId('interviews-upcoming-link-once').innerText());
    return { linkPath, status: res.status(), scheduledAt: timed?.scheduledAt ?? null, once, at };
  };

  /** The lead's room, its call joined from the footer; the call id from the page's wire, or the interview's own. */
  const leadJoins = async (page, interviewId) => {
    const callIdOf = watchCallId(page);
    await page.getByTestId('interview-room').first().waitFor({ timeout: 40_000 });
    await joinCall(page);
    const live = await until(async () => ((await readInterview(page.context(), interviewId))?.state === 'live' ? true : null), 20_000, 1000);
    return { live: !!live, callIdOf };
  };

  /** The candidate on their link, in a context with no account: → { context, page, step, tokenGone }. */
  const candidateArrives = async (linkPath) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
    open.push(context);
    await standInCall(context, { sfu: SFU, label: 'candidate', tokenRoute: '**/api/interview-invite/realtime-token', prejoinKey: PREJOIN_KEYS.guest, sessionId: 'interviews-e1-signalling-only' });
    const page = await context.newPage();
    await page.goto(`${portal}${linkPath}`, { waitUntil: 'domcontentloaded' });
    const seenId = (id) => page.getByTestId(id).first().waitFor({ timeout: 30_000 }).then(() => id);
    const first = await Promise.any(['join-interview', 'join-consents', 'join-devices', 'join-waiting', 'join-room', 'join-dead'].map(seenId)).catch(() => null);
    const tokenGone = !new URL(page.url()).hash;
    const landing = first === 'join-interview' ? await shootPage(page, 'E1-candidate-landing') : null;
    let at = null;
    if (first === 'join-interview' || first === 'join-consents') at = await ctx.toWaiting(page, ctx.ALL_YES);
    else if (first === 'join-devices') {
      await page.getByTestId('join-devices-continue').click();
      at = await Promise.any(['join-waiting', 'join-room', 'join-held'].map(seenId)).then((id) => id.replace('join-', '')).catch(() => null);
    } else at = first ? first.replace('join-', '') : null;
    return { context, page, first, step: at, tokenGone, landing };
  };

  /** The lead answers the knock from the footer's prompt: Admit. Then the candidate joins the call from their bar. */
  const admitAndJoin = async (leadPage, guest) => {
    const admitBtn = leadPage.getByTestId('interview-room-ask').getByRole('button', { name: /^Admit$/ });
    await admitBtn.first().waitFor({ timeout: 30_000 });
    await leadPage.waitForTimeout(300);
    await admitBtn.first().click();
    await guest.page.getByTestId('join-room').first().waitFor({ timeout: 30_000 });
    await guestJoinCall(guest);
    await guest.page.getByTestId('join-room-pane').first().waitFor({ timeout: 30_000 });
    const self = (await guestApi(guest.context, 'GET', '/room')).body?.room?.self?.userId ?? null;
    return self;
  };

  /** The lead invites Milo from the footer (past the budget ask); → true once Milo is listening. */
  const inviteMilo = async (leadPage, leadContext, callId) => {
    await leadPage.getByTestId('assistant-invite').first().click({ timeout: 15_000 });
    await leadPage.getByTestId('assistant-budget-ask').getByRole('button', { name: /go ahead/i }).click({ timeout: 4000 }).catch(() => undefined);
    calls.push({ context: leadContext, callId });
    return !!(await until(async () => ((await api(leadContext, 'GET', `/api/calls/${encodeURIComponent(callId)}/assistant/state`)).body?.state === 'listening' ? true : null), 25_000, 1000));
  };
  const hear = (context, callId, userId, text) => api(context, 'POST', `/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, { userId, text });
  const paneTabs = async (page, paneId) => (await page.getByTestId(paneId).first().getByRole('tab').allInnerTexts()).map((t) => t.trim().split('\n')[0].trim()).filter(Boolean);

  /** The interviewer's My interviews → To accept → Accept on the candidate's row. → { noticeAsked, noticeChars } */
  const accept = async (context, expectNotice) => {
    const p = await context.newPage();
    await p.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('interviews-my-interviews-table').waitFor({ timeout: 30_000 });
    await p.getByTestId('interviews-desk-tab-to-accept').click();
    const row = p.getByTestId('interviews-my-interviews-table').locator('tr', { hasText: NAME }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.getByTestId('interviews-desk-accept').click();
    let noticeAsked = 0; let noticeChars = 0;
    if (expectNotice) {
      const fold = p.getByText('Read the notice', { exact: true });
      await fold.waitFor({ timeout: 30_000 });
      noticeAsked = await fold.count();
      await fold.click();
      noticeChars = (await p.getByTestId('interviews-panel-notice-text').innerText()).length;
      await p.getByRole('button', { name: /I have read it — accept/ }).click();
    }
    await row.waitFor({ state: 'detached', timeout: 30_000 });
    if (!expectNotice) noticeAsked = (await p.getByText('Read the notice', { exact: true }).count()) + (await p.getByText('I have read it — accept').count());
    await p.close();
    return { noticeAsked, noticeChars };
  };

  /** The lead on Prepare: "Ask Milo for a plan", Use this plan, Save plan; a reload holds it. → { ok, detail, plan } */
  const prepareWithMilo = async (page, interviewId, shot) => {
    await page.goto(`${portal}/interviews/rounds/${interviewId}/prepare`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-prepare').waitFor({ timeout: 30_000 });
    await page.getByTestId('interviews-draft-ask').click();
    await page.getByTestId('interviews-draft-prompt').first().waitFor({ timeout: 30_000 });
    const drafted = (await page.getByTestId('interviews-draft-prompt').allInnerTexts()).map((t) => t.trim());
    await page.getByTestId('interviews-draft-use').click();
    await page.getByTestId('interviews-plan-save').click();
    // The save's note can go with the refresh that follows it; "Everything here is saved." or the problem is what stays.
    const after = await until(async () => {
      const problem = await page.getByTestId('interviews-plan-problem').first().innerText({ timeout: 300 }).catch(() => '');
      if (problem) return { problem };
      return (await page.getByText('Everything here is saved.').count()) ? { saved: true } : null;
    }, 15_000, 300);
    if (!after?.saved) return { ok: false, plan: [], detail: `Save plan: ${after?.problem ? `the page says "${after.problem}"` : 'neither saved nor a problem within 15 s'}` };
    const shots = await shootPage(page, shot);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-plan-table').waitFor({ timeout: 30_000 });
    const plan = (await page.getByTestId('interviews-plan-prompt').allInnerTexts()).map((t) => t.trim());
    const same = drafted.length > 0 && plan.length === drafted.length && drafted.every((d, i) => plan[i] === d);
    return { ok: same && shots.every((x) => x.ok), plan, detail: `Milo drafted ${drafted.length} ("${(drafted[0] ?? '').slice(0, 50)}…"); after a reload the plan holds ${plan.length} in the same order ${same}; ${widths(shots)}` };
  };

  /** Rate, the recap step (every statement sourced), optionally one question to Milo, then a recommendation and Submit. */
  const scorecard = async (context, interviewId, { question, summary, shot }) => {
    const p = await context.newPage();
    await p.goto(`${portal}/interviews/rounds/${interviewId}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(p, 'interviews-scorecard-form');
    const rated = await rateAllUI(p, 3);
    await openRecapStep(p);
    await seen(p, 'interviews-recap-competency', 60_000);
    const claims = p.getByTestId('interviews-recap-claim');
    const n = await claims.count();
    for (let i = 0; i < n; i += 1) await claims.nth(i).click();
    const texts = [];
    for (let i = 0; i < n; i += 1) texts.push(squash(await claims.nth(i).innerText()));
    const sourced = n >= 1 && texts.every((t) => /Line \d+ of the transcript: “[^”]{3,}”/.test(t));
    const recapText = squash(await p.getByTestId('interviews-recap').innerText());
    let answer = '';
    if (question) {
      const field = p.getByLabel('Your question for Milo');
      await field.fill(question);
      await field.press('Enter');
      await p.getByTestId('interviews-recap-ask-answer').first().getByText(question, { exact: true }).waitFor({ timeout: 30_000 });
      answer = (await until(async () => { const t = squash(await p.getByTestId('interviews-recap-ask-answer').first().innerText()); return t.replace(question, '').trim().length > 10 ? t : null; }, 20_000, 500)) ?? '';
    }
    const shots = await shootPage(p, shot);
    await submitFromRecap(p, { recommendation: 'Yes', summary });
    const mine = squash(await p.getByTestId('interviews-scorecard-mine').innerText());
    await p.close();
    return { rated, n, sourced, answer, recapText, mine, shots };
  };

  try {
    // ── the technical round ────────────────────────────────────────────────────────────────────────────────────────
    await step('E1a', async () => {
      await gp.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
      await gp.getByTestId('interviews-add-candidate').first().click({ timeout: 30_000 });
      await gp.getByTestId('interviews-new-candidate-form').waitFor({ timeout: 30_000 });
      await gp.getByTestId('interviews-candidate-name').fill(NAME);
      await gp.getByTestId('interviews-candidate-email').fill(EMAIL);
      await pick(gp, 'interviews-candidate-opening', new RegExp(OPENING));
      const shots = await shootPage(gp, 'E1-add-candidate');
      await gp.getByTestId('interviews-new-candidate-create').click();
      const deck = gp.getByTestId(DECK);
      await deck.getByText(/Add .* as a candidate/).waitFor({ timeout: 15_000 });
      await deck.getByRole('button', { name: /Add candidate/ }).first().click();
      await gp.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
      S.candidateId = decodeURIComponent(new URL(gp.url()).pathname.split('/').pop());
      const row = ((await api(greta, 'GET', '/api/interviews/candidates')).body?.items ?? []).find((r) => r.candidate?.name === NAME);
      // The candidate's name is the page's title (E4 #5), above the profile's sections.
      const header = squash(await gp.getByRole('heading', { level: 1 }).first().innerText());
      return { ok: !!row && row.candidate?.id === S.candidateId && row.stage === 'applied' && header.includes(NAME) && shots.every((s) => s.ok),
        detail: `the profile opened for ${NAME}; the list row is at stage ${row?.stage}; the form ${widths(shots)}` };
    });

    await step('E1b', async () => {
      await gp.getByTestId('interviews-profile-assign').first().click({ timeout: 15_000 });
      await gp.getByTestId('interviews-assign-form').waitFor({ timeout: 30_000 });
      await pick(gp, 'interviews-assign-round', new RegExp(`^${CODING}, `));
      await pick(gp, 'interviews-assign-lead', SEED.names[SEED.cast.interviewer]);
      await gp.getByTestId('interviews-assign-submit').click();
      await gp.getByTestId('interviews-profile-rounds').waitFor({ timeout: 30_000 });
      const r = await until(() => roundOf(CODING), 10_000, 500);
      S.tech = r?.id ?? null;
      const shots = await shootPage(gp, 'E1-profile-assigned');
      return { ok: !!r && r.state === 'assigned' && r.lead?.id === SEED.cast.interviewer && r.round?.type === 'technical',
        detail: `the ${CODING} round: ${r ? `${r.state}, ${r.round?.type}, lead ${r.lead?.name}` : 'not found'}; profile ${widths(shots)}` };
    });

    await step('E1c', async () => {
      const a = await accept(hugo, true);
      const r = await readInterview(hugo, S.tech);
      const again = (await api(hugo, 'GET', '/api/interviews/interviews/panel-notice')).body;
      return { ok: a.noticeAsked === 1 && a.noticeChars > 100 && r?.state === 'accepted' && again?.acknowledged === true,
        detail: `Accept asked the panel's notice ${a.noticeAsked} time (${a.noticeChars} characters); the round is ${r?.state}; Hugo now holds the current notice ${again?.acknowledged}` };
    });

    const hp = await hugo.newPage();
    await step('E1d', async () => {
      const r = await prepareWithMilo(hp, S.tech, 'E1-prepare-plan');
      S.plan = r.plan;
      return r;
    });

    await step('E1e', async () => {
      const l = await timeAndLink(S.tech);
      S.techLink = l.linkPath;
      const shots = await shootPage(gp, 'E1-upcoming-link');
      const ok = l.status === 201 && /^\/join#/.test(l.linkPath ?? '') && !!l.scheduledAt && Math.abs(Date.parse(l.scheduledAt) - l.at.getTime()) < 60_000 && /not shown again/.test(l.once);
      return { ok, detail: `the time is set (${l.scheduledAt ? 'on the round' : 'missing'}); the link answered ${l.status}, "${l.once}"; ${widths(shots)}` };
    });

    let tech = null;
    await step('E1f', async () => {
      await hp.goto(`${portal}/interviews/rounds/${S.tech}/prepare`, { waitUntil: 'domcontentloaded' });
      await hp.getByTestId('interviews-prepare-room').click({ timeout: 30_000 });
      await hp.waitForURL(new RegExp(`/interviews/rounds/${S.tech}/room$`), { timeout: 20_000 });
      tech = await leadJoins(hp, S.tech);
      await hp.getByTestId('interview-room-pane').getByRole('tab', { name: /questions/i }).click({ timeout: 10_000 });
      const planText = squash(await hp.getByTestId('interview-room-plan').first().innerText({ timeout: 10_000 }));
      const inRoom = S.plan.every((q) => planText.includes(squash(q).slice(0, 40)));
      const tabs = await paneTabs(hp, 'interview-room-pane');
      await padTab(hp);
      return { ok: tech.live && inRoom && ['Pad', 'Questions', 'Milo', 'Chat'].every((t) => tabs.some((x) => x.startsWith(t))),
        detail: `Hugo joined from the footer: the interview is ${tech.live ? 'live' : 'NOT live'}; the pane's tabs ${JSON.stringify(tabs)}; the Questions tab holds the ${S.plan.length} planned questions ${inRoom}` };
    });

    let C = null;
    await step('E1g', async () => {
      C = await candidateArrives(S.techLink);
      const shots = await shootPage(C.page, 'E1-candidate-waiting');
      return { ok: C.first === 'join-interview' && C.tokenGone && C.step === 'waiting' && (C.landing ?? []).every((s) => s.ok) && shots.every((s) => s.ok),
        detail: `the link landed on ${C.first}; the token left the address ${C.tokenGone}; after the three answers and the device check: ${C.step}; ${widths(shots)}` };
    });

    await step('E1h', async () => {
      S.guestId = await admitAndJoin(hp, C);
      const tabs = await paneTabs(C.page, 'join-room-pane');
      const shots = await shootPage(C.page, 'E1-candidate-in-call');
      const a = await api(hugo, 'GET', `/api/interviews/interviews/${S.tech}/waiting`);
      return { ok: !!S.guestId && tabs.some((t) => t.startsWith('Pad')) && tabs.some((t) => t.startsWith('Chat')) && a.body?.admission?.state === 'admitted' && shots.every((s) => s.ok),
        detail: `admitted from the footer (${a.body?.admission?.state}); the candidate joined the call; their pane's tabs ${JSON.stringify(tabs)}; ${widths(shots)}` };
    });

    await step('E1i', async () => {
      await padTab(hp); await padTab(C.page);
      if (!((await synced(hp)) && (await synced(C.page)))) return { ok: false, detail: 'the two pads did not come into sync' };
      await chooseLanguage(hp, 'JavaScript');
      await hp.waitForTimeout(800);
      await typeInPad(C.page, CANDIDATE_CODE);
      const leadSees = await until(async () => ((await padText(hp)) ?? '').includes('top two of [3, 9, 4, 9]'), 15_000);
      await typeInPad(hp, LEAD_NOTE);
      const candSees = await until(async () => ((await padText(C.page)) ?? '').includes('and a list with one item?'), 15_000);
      const leadText = (await padText(hp)) ?? '';
      const candText = (await padText(C.page)) ?? '';
      const shots = await shootPage(hp, 'E1-lead-pad');
      await shootPage(C.page, 'E1-candidate-pad');
      return { ok: !!leadSees && !!candSees && leadText === candText, detail: `the lead sees the candidate's line ${!!leadSees}; the candidate sees the lead's ${!!candSees}; the two pads hold the same text ${leadText === candText} (${leadText.split('\n').length} lines); ${widths(shots)}` };
    });

    await step('E1j', async () => {
      await C.page.getByTestId('interview-pad-run').click();
      const want = /top two of \[3, 9, 4, 9\]: 9 and 9/;
      const go = await until(async () => { const t = await outputText(C.page); return want.test(t) && /Finished/.test(t) ? t : null; }, 25_000);
      const lo = await until(async () => { const t = await outputText(hp); return want.test(t) && /Finished/.test(t) ? t : null; }, 25_000);
      const runs = (await api(hugo, 'GET', `/api/interviews/interviews/${S.tech}/runs`)).body?.runs ?? [];
      return { ok: !!go && !!lo && /Run by you/.test(go) && /Candidate/.test(lo) && runs.length === 1,
        detail: `the candidate's pane "${(go ?? await outputText(C.page)).slice(0, 110)}"; the lead's "${(lo ?? await outputText(hp)).slice(0, 110)}"; runs stored ${runs.length}` };
    });

    await step('E1k', async () => {
      const callId = (await readInterview(hugo, S.tech))?.callId ?? tech.callIdOf();
      if (!callId) return { ok: false, detail: 'no call id for the round' };
      S.techCall = callId;
      if (!(await inviteMilo(hp, hugo, callId))) return { ok: false, detail: 'Milo did not come into the call' };
      // Milo's voice, from the footer's own control.
      await hp.getByTestId('assistant-status-mark').first().click({ timeout: 10_000 });
      await hp.getByRole('menuitem', { name: /Turn Milo's voice on/ }).click({ timeout: 10_000 });
      const voiceOn = await until(async () => ((await api(hugo, 'GET', `/api/calls/${encodeURIComponent(callId)}/assistant/state`)).body?.voice === true ? true : null), 10_000, 500);
      for (const p of [hp, C.page]) await letSound(p);
      const lead = SEED.cast.interviewer;
      for (const [userId, text] of [
        // The lead asks the first planned question in their own words' opening (what the recap reads as a question asked).
        [lead, `Thanks for joining. ${S.plan[0]}`],
        [S.guestId, 'I would keep one bucket per caller in a shared cache and refill it at a fixed rate, so every node agrees.'],
        [lead, 'Good. What happens with duplicates of the same request?'],
        [S.guestId, 'Duplicates of one request would each take a token, unless the client sends an idempotency key we can check first.'],
      ]) { await hear(hugo, callId, userId, text); await hp.waitForTimeout(400); }
      const deckText = await suggestion(hp);
      if (!deckText) return { ok: false, detail: 'no suggestion with Have Milo ask within 160 s' };
      await shootPage(hp, 'E1-lead-suggestion');
      await hp.getByTestId('interview-room-ask').getByRole('button', { name: /have milo ask/i }).click();
      const receipt = await catchText(hp, null, /Milo asked it aloud/, 20_000);
      const question = (await until(async () => { const t = (await C.page.getByTestId('guest-milo-question').first().innerText().catch(() => '')).trim(); return t || null; }, 15_000)) ?? '';
      const key = question.slice(0, 40);
      const candChat = await chatText(C.page);
      await padTab(C.page);
      const body = squash(await C.page.locator('body').innerText());
      const leaked = ['Have Milo ask', 'I’ll ask it', 'Based on', 'Milo asked it aloud', 'refill it at a fixed rate, so every node agrees'].filter((w) => body.includes(w));
      const shots = await shootPage(C.page, 'E1-candidate-milo-asked');
      S.saidQuestion = question;
      const ok = !!voiceOn && /Milo asked it aloud/.test(receipt) && !!key && deckText.includes(key.slice(0, 25)) && candChat.includes(key) && leaked.length === 0;
      return { ok, detail: `voice on from the footer ${!!voiceOn}; the suggestion "${deckText.slice(0, 90)}"; receipt ${/Milo asked it aloud/.test(receipt)}; the candidate's Milo line "${question.slice(0, 70)}", in their chat ${candChat.includes(key)}; the deck's words on the candidate's page ${JSON.stringify(leaked)}; ${widths(shots)}` };
    });

    await step('E1l', async () => {
      await C.page.waitForTimeout(11_000);  // a press inside 10 s of Milo's last answer is the plain "just answered" sentence
      await C.page.getByTestId('guest-milo-time').click();
      const line = (await until(async () => { const l = (await C.page.getByTestId('guest-milo-line').first().innerText().catch(() => '')).trim(); return TIME_LINE.test(l) ? l : null; }, 12_000))
        ?? (await C.page.getByTestId('guest-milo-line').first().innerText().catch(() => '')).trim();
      const leadChat = await until(async () => { const t = await chatText(hp); return t.includes(line) ? t : null; }, 10_000) ?? await chatText(hp);
      await padTab(hp);
      return { ok: TIME_LINE.test(line) && leadChat.includes(line), detail: `the candidate reads "${line}"; the lead's chat holds it ${leadChat.includes(line)}` };
    });

    await step('E1m', async () => {
      await hp.getByTestId('interview-end').click();
      await hp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ }).click({ timeout: 10_000 });
      await C.page.getByTestId('join-ended').first().waitFor({ timeout: 30_000 });
      const shots = await shootPage(C.page, 'E1-candidate-ended');
      // Ending lands the lead on the round's scorecard, now due (E4 #16).
      const due = new RegExp(`/interviews/rounds/${S.tech}/scorecard$`);
      await hp.waitForURL(due, { timeout: 20_000 }).catch(() => undefined);
      const r = await readInterview(hugo, S.tech);
      const ended = squash(await C.page.getByTestId('join-ended').first().innerText());
      return { ok: r?.state === 'ended' && due.test(new URL(hp.url()).pathname) && !miloScoresIn(ended) && shots.every((s) => s.ok),
        detail: `the round is ${r?.state}; Hugo lands on its scorecard ${due.test(new URL(hp.url()).pathname)}; the candidate reads "${ended.slice(0, 90)}"; ${widths(shots)}` };
    });
    await C?.context.close().catch(() => undefined);

    await step('E1n', async () => {
      const s = await scorecard(hugo, S.tech, { question: RECAP_QUESTION, summary: 'Kept one bucket per caller and named the duplicate case unprompted.', shot: 'E1-scorecard-recap' });
      const lines = (await api(hugo, 'GET', `/api/interviews/interviews/${S.tech}/record`)).body?.record?.transcript?.lines ?? [];
      const cited = [...s.answer.matchAll(/[Ll]ine (\d+)/g)].map((m) => Number(m[1]));
      const citedOk = cited.length >= 1 && cited.every((n) => lines.find((l) => l.seq === n)?.side === 'candidate') && cited.some((n) => /duplicate/i.test(lines.find((l) => l.seq === n)?.text ?? ''));
      const card = (await api(hugo, 'GET', `/api/interviews/interviews/${S.tech}/scorecard`)).body?.scorecard?.mine;
      const ok = s.rated > 0 && s.sourced && citedOk && !miloScoresIn(s.recapText) && !consentIn(s.recapText) && !!card && /Kept one bucket per caller/.test(s.mine) && s.shots.every((x) => x.ok);
      return { ok, detail: `${s.rated} ratings; the recap has ${s.n} statements, each sourced ${s.sourced}; Milo answered "${s.answer.replace(RECAP_QUESTION, '').trim().slice(0, 110)}" citing lines ${cited.join(', ') || 'none'} (${citedOk}); submitted ${!!card}; ${widths(s.shots)}` };
    });

    await step('E1o', async () => {
      const raw = (await api(hugo, 'GET', `/api/interviews/interviews/${S.tech}/record`)).body?.record;
      const log = (await api(hugo, 'GET', `/api/interviews/interviews/${S.tech}/pad/log?after=0`)).body;
      if (!raw?.interview?.startedAt) return { ok: false, detail: 'the record has no start time' };
      const startedAt = Date.parse(raw.interview.startedAt);
      const frames = (log?.events ?? []).filter((e) => e.kind === 'snapshot' && typeof e.text === 'string').map((e) => ({ atMs: Math.max(0, Date.parse(e.at) - startedAt), text: e.text })).sort((a, b) => a.atMs - b.atMs);
      const lines = raw.transcript?.lines ?? [];
      // The code the player shows at a time is the last snapshot at or before it (the library's CodePlayback). A marker's
      // label and the readout name whole seconds, so a moment is checked against both ends of its second.
      const codeAt = (ms) => squash([...frames].filter((f) => f.atMs <= ms).at(-1)?.text ?? '');
      const p = await hugo.newPage();
      await p.goto(`${portal}/interviews/rounds/${S.tech}/record`, { waitUntil: 'domcontentloaded' });
      await seen(p, 'interviews-record-code-playback'); await seen(p, 'interviews-record-transcript-panel');
      await p.waitForTimeout(500);
      const MARKER = '[data-testid="interviews-record-code-playback-marker"]';
      const kinds = await p.locator(MARKER).evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
      const shownCode = async () => squash(await p.locator('[data-testid="interviews-record-code-playback"] .cm-content').innerText());
      const readout = async () => msOfClock(await p.getByTestId('interviews-record-code-playback-time').innerText());
      const atMarker = async (kind) => {
        const loc = p.locator(`${MARKER}[data-kind="${kind}"]`).first();
        await loc.waitFor({ timeout: 15_000 });
        const label = (await loc.getAttribute('aria-label')) ?? '';
        const m = /, at (\d+:\d{2}(?::\d{2})?)$/.exec(label);
        const ms = m ? msOfClock(m[1]) : null;
        await loc.click();
        await p.waitForTimeout(500);
        const code = await shownCode();
        const shown = await readout();
        return { kind, label, code, codeOk: ms !== null && (code === codeAt(ms) || code === codeAt(ms + 999)), timeOk: shown !== null && ms !== null && Math.abs(shown - ms) < 1000 };
      };
      const runAt = await atMarker('run');
      const output = squash(await p.getByTestId('interviews-record-run-output').innerText().catch(() => ''));
      const askAt = await atMarker('question');
      // From the transcript's side: the candidate's line about duplicates moves the clock, and the code with it.
      const dup = lines.find((l) => l.side === 'candidate' && /Duplicates/.test(l.text));
      const seg = p.locator('[data-testid="interviews-record-transcript-panel"] [data-seg-index]').filter({ hasText: 'Duplicates of one request' }).first();
      await seg.click();
      await p.waitForTimeout(500);
      const segShown = await readout();
      const segLit = (await seg.getAttribute('class') ?? '').includes('ring-primary');
      const segCode = await shownCode();
      const segOk = !!dup && segShown !== null && Math.abs(segShown - dup.atMs) < 1000 && segLit && (segCode === codeAt(dup.atMs) || segCode === codeAt(segShown));
      const shots = await shootPage(p, 'E1-record');
      await p.close();
      const ok = kinds.includes('run') && kinds.includes('question') && frames.length >= 1
        && runAt.codeOk && runAt.timeOk && /top two of \[3, 9, 4, 9\]/.test(runAt.code) && /9 and 9/.test(output)
        && askAt.codeOk && askAt.timeOk && !!S.saidQuestion && askAt.label.includes(S.saidQuestion.slice(0, 30))
        && segOk && shots.every((s) => s.ok);
      const debug = ok ? '' : ` [frames at ${JSON.stringify(frames.map((f) => f.atMs))}; lines at ${JSON.stringify(lines.map((l) => l.atMs))}; run code "${runAt.code.slice(-60)}"; seg shown ${segShown} lit ${segLit} code "${segCode.slice(-40)}"]`;
      return { ok, detail: `markers ${JSON.stringify([...new Set(kinds)])}; ${frames.length} code snapshots, ${lines.length} transcript lines; the run marker: code ${runAt.codeOk}, time ${runAt.timeOk}, its output under the code ${/9 and 9/.test(output)}; Milo's question marker: code ${askAt.codeOk}, time ${askAt.timeOk}, names the said question ${!!S.saidQuestion && askAt.label.includes(S.saidQuestion.slice(0, 30))}; the candidate's line about duplicates: the clock to its time, lit, the code of that moment ${segOk}; ${widths(shots)}${debug}` };
    });

    // ── the behavioural round, the same candidate ─────────────────────────────────────────────────────────────────
    await step('E1p', async () => {
      await gp.goto(`${portal}/interviews/candidates/${S.candidateId}`, { waitUntil: 'domcontentloaded' });
      await gp.getByTestId('interviews-profile-assign').first().click({ timeout: 30_000 });
      await gp.getByTestId('interviews-assign-form').waitFor({ timeout: 30_000 });
      await pick(gp, 'interviews-assign-round', new RegExp(`^${TOGETHER}, `));
      await pick(gp, 'interviews-assign-lead', SEED.names[SEED.cast.interviewer2]);
      await gp.getByTestId('interviews-assign-submit').click();
      await gp.getByTestId('interviews-profile-rounds').waitFor({ timeout: 30_000 });
      const r = await until(() => roundOf(TOGETHER), 10_000, 500);
      S.beh = r?.id ?? null;
      if (!S.beh) return { ok: false, detail: 'the behavioural round was not assigned' };
      const a = await accept(wen, false);
      const accepted = await readInterview(wen, S.beh);
      const wpp = await wen.newPage();
      const prep = await prepareWithMilo(wpp, S.beh, 'E1-behavioural-prepare');
      await wpp.close();
      S.behPlan = prep.plan;
      if (!prep.ok) return { ok: false, detail: `Wen's plan: ${prep.detail}` };
      const l = await timeAndLink(S.beh);
      S.behLink = l.linkPath;
      const ok = r.state === 'assigned' && r.round?.type === 'behavioural' && r.lead?.id === SEED.cast.interviewer2 && a.noticeAsked === 0 && accepted?.state === 'accepted' && l.status === 201 && /^\/join#/.test(l.linkPath ?? '');
      return { ok, detail: `${TOGETHER} assigned to ${r.lead?.name} (${r.round?.type}); Wen accepted with the notice asked ${a.noticeAsked} times (${accepted?.state}); her plan: ${prep.detail}; the time is set and the link answered ${l.status}` };
    });

    const wp = await wen.newPage();
    let B = null;
    await step('E1q', async () => {
      await wp.goto(`${portal}/interviews/rounds/${S.beh}/room`, { waitUntil: 'domcontentloaded' });
      const beh = await leadJoins(wp, S.beh);
      if (!beh.live) return { ok: false, detail: 'Wen joined but the interview is not live' };
      B = await candidateArrives(S.behLink);
      if (B.step !== 'waiting') return { ok: false, detail: `the candidate stopped at ${B.step} (landed ${B.first})` };
      const guestId = await admitAndJoin(wp, B);
      const leadTabs = await paneTabs(wp, 'interview-room-pane');
      const candTabs = await paneTabs(B.page, 'join-room-pane');
      const pads = (await wp.getByTestId('interview-pad').count()) + (await B.page.getByTestId('interview-pad').count());
      const callId = (await readInterview(wen, S.beh))?.callId ?? beh.callIdOf();
      if (!(await inviteMilo(wp, wen, callId))) return { ok: false, detail: 'Milo did not come into the behavioural call' };
      const lead = SEED.cast.interviewer2;
      for (const [userId, text] of [
        [lead, `Thanks for coming back. ${S.behPlan[0]}`],
        [guestId, 'Our ticket backlog had doubled, so I split the queue by product and set a daily review with the team.'],
        [lead, 'What changed because of it?'],
        [guestId, 'The backlog was back to normal in three weeks, and two people asked to keep the daily review.'],
      ]) { await hear(wen, callId, userId, text); await wp.waitForTimeout(400); }
      await wp.getByTestId('interview-room-pane-tab-milo').click();
      const tab = wp.getByTestId('interview-room-tab-milo');
      await tab.getByTestId('interview-room-milo-notes').first().waitFor({ timeout: 30_000 });
      const notes = (await api(wen, 'GET', `/api/interviews/interviews/${S.beh}/milo-notes`)).body?.notes;
      const comps = (notes?.competencies ?? []).map((c) => c.name);
      const notesText = squash(await tab.innerText());
      const shots = await shootPage(wp, 'E1-behavioural-milo-notes');
      await shootPage(B.page, 'E1-behavioural-candidate');
      const candBody = squash(await B.page.locator('body').innerText());
      const leaked = comps.filter((c) => candBody.includes(c));
      const ok = !leadTabs.some((t) => t.startsWith('Pad')) && ['Plan', 'Milo', 'Chat'].every((t) => leadTabs.some((x) => x.startsWith(t))) && !candTabs.some((t) => t.startsWith('Pad')) && pads === 0
        && comps.length > 0 && comps.every((c) => notesText.includes(c)) && leaked.length === 0 && shots.every((s) => s.ok);
      return { ok, detail: `Wen's pane ${JSON.stringify(leadTabs)}, the candidate's ${JSON.stringify(candTabs)}, pads on either page ${pads}; Milo's notes name ${JSON.stringify(comps)} on the tab ${comps.every((c) => notesText.includes(c))}; on the candidate's page ${JSON.stringify(leaked)}; ${widths(shots)}` };
    });

    await step('E1r', async () => {
      await wp.getByTestId('interview-end').click();
      await wp.getByTestId('interview-room-ask').getByRole('button', { name: /^End interview$/ }).click({ timeout: 10_000 });
      await B.page.getByTestId('join-ended').first().waitFor({ timeout: 30_000 });
      const r = await readInterview(wen, S.beh);
      const s = await scorecard(wen, S.beh, { summary: 'Took the backlog on as her own and said what changed because of it.', shot: 'E1-behavioural-scorecard' });
      const ok = r?.state === 'ended' && s.rated > 0 && s.sourced && !miloScoresIn(s.recapText) && /Took the backlog on/.test(s.mine) && s.shots.every((x) => x.ok);
      return { ok, detail: `the round is ${r?.state} and the candidate read the ended page; ${s.rated} ratings, the recap's ${s.n} statements sourced ${s.sourced}; submitted; ${widths(s.shots)}` };
    });
    await B?.context.close().catch(() => undefined);

    const ap = await amara.newPage();
    await step('E1s', async () => {
      await ap.goto(`${portal}/interviews/my-openings`, { waitUntil: 'domcontentloaded' });
      const table = ap.getByTestId('interviews-my-openings-table');
      await table.getByText(NAME, { exact: true }).first().waitFor({ timeout: 30_000 });
      const row = table.locator('tr', { hasText: NAME }).first();
      const chip = squash(await row.getByTestId('interviews-result-debrief').innerText());
      await row.getByTestId('interviews-result-debrief').click();
      await ap.waitForURL(new RegExp(`/interviews/candidates/${S.candidateId}/debrief$`), { timeout: 30_000 });
      await seen(ap, 'interviews-debrief-side-by-side');
      await seen(ap, 'interviews-debrief-decide-line');
      const text = squash(await ap.getByTestId('interviews-debrief').innerText());
      const debrief = (await api(amara, 'GET', `/api/interviews/candidates/${S.candidateId}/debrief`)).body?.debrief;
      const rounds = debrief?.applications?.[0]?.rounds ?? [];
      const cards = rounds.flatMap((r) => r.scorecards ?? []);
      const shots = await shootPage(ap, 'E1-debrief');
      S.chip = chip;
      S.decideLine = squash(await ap.getByTestId('interviews-debrief-decide-line').innerText());
      S.decide = debrief?.applications?.[0]?.decide ?? null;
      S.stageBefore = debrief?.applications?.[0]?.stage ?? null;
      const summaries = ['Kept one bucket per caller', 'Took the backlog on as her own'].filter((t) => text.includes(t)).length;
      const ok = rounds.length === 2 && cards.length === 2 && summaries === 2 && text.includes(CODING) && text.includes(TOGETHER) && !!S.decide && !miloScoresIn(text) && !consentIn(text) && shots.every((s) => s.ok);
      return { ok, detail: `My openings' Last result "${chip}" opened the debrief: ${rounds.length} rounds with ${cards.length} scorecards side by side (both summaries on the page ${summaries === 2}); the decision is Amara's ${!!S.decide}; ${widths(shots)}` };
    });

    await step('E1t', async () => {
      // FINDING (reported, not fixed here: a stage change is a product behaviour). A candidate added through the page starts at
      // "applied", and nothing moves them on: assigning, holding and scoring rounds leave the stage where it was, and no route
      // or page lets the recruiter move it (lib/interviews/debrief/rules.ts decisionMove refuses applied and screening with
      // "The recruiter moves them until the first round is in"). The seeded candidates are decidable only because the seed
      // starts them at interviewing or debrief. The step asserts the journey as the plan states it, so it is red until fixed.
      const advance = S.decide?.options?.find((o) => o.decision === 'advance');
      if (!advance?.allowed) {
        return { ok: false, detail: `FINDING: Amara cannot decide: the candidate is still at stage "${S.stageBefore}" after both rounds were held and scored; the debrief reads "${S.decideLine}"; My openings' chip reads "${S.chip}"; advance refused with "${advance?.refusal ?? 'no option'}" (nothing in the product moves an added candidate past applied; see lib/interviews/debrief/rules.ts decisionMove and the assign/scorecard writes in routes/interviews)` };
      }
      await ap.getByTestId(`${DECK}-option-advance`).click();
      await ap.getByTestId(`${DECK}-answer`).fill(REASON);
      await ap.getByTestId(`${DECK}-submit`).click();
      await ap.getByTestId(`${DECK}-option-record`).waitFor({ timeout: 15_000 });
      const asked = squash(await ap.getByTestId(DECK).innerText());
      await ap.getByTestId(`${DECK}-option-record`).click();
      const app = await until(async () => { const a = (await api(amara, 'GET', `/api/interviews/candidates/${S.candidateId}/debrief`)).body?.debrief?.applications?.[0]; return a?.stage === 'offer' ? a : null; }, 15_000, 750);
      const last = app?.history?.at(-1);
      await ap.goto(`${portal}/interviews/candidates/${S.candidateId}`, { waitUntil: 'domcontentloaded' });
      await seen(ap, 'interviews-profile-tab-activity');
      await ap.getByTestId('interviews-profile-tab-activity').click();
      await seen(ap, 'interviews-profile-history');
      const history = squash(await ap.getByTestId('interviews-profile-history').innerText());
      const shots = await shootPage(ap, 'E1-decided');
      const ok = /Record "Advance to an offer" under your name/.test(asked) && app?.stage === 'offer' && last?.decision === 'advance' && last?.reason === REASON && /Offer/.test(history) && history.includes(REASON) && /Amara Okafor/.test(history) && shots.every((s) => s.ok);
      return { ok, detail: `asked "${asked.slice(-80)}"; the stage is ${app?.stage ?? 'unchanged'}, the last move ${last?.decision} by ${last?.byName}; the profile's history shows it with the reason ${history.includes(REASON)}; ${widths(shots)}` };
    });
  } catch (e) {
    // A throw outside a step (a page that would not open): every step not yet recorded is red with the reason.
    for (const id of STEPS) if (!done.has(id)) record(id, false, `the walk stopped: ${why(e)}`);
  } finally {
    for (const c of calls) await api(c.context, 'POST', `/api/calls/${encodeURIComponent(c.callId)}/assistant/dismiss`, {}).catch(() => undefined);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
  }
}
