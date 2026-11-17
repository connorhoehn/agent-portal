// Piece I5.3: the scorecard (docs/interviews-tenant-plan.md row I5.3; hardening lane H4). It writes, so it puts the mock world
// back to its seeds first and again at the end.
//   I5.3a  Wen opens Jonah's round (ended, her scorecard due): the form, nothing to continue until every competency is rated,
//          and the others' scorecards stay hidden (the page and the route agree)
//   I5.3b  she rates, continues to the recap (the prompt says the ratings are recorded as they stand), reads Milo's evidence
//          beside her own ratings (a quote and a line on every statement, no Chip, no tone, no rating of Milo's) and a reload
//          at the recap step puts her back there
//   I5.3c  she goes back, lowers one rating, continues, recommends, submits: the debrief records changedAfterRecap for her
//   I5.3d  the submitted scorecard reads back as it was sent, with no field to edit and one button, "Correct it" (O-264)
//   I5.3e  a correction before the decision: a reason is asked, the new version is kept, the first stays readable
//   I5.3f  others hidden until yours is in: Kwame's round (Hugo leads, Wen on the panel) ended, Hugo's scorecard in, Wen still
//          sees nobody's until hers is in, then sees Hugo's
// plus the table I5.3.404 (the runner adds that step).
import { failing, openBody, openRecapStep, rateAllUI, ratingGroups, scorecardBody, seen, squash, submitFromRecap, consentIn, miloScoresIn, tonesIn, why } from './h4-kit.mjs';

const SUMMARY_1 = 'Gave concrete examples of coaching a teammate; one competency lowered after reading the recap.';
const SUMMARY_2 = 'Gave concrete examples of coaching a teammate, and of moving a deadline early rather than late.';
const REASON = 'I misread the second answer; the example was the team\'s decision, not hers.';

export default async function run(ctx) {
  const { SEED, portal, record, signIn, api, resetMock, shootPage, endInterview } = ctx;
  await resetMock();
  const JONAH = SEED.interviews.jonahLeadership;
  const KWAME = SEED.interviews.kwameLive;
  const scorecardApi = (who, id) => api(who, 'GET', `/api/interviews/interviews/${id}/scorecard`);
  const widths = (shots) => shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ''}`).join(' ');

  const wen = await signIn(SEED.cast.interviewer2);
  const greta = await signIn(SEED.cast.recruiter);
  const page = await wen.newPage();
  let competencies = 0;

  // ── I5.3a: the form, and the others hidden ────────────────────────────────────────────────────────────────────────────
  try {
    await page.goto(`${portal}/interviews/rounds/${JONAH}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-scorecard-form');
    const read = (await scorecardApi(wen, JONAH)).body.scorecard;
    competencies = read.competencies.length;
    const groups = await ratingGroups(page).count();
    const continueDisabled = await page.getByTestId('interviews-scorecard-to-recap').isDisabled();
    const header = squash(await page.getByTestId('interviews-scorecard').innerText());
    const shots = await shootPage(page, 'scorecard-rate');
    await page.getByTestId('interviews-scorecard-tab-others').click();
    const hiddenLine = squash(await page.getByTestId('interviews-scorecard-others-line').innerText());
    await page.getByTestId('interviews-scorecard-tab-mine').click();
    const ok = groups === competencies && competencies > 0 && continueDisabled && /Your scorecard is due/.test(header) && read.canSubmit === true
      && read.othersHidden === true && read.others.length === 0 && /stay hidden until yours is in/.test(hiddenLine) && !consentIn(header)
      && shots.every((s) => s.ok);
    record('I5.3a', ok, `${groups} competencies to rate, Continue disabled ${continueDisabled}, "${hiddenLine.slice(0, 70)}", route othersHidden=${read.othersHidden}; ${widths(shots)}`);
  } catch (e) { record('I5.3a', false, `the form: ${why(e)}`); }

  // ── I5.3b: rate, the recap, a reload ──────────────────────────────────────────────────────────────────────────────────
  try {
    await rateAllUI(page, 3);
    await page.getByTestId('interviews-scorecard-to-recap').click();
    const asked = squash(await page.getByTestId('interviews-scorecard-ask').innerText());
    await page.getByTestId('interviews-scorecard-ask-option-open').click();
    await seen(page, 'interviews-scorecard-recap-step');
    await seen(page, 'interviews-recap-competency');
    const readRecap = async () => {
      const section = page.getByTestId('interviews-recap');
      const blocks = await page.getByTestId('interviews-recap-competency').count();
      const claims = page.getByTestId('interviews-recap-claim');
      const n = await claims.count();
      for (let i = 0; i < n; i += 1) await claims.nth(i).click();
      const claimTexts = [];
      for (let i = 0; i < n; i += 1) claimTexts.push(squash(await claims.nth(i).innerText()));
      return { text: squash(await section.innerText()), blocks, n, claimTexts, tones: await tonesIn(section) };
    };
    const first = await readRecap();
    const sourced = first.claimTexts.every((t) => /Line \d+ of the transcript: “[^”]{3,}”/.test(t));
    const own = (first.text.match(/Your rating[^A-Z]*3 of 4/g) ?? []).length;
    const stored = (await api(wen, 'GET', `/api/interviews/interviews/${JONAH}/recap`)).body?.recap;
    const shots = await shootPage(page, 'scorecard-recap');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(300);
    const clipped = await page.evaluate(() => [...document.querySelectorAll('[data-testid="interviews-recap"] *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && e.textContent.trim() !== '').length);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-scorecard-recap-step');
    await seen(page, 'interviews-recap-competency');
    const again = await readRecap();
    const pageText = squash(await page.getByTestId('interviews-scorecard').innerText());
    const checks = {
      prompt: /recorded as they stand/.test(asked), blocks: first.blocks === competencies, statements: first.n >= 1, sourced, noTone: first.tones === 0, own: own === competencies,
      stored: stored?.state === 'ready', reloadBlocks: again.blocks === competencies, reloadStatements: again.n === first.n, reloadOwn: /Your rating[^A-Z]*3 of 4/.test(again.text),
      milo: !miloScoresIn(pageText), consent: !consentIn(pageText), shots: shots.every((s) => s.ok), noClipAt1280: clipped === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    record('I5.3b', ok, `[failing: ${failing(checks)}] prompt "${asked.slice(0, 60)}…", ${first.blocks} competencies, ${first.n} statements each with its line and quote (${sourced}), tones ${first.tones}, own ratings shown ${own}; a reload at the recap step: ${again.blocks} competencies, ${again.n} statements; ${widths(shots)}`);
  } catch (e) { record('I5.3b', false, `rate and recap: ${why(e)}`); }

  // ── I5.3c: change a rating after the recap, then submit ───────────────────────────────────────────────────────────────
  let sentSummary = '';
  try {
    await page.getByTestId('interviews-scorecard-back-to-ratings').click();
    await ratingGroups(page).first().getByRole('radio', { name: /^1 / }).click();
    await page.getByTestId('interviews-scorecard-to-recap').click(); // already recorded: no second prompt
    await seen(page, 'interviews-scorecard-recap-step');
    await seen(page, 'interviews-recap-competency');
    const lowered = /Your rating[^A-Z]*1 of 4/.test(squash(await page.getByTestId('interviews-recap').innerText()));
    sentSummary = SUMMARY_1;
    await submitFromRecap(page, { recommendation: 'Yes', summary: SUMMARY_1 });
    const debrief = (await api(greta, 'GET', `/api/interviews/candidates/${SEED.candidates.jonah}/debrief`)).body?.debrief;
    const card = debrief?.applications?.[0]?.rounds?.[0]?.scorecards?.find((s) => s.interviewer.id === SEED.cast.interviewer2);
    record('I5.3c', lowered && card?.changedAfterRecap === true && card?.version === 1, `the recap step showed the lowered rating (${lowered}); submitted; the debrief says changedAfterRecap=${card?.changedAfterRecap} on version ${card?.version}`);
  } catch (e) { record('I5.3c', false, `change after the recap: ${why(e)}`); }

  // ── I5.3d: it reads back as sent, with nothing to edit but the correction ────────────────────────────────────────────
  try {
    const mine = page.getByTestId('interviews-scorecard-mine');
    await mine.waitFor({ timeout: 15_000 });
    const text = squash(await mine.innerText());
    const sent = (await scorecardApi(wen, JONAH)).body.scorecard.mine;
    const ratingsShown = (text.match(/\b[1-4] of 4\b/g) ?? []);
    const anchors = await mine.getByTestId('interviews-scorecard-anchor').count();
    const editable = await page.locator('[data-ui-control="rating"], textarea').count();
    const correctButtons = await page.getByTestId('interviews-scorecard-correct').count();
    const submitButtons = await page.getByTestId('interviews-scorecard-submit').count();
    const verdict = squash(await mine.getByTestId('interviews-scorecard-verdict').innerText());
    const shots = await shootPage(page, 'scorecard-submitted');
    const checks = {
      summaryShown: text.includes(SUMMARY_1), summaryRoute: sent.summary === SUMMARY_1, version: sent.version === 1, lowered: sent.ratings[0].rating === 1, rest: sent.ratings.slice(1).every((r) => r.rating === 3),
      ratingsShown: ratingsShown.length === competencies, firstShown: ratingsShown[0] === '1 of 4', anchors: anchors === competencies, noFields: editable === 0, oneButton: correctButtons === 1 && submitButtons === 0,
      verdict: /^Go, yes$/.test(verdict), milo: !miloScoresIn(text), shots: shots.every((s) => s.ok),
    };
    const ok = Object.values(checks).every(Boolean);
    record('I5.3d', ok, `[failing: ${failing(checks)}] read back "${verdict}", ratings ${ratingsShown.join(', ')}, ${anchors} anchors, ${editable} editable fields, ${correctButtons} "Correct it", ${submitButtons} Submit; matches the route's version ${sent.version}; ${widths(shots)}`);
  } catch (e) { record('I5.3d', false, `read back: ${why(e)}`); }

  // ── I5.3e: a correction before the decision ───────────────────────────────────────────────────────────────────────────
  try {
    const before = (await scorecardApi(wen, JONAH)).body.scorecard.mine;
    const noReason = await api(wen, 'POST', `/api/interviews/interviews/${JONAH}/scorecard`, { ...(await scorecardBody(ctx, wen, JONAH, { basedOn: 1 })) });
    await page.getByTestId('interviews-scorecard-correct').click();
    await page.getByTestId('interviews-scorecard-ask-answer').fill(REASON);
    await page.getByTestId('interviews-scorecard-ask-submit').click();
    await seen(page, 'interviews-scorecard-reason');
    const line = squash(await page.getByTestId('interviews-scorecard-reason').innerText());
    await openRecapStep(page);
    await submitFromRecap(page, { recommendation: 'Yes', summary: SUMMARY_2 });
    const after = (await scorecardApi(wen, JONAH)).body.scorecard.mine;
    const versionsTab = await page.getByTestId('interviews-scorecard-tab-versions').count();
    const ok = noReason.status === 400 && /Correcting version 1/.test(line) && line.includes(REASON) && after.version === 2 && after.correctionReason === REASON
      && after.summary === SUMMARY_2 && after.earlier.length === 1 && after.earlier[0].summary === SUMMARY_1 && before.version === 1 && versionsTab === 1;
    record('I5.3e', ok, `without a reason the route says ${noReason.status}; with one: version ${after.version}, reason kept, version 1 still readable (${after.earlier.length} earlier), "Earlier versions" tab ${versionsTab}`);
  } catch (e) { record('I5.3e', false, `correction: ${why(e)}`); }

  // ── I5.3f: others hidden until yours is in ────────────────────────────────────────────────────────────────────────────
  let hugo = null;
  let wenPage = null;
  try {
    hugo = await signIn(SEED.cast.interviewer);
    const ended = await endInterview(hugo, KWAME);
    const hugoBody = await scorecardBody(ctx, hugo, KWAME);
    const hugoSubmit = await api(hugo, 'POST', `/api/interviews/interviews/${KWAME}/scorecard`, hugoBody);
    const hidden = (await scorecardApi(wen, KWAME)).body.scorecard;
    wenPage = await wen.newPage();
    await wenPage.goto(`${portal}/interviews/rounds/${KWAME}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(wenPage, 'interviews-scorecard-form');
    await wenPage.getByTestId('interviews-scorecard-tab-others').click();
    const hiddenText = squash(await wenPage.getByTestId('interviews-scorecard-others').innerText());
    const hiddenOk = hidden.othersHidden === true && hidden.others.length === 0 && /stay hidden until yours is in/.test(hiddenText) && !/Hugo Marchetti/.test(hiddenText);
    await wenPage.getByTestId('interviews-scorecard-tab-mine').click();
    await rateAllUI(wenPage, 2);
    await openRecapStep(wenPage);
    await submitFromRecap(wenPage, { recommendation: 'No', summary: 'The first fix was found late and the second was not tested.' });
    await wenPage.getByTestId('interviews-scorecard-tab-others').click();
    await seen(wenPage, 'interviews-scorecard-other');
    const shown = (await scorecardApi(wen, KWAME)).body.scorecard;
    const shownText = squash(await wenPage.getByTestId('interviews-scorecard-others').innerText());
    const ok = ended.status === 200 && hugoSubmit.status === 201 && hiddenOk && shown.othersHidden === false && shown.others.length === 1 && shown.others[0].interviewer.id === SEED.cast.interviewer
      && /Hugo Marchetti/.test(shownText) && !/stay hidden/.test(shownText);
    record('I5.3f', ok, `Hugo submitted first; Wen saw nobody's (route others=${hidden.others.length}, page "stay hidden"); after she submitted she read Hugo's (${shown.others.length})`);
  } catch (e) { record('I5.3f', false, `others hidden: ${why(e)}`); }

  await wenPage?.close().catch(() => undefined);
  await wen.close();
  await greta.close();
  await hugo?.close().catch(() => undefined);
  await resetMock();
}
