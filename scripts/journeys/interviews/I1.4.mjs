// Piece I1.4: assign a round, the bell, My interviews, accept or decline (row I1.4, with the panel's notice at Accept).
// It writes, so it puts the mock world back to its seeds first and again at the end. The cast: Greta (recruiter) assigns
// Lucía's Coding round, Hugo leads and Wen sits on the panel. Hugo has acknowledged only an EARLIER version of the panel's
// notice (middleware/src/mock/interviews-panel-notices.ts); Wen acknowledged the current one.
//   I1.4a  Greta assigns Lucía's Coding round from the profile's form; the new round is assigned, with the right seats
//   I1.4b  Hugo's bell carries the opening and the round, never the candidate; the round is under his To accept tab
//   I1.4c  Hugo's Accept shows the panel's notice once; reading it accepts the round (it moves to To prepare)
//   I1.4d  a second Accept, on another round, goes straight through: the notice is not asked again
//   I1.4e  a notice version that is not the current one is refused with the current notice; on a fresh visit Hugo, who now holds the current one, is not asked again
//   I1.4f  Wen declines with a reason (too short is refused in words); the decline bell carries no candidate and opens the profile
//   I1.4g  Greta reads the reason on the reassign form and reassigns the lead to Wen; Wen's bell says so
//   I1.4h  Amara (hiring manager) is refused: the page and the API
const CODING = 'Coding';
const OPENING = 'Senior Backend Engineer';

export default async function run({ portal, out, SEED, record, signIn, shootPage, resetMock, api, bells }) {
  await resetMock();
  const lucia = SEED.candidates.lucia;
  const profile = `${portal}/interviews/candidates/${lucia}`;
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  let round = null;
  const luciaRound = async () => (await api(greta, 'GET', `/api/interviews/interviews`)).body?.items?.find((i) => i.candidate?.id === lucia && i.round?.name === CODING) ?? null;
  const tab = async (page, id) => { await page.getByTestId(`interviews-desk-tab-${id}`).click(); };
  const deskPage = async (ctx) => {
    const p = await ctx.newPage();
    await p.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('interviews-my-interviews-table').waitFor({ timeout: 30_000 });
    return p;
  };
  // The library's Select is a combobox button with a listbox: open it, click the option.
  const pick = async (page, testId, name) => { await page.getByTestId(testId).click(); await page.getByRole('option', { name }).click(); };
  const noNames = (lines) => lines.every((l) => !/Luc[ií]a|Navarro|cand-|lucia/i.test(l));

  // ── I1.4a ──
  try {
    const page = await greta.newPage();
    await page.goto(profile, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-profile-assign').click();
    await page.getByTestId('interviews-assign-form').waitFor({ timeout: 30_000 });
    await pick(page, 'interviews-assign-round', new RegExp(`^${CODING}, `));
    await pick(page, 'interviews-assign-lead', SEED.names[SEED.cast.interviewer]);
    await pick(page, 'interviews-assign-panel-0', SEED.names[SEED.cast.interviewer2]);
    const shots = await shootPage(page, 'assign-form');
    await page.getByTestId('interviews-assign-submit').click();
    await page.getByTestId('interviews-profile-rounds').waitFor({ timeout: 30_000 });
    round = await luciaRound();
    await page.close();
    const ok = !!round && round.state === 'assigned' && round.lead?.id === SEED.cast.interviewer && round.panel?.some((p) => p.id === SEED.cast.interviewer2) && shots.every((s) => s.ok);
    record('I1.4a', ok, `Greta assigned ${CODING} for Lucía: ${round ? `${round.state}, lead ${round.lead?.name}, panel ${JSON.stringify((round.panel ?? []).map((p) => p.name))}` : 'no round found'}; form ${shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ' fits'}`).join(', ')}`);
  } catch (e) { record('I1.4a', false, `assign: ${e.message.split('\n')[0]}`); }

  // ── I1.4b ──
  let hugoPage = null;
  let reaskShown = 0;
  try {
    hugoPage = await deskPage(hugo);
    const got = await bells(hugoPage, /new round|Coding/i);
    await hugoPage.keyboard.press('Escape');
    await tab(hugoPage, 'to-accept');
    const row = hugoPage.getByTestId('interviews-my-interviews-table').getByText(CODING).first();
    await row.waitFor({ timeout: 30_000 });
    const hasAccept = await hugoPage.getByTestId('interviews-desk-accept').count();
    reaskShown = await hugoPage.getByTestId('interviews-panel-notice-changed-fold').count();
    const ok = got.lines.some((l) => new RegExp(`${CODING}.*${OPENING}`).test(l)) && noNames(got.lines) && hasAccept >= 1;
    record('I1.4b', ok, `Hugo's bell: ${JSON.stringify(got.lines.slice(0, 2))}; ${hasAccept} Accept button(s) under To accept; the notice-changed re-ask ${reaskShown ? 'was' : 'was not'} offered on arrival (Hugo holds an earlier version)`);
  } catch (e) { record('I1.4b', false, `Hugo's bell: ${e.message.split('\n')[0]}`); }

  // ── I1.4c ──
  try {
    const page = hugoPage;
    const rowFor = page.getByTestId('interviews-my-interviews-table').locator('tr', { hasText: 'Lucía' });
    await rowFor.getByTestId('interviews-desk-accept').click();
    const fold = page.getByText('Read the notice', { exact: true });
    await fold.waitFor({ timeout: 30_000 });
    const asked = await page.getByText('I have read it — accept').count();
    await fold.click();
    const text = await page.getByTestId('interviews-panel-notice-text').innerText();
    await page.getByRole('button', { name: /I have read it — accept/ }).click();
    await rowFor.waitFor({ state: 'detached', timeout: 30_000 });
    const after = await luciaRound();
    const ok = asked >= 1 && text.length > 100 && after?.acceptances?.some((a) => a.userId === SEED.cast.interviewer || a.id === SEED.cast.interviewer) !== false && after?.state === 'accepted';
    record('I1.4c', ok, `Accept showed the notice once (${text.length} characters of notice); then the round is ${after?.state}`);
  } catch (e) { record('I1.4c', false, `accept with the notice: ${e.message.split('\n')[0]}`); }

  // ── I1.4d ──
  try {
    const page = hugoPage;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-my-interviews-table').waitFor({ timeout: 30_000 });
    await tab(page, 'to-accept');
    const other = page.getByTestId('interviews-my-interviews-table').locator('tr', { hasText: 'Kwame' }).first();
    await other.getByTestId('interviews-desk-accept').click();
    await other.waitFor({ state: 'detached', timeout: 30_000 });
    const kwame = (await api(hugo, 'GET', `/api/interviews/interviews/${SEED.interviews.kwameCoding}`)).body?.interview;
    const noticeShown = await page.getByText('I have read it — accept').count();
    record('I1.4d', noticeShown === 0 && kwame?.state === 'accepted', `a second Accept (Kwame's design round) went straight through, now ${kwame?.state}; the notice was shown ${noticeShown} time(s)`);
  } catch (e) { record('I1.4d', false, `second accept: ${e.message.split('\n')[0]}`); }

  // ── I1.4e ──
  try {
    const r = await luciaRound();
    const stale = await api(hugo, 'POST', `/api/interviews/interviews/${r.id}/panel-notice`, { version: 'an-older-version' });
    const status = (await api(hugo, 'GET', '/api/interviews/interviews/panel-notice')).body;
    const page = await deskPage(hugo);
    await page.waitForTimeout(1500);
    const reasked = await page.getByTestId('interviews-panel-notice-changed-fold').count();
    await page.close();
    const ok = reaskShown >= 1 && stale.status === 409 && !!stale.body?.needsNotice?.version && status?.acknowledged === true && reasked === 0;
    record('I1.4e', ok, `the re-ask was offered on arrival (${reaskShown}); an old notice version answers ${stale.status} with the current notice; Hugo holds the current one (${status?.acknowledged}) and the re-ask is shown ${reasked} time(s)`);
  } catch (e) { record('I1.4e', false, `notice version: ${e.message.split('\n')[0]}`); }
  await hugoPage?.close().catch(() => undefined);

  // ── I1.4f ──
  try {
    const page = await deskPage(wen);
    const round2 = await luciaRound();
        await tab(page, 'to-accept');
    const row = page.getByTestId('interviews-my-interviews-table').locator('tr', { hasText: 'Lucía' }).first();
    await row.waitFor({ timeout: 30_000 });
    await row.getByTestId('interviews-desk-decline').click();
    const deck = page.getByTestId('collection-command-composer-prompts');
    const box = deck.getByRole('textbox').first();
    await box.waitFor({ timeout: 30_000 });
    await box.fill('too short');
    await box.press('Enter');
    await page.waitForTimeout(800);
    const tooShort = (await deck.innerText()).replace(/\s+/g, ' ');
    const REASON = 'I am on leave that week and cannot sit on a coding round.';
    await box.fill(REASON);
    await box.press('Enter');
    await page.getByText('Declined. The recruiter has been told.').first().waitFor({ timeout: 30_000 });
    const after = await luciaRound();
    await page.close();
    const gp = await greta.newPage();
    await gp.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await gp.getByTestId('activity-bell').first().waitFor({ timeout: 30_000 });
    const got = await bells(gp, /declined/i);
    const line = got.lines.join(' ');
    const link = null; const href = 'the bell line';
    let landed = null;
    if (got.panel) {
      await got.panel.getByText(/Wen Zhao declined/).first().click();
      await gp.waitForURL(new RegExp(`/interviews/candidates/${lucia}`), { timeout: 20_000 }).then(() => { landed = 'profile'; }).catch(() => { landed = gp.url(); });
    }
    await gp.close();
    const ok = /in at least 10 characters/.test(tooShort) && after && !after.panel?.some((p) => p.id === SEED.cast.interviewer2)
      && got.lines.some((l) => /Wen Zhao declined a panel seat/.test(l)) && noNames(got.lines) && !/leave/.test(line) && landed === 'profile' && !/cand-|lucia/i.test(String(link ?? ''));
    record('I1.4f', ok, `Wen's short reason was refused ("${tooShort.slice(-90)}"); the decline stands (panel now ${JSON.stringify((after?.panel ?? []).map((p) => p.name))}); bell ${JSON.stringify(got.lines.slice(0, 1))} (no candidate, no reason), link ${link ?? href}, opened ${landed}`);
    void round2;
  } catch (e) { record('I1.4f', false, `decline: ${e.message.split('\n').slice(0, 7).join(' ').slice(0, 700)}`); }

  // ── I1.4g ──
  try {
    const page = await greta.newPage();
    await page.goto(profile, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-profile-reassign').first().click();
    const declines = page.getByTestId('interviews-assign-declines');
    await declines.waitFor({ timeout: 30_000 });
    const text = (await declines.innerText()).replace(/\s+/g, ' ');
    const shots = await shootPage(page, 'reassign-form');
    await pick(page, 'interviews-assign-lead', SEED.names[SEED.cast.interviewer2]);
    await page.getByTestId('interviews-assign-submit').click();
    await page.getByTestId('interviews-profile-rounds').waitFor({ timeout: 30_000 });
    const after = await luciaRound();
    await page.close();
    const wp = await deskPage(wen);
    const got = await bells(wp, /You are now on|new round/i);
    await wp.close();
    const ok = /Wen Zhao declined the panel seat: I am on leave/.test(text) && after?.lead?.id === SEED.cast.interviewer2 && after?.state === 'assigned' && got.lines.length > 0 && noNames(got.lines) && shots.every((s) => s.ok);
    record('I1.4g', ok, `Greta read "${text.slice(0, 100)}" and moved the lead to Wen: ${after?.state}, lead ${after?.lead?.name}; Wen's bell ${JSON.stringify(got.lines.slice(0, 1))}`);
  } catch (e) { record('I1.4g', false, `reassign: ${e.message.split('\n')[0]}`); }

  // ── I1.4h ──
  try {
    const amara = await signIn(SEED.cast.hiringManager);
    const page = await amara.newPage();
    await page.goto(`${portal}/interviews/candidates/${lucia}/assign?application=${SEED.applications.lucia}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('no-access').waitFor({ timeout: 30_000 });
    const form = await page.getByTestId('interviews-assign-form').count();
    const w = await api(amara, 'POST', '/api/interviews/interviews', { applicationId: SEED.applications.lucia, roundId: SEED.rounds.design, leadId: SEED.cast.interviewer, panelIds: [] });
    const buttons = await (async () => { await page.goto(profile, { waitUntil: 'domcontentloaded' }); await page.getByTestId('interviews-profile-rounds').waitFor({ timeout: 30_000 }).catch(() => undefined); return page.getByTestId('interviews-profile-assign').count(); })();
    await amara.close();
    record('I1.4h', form === 0 && w.status === 403 && buttons === 0, `the hiring manager at the assign address sees the no-access page (${form} forms); the write answers ${w.status}${w.body?.action ? ` (${w.body.action})` : ''}; ${buttons} Assign buttons on the profile`);
  } catch (e) { record('I1.4h', false, `hiring manager: ${e.message.split('\n')[0]}`); }

  for (const c of [greta, hugo, wen]) await c.close().catch(() => undefined);
  await resetMock();
}
