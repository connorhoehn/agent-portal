// Piece I5.5: the hiring manager's decision (docs/interviews-tenant-plan.md row I5.5, decisions 14 and 15; hardening lane H4). It
// writes, so it puts the mock world back to its seeds first and again at the end.
//   I5.5a  Amara on My openings: the Debrief stage tab is first, Ingrid is "Ready to decide"; her Last result leads to the debrief
//          with the decision deck at the bottom
//   I5.5b  Advance with a reason → Offer; the history under the profile's Activity tab shows it under Amara's name; the recruiter
//          is told by a bell that names the opening and no candidate
//   I5.5c  a decision while a scorecard is still due shows the extra line, and the history says it was decided without it
//          (Kwame's round: Hugo's scorecard in, Wen's due)
//   I5.5d  the decision racing: two windows as Amara decide from the same loaded page; exactly one is recorded, the other is told
//          the page changed
//   I5.5e  a correction after the decision is refused: the interviewer's page offers none and the route says 409
// plus the table I5.5.404 (the runner adds that step).
import { consentIn, failing, miloScoresIn, scorecardBody, seen, squash, why } from './h4-kit.mjs';

const DECK = 'collection-command-composer-prompts';
const REASON_ADVANCE = 'Both rounds were strong on what the payments team needs most.';
const REASON_HOLD = 'Waiting on the second team to confirm the headcount before we go further.';
const REASON_RACE = 'The design round is still to come, so we pause here for now.';

export default async function run(ctx) {
  const { SEED, portal, record, signIn, api, resetMock, shootPage, bells, endInterview } = ctx;
  await resetMock();
  const amara = await signIn(SEED.cast.hiringManager);
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const debriefApi = (who, id) => api(who, 'GET', `/api/interviews/candidates/${id}/debrief`);
  const widths = (shots) => shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ''}`).join(' ');

  /** Choose, give a reason, confirm: the three prompts of the decision, on the open debrief page. Returns the confirm question's text. */
  const decide = async (page, decision, reason, { confirm = true } = {}) => {
    await page.getByTestId(`${DECK}-option-${decision}`).click();
    await page.getByTestId(`${DECK}-answer`).fill(reason);
    await page.getByTestId(`${DECK}-submit`).click();
    await page.getByTestId(`${DECK}-option-record`).waitFor({ timeout: 15_000 });
    const asked = squash(await page.getByTestId(DECK).innerText());
    if (confirm) await page.getByTestId(`${DECK}-option-record`).click();
    return asked;
  };

  const ingrid = (await debriefApi(amara, SEED.candidates.ingrid)).body.debrief;
  const ingridName = ingrid.candidate.name;

  // ── I5.5a: My openings → Ingrid → the debrief with the deck ──────────────────────────────────────────────────────────
  const page = await amara.newPage();
  try {
    await page.goto(`${portal}/interviews/my-openings`, { waitUntil: 'domcontentloaded' });
    const table = page.getByTestId('interviews-my-openings-table');
    await table.getByText(ingridName, { exact: true }).first().waitFor({ timeout: 30_000 });
    const tabIds = await page.locator('[data-testid^="interviews-openings-stage-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid').replace('interviews-openings-stage-', '')));
    const shots = await shootPage(page, 'my-openings-debrief');
    await page.getByTestId('interviews-openings-stage-debrief').click();
    await page.waitForTimeout(400);
    const row = table.locator('tr', { hasText: ingridName });
    const chip = squash(await row.getByTestId('interviews-result-debrief').innerText());
    await row.getByTestId('interviews-result-debrief').click();
    await page.waitForURL(new RegExp(`/interviews/candidates/${SEED.candidates.ingrid}/debrief$`), { timeout: 30_000 });
    await seen(page, 'interviews-debrief-side-by-side');
    await page.getByTestId(`${DECK}-option-advance`).waitFor({ timeout: 15_000 });
    const text = squash(await page.getByTestId('interviews-debrief').innerText());
    const decideLine = squash(await page.getByTestId('interviews-debrief-decide-line').innerText());
    const options = await page.locator('[data-composer-prompt-option]').evaluateAll((els) => els.map((e) => e.getAttribute('data-composer-prompt-option')));
    const ok = tabIds[0] === 'all' && tabIds[1] === 'debrief' && /Ready to decide/.test(chip) && options.join() === 'advance,hold,reject' && /waits in the box at the bottom/.test(decideLine)
      && !miloScoresIn(text) && !consentIn(text) && shots.every((s) => s.ok);
    record('I5.5a', ok, `stage tabs ${tabIds.join(', ')}; "${chip}"; the debrief offers ${options.join(', ')}; "${decideLine.slice(0, 60)}"; ${widths(shots)}`);
  } catch (e) { record('I5.5a', false, `My openings → the debrief: ${why(e)}`); }

  // ── I5.5b: Advance → Offer, the history, the bell ────────────────────────────────────────────────────────────────────
  try {
    const grPage = await greta.newPage();
    await grPage.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    await grPage.getByTestId('interviews-candidates-table').getByText(ingridName, { exact: true }).first().waitFor({ timeout: 30_000 });
    const asked = await decide(page, 'advance', REASON_ADVANCE);
    await page.waitForTimeout(1500);
    const after = (await debriefApi(amara, SEED.candidates.ingrid)).body.debrief.applications[0];
    const last = after.history.at(-1);
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.ingrid}`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-profile-tab-activity');
    await page.getByTestId('interviews-profile-tab-activity').click();
    await seen(page, 'interviews-profile-history');
    const history = squash(await page.getByTestId('interviews-profile-history').innerText());
    const shots = await shootPage(page, 'profile-activity-offer');
    const rung = await bells(grPage, /decision was recorded/i, { ms: 25_000 });
    const bellText = rung.lines.join(' | ');
    await grPage.close();
    const ok = /Record "Advance to an offer" under your name/.test(asked) && after.stage === 'offer' && last.decision === 'advance' && last.reason === REASON_ADVANCE && last.byName === 'Amara Okafor'
      && /Offer/.test(history) && history.includes(REASON_ADVANCE) && /Amara Okafor/.test(history) && rung.lines.length >= 1 && /Senior Backend Engineer/.test(bellText)
      && !bellText.includes(ingridName) && !bellText.includes(REASON_ADVANCE) && shots.every((s) => s.ok);
    record('I5.5b', ok, `confirm asked "${asked.slice(-95)}"; stage ${after.stage}, history ends "${last.decision}" by ${last.byName}; the Activity tab shows it with the reason; the recruiter's bell: "${bellText.slice(0, 90)}"; ${widths(shots)}`);
  } catch (e) { record('I5.5b', false, `Advance: ${why(e)}`); }

  // ── I5.5c: a decision while a scorecard is due ───────────────────────────────────────────────────────────────────────
  try {
    const ended = await endInterview(hugo, SEED.interviews.kwameLive);
    const submitted = await api(hugo, 'POST', `/api/interviews/interviews/${SEED.interviews.kwameLive}/scorecard`, await scorecardBody(ctx, hugo, SEED.interviews.kwameLive));
    const before = (await debriefApi(amara, SEED.candidates.kwame)).body.debrief.applications[0];
    const p = await amara.newPage();
    await p.goto(`${portal}/interviews/candidates/${SEED.candidates.kwame}/debrief`, { waitUntil: 'domcontentloaded' });
    await seen(p, 'interviews-debrief-side-by-side');
    await p.getByTestId(`${DECK}-option-hold`).waitFor({ timeout: 15_000 });
    const fields = squash(await p.getByTestId(DECK).innerText());
    const asked = await decide(p, 'hold', REASON_HOLD);
    await p.waitForTimeout(1500);
    const after = (await debriefApi(amara, SEED.candidates.kwame)).body.debrief.applications[0];
    await p.getByTestId('interviews-debrief-tab-history').click();
    const history = squash(await p.getByTestId('interviews-debrief-history').innerText());
    await p.close();
    const ok = ended.status === 200 && submitted.status === 201 && before.decide.scorecardsMissing === 1 && /1 scorecard/.test(fields) && /still due/i.test(asked) && /decided without them/.test(asked)
      && after.history.at(-1).scorecardsMissing === 1 && /Decided while/.test(history);
    record('I5.5c', ok, `Hugo's scorecard in, Wen's due: the deck showed "${(fields.match(/Still due[^.]*?scorecard/) ?? [''])[0]}", the confirmation said "${(asked.match(/[^.]*still due[^.]*\./i) ?? [''])[0].trim().slice(0, 100)}"; the history reads "${(history.match(/Decided while[^.]*\./) ?? [''])[0]}"`);
  } catch (e) { record('I5.5c', false, `a decision while a scorecard is due: ${why(e)}`); }

  // ── I5.5d: the decision racing ───────────────────────────────────────────────────────────────────────────────────────
  let second = null;
  try {
    const amara2 = await signIn(SEED.cast.hiringManager);
    second = amara2;
    const a = await amara.newPage();
    const b = await amara2.newPage();
    const url = `${portal}/interviews/candidates/${SEED.candidates.mateo}/debrief`;
    await Promise.all([a.goto(url, { waitUntil: 'domcontentloaded' }), b.goto(url, { waitUntil: 'domcontentloaded' })]);
    for (const p of [a, b]) await p.getByTestId(`${DECK}-option-hold`).waitFor({ timeout: 20_000 });
    const before = (await debriefApi(amara, SEED.candidates.mateo)).body.debrief.applications[0];
    // Both windows get to the confirmation from the same loaded page; the two clicks that record it go out together.
    await Promise.all([decide(a, 'hold', REASON_RACE, { confirm: false }), decide(b, 'hold', `${REASON_RACE} (second window)`, { confirm: false })]);
    const stageCall = (p) => p.waitForResponse((r) => /\/applications\/[^/]+\/stage$/.test(r.url()) && r.request().method() === 'POST', { timeout: 20_000 });
    const calls = [stageCall(a), stageCall(b)];
    await Promise.all([a.getByTestId(`${DECK}-option-record`).click(), b.getByTestId(`${DECK}-option-record`).click()]);
    const answers = await Promise.all(calls.map(async (c) => { const r = await c; return { status: r.status(), body: await r.json().catch(() => ({})) }; }));
    await a.waitForTimeout(1500);
    const after = (await debriefApi(amara, SEED.candidates.mateo)).body.debrief.applications[0];
    const statuses = answers.map((x) => x.status).sort();
    const stale = answers.find((x) => x.status === 409)?.body?.error ?? '';
    const added = after.history.length - before.history.length;
    record('I5.5d', added === 1 && after.history.at(-1).decision === 'hold' && statuses.join() === '201,409' && /changed while you were reading/.test(stale) && after.basedOn === before.basedOn + 1,
      `two windows on the same page (history ${before.history.length}); answers ${statuses.join(' and ')}; the history grew by ${added}; the loser was told "${stale.slice(0, 80)}"`);
    await a.close();
    await b.close();
  } catch (e) { record('I5.5d', false, `the race: ${why(e)}`); }

  // ── I5.5e: a correction after the decision ───────────────────────────────────────────────────────────────────────────
  try {
    const coding = SEED.interviews.ingridCoding;
    const read = (await api(hugo, 'GET', `/api/interviews/interviews/${coding}/scorecard`)).body.scorecard;
    const refused = await api(hugo, 'POST', `/api/interviews/interviews/${coding}/scorecard`, {
      ratings: read.competencies.map((c) => ({ competencyId: c.id, rating: 1, note: '' })), recommendation: 'no', summary: 'Second thoughts.', reason: 'I misremembered the second question.', basedOn: read.mine.version,
    });
    const p = await hugo.newPage();
    await p.goto(`${portal}/interviews/rounds/${coding}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(p, 'interviews-scorecard-mine');
    const text = squash(await p.getByTestId('interviews-scorecard').innerText());
    const correct = await p.getByTestId('interviews-scorecard-correct').count();
    const shots = await shootPage(p, 'scorecard-reviewed');
    await p.close();
    const checks = {
      reviewed: read.interview.state === 'reviewed', cannotSubmit: read.canSubmit === false, status409: refused.status === 409, sentence: /can no longer be corrected/.test(refused.body?.error ?? ''),
      noButton: correct === 0, doneChip: /\bDone\b/.test(text), shots: shots.every((s) => s.ok),
    };
    record('I5.5e', Object.values(checks).every(Boolean),
      `[failing: ${failing(checks)}] after the decision the round is ${read.interview.state}; the route answers ${refused.status} "${refused.body?.error ?? ''}"; the page offers ${correct} "Correct it"; ${widths(shots)}`);
  } catch (e) { record('I5.5e', false, `correction after the decision: ${why(e)}`); }

  await page.close().catch(() => undefined);
  await second?.close().catch(() => undefined);
  await amara.close();
  await greta.close();
  await hugo.close();
  await resetMock();
}
