// Piece I1.7: the Prepare page (row I1.7). It writes, so it puts the mock world back to its seeds first and again at the end.
// The round is Nadia's system design round (accepted, Hugo leads, in five days, no questions yet); the panel round is the seeded
// leadership round (Wen leads, Hugo sits on the panel).
//   I1.7a  the lead opens Prepare from his To prepare tab; the résumé sits beside the questions; a round with no plan says what it waits for
//   I1.7b  he adds three questions, moves one down, takes one out, saves: the round is Ready and "Open the room" appears
//   I1.7c  the recruiter clears the time: the round goes back to Accepted and the page says it waits for a time
//   I1.7d  a panel member reads the page and chooses nothing (no Save, no Add, no move buttons)
//   I1.7e  a stale save is refused in words and the page shows what was saved
//   I1.7f  the plan and the round never show the opening's money; the breadcrumb leads back to My interviews
export default async function run({ portal, SEED, record, signIn, shootPage, resetMock, api, setTime, clock }) {
  await resetMock();
  const id = SEED.interviews.nadiaDesign;
  const url = `${portal}/interviews/rounds/${id}/prepare`;
  const hugo = await signIn(SEED.cast.interviewer);
  const greta = await signIn(SEED.cast.recruiter);
  const wen = await signIn(SEED.cast.interviewer2);
  const read = async (ctx, which = id) => (await api(ctx, 'GET', `/api/interviews/interviews/${which}`)).body?.interview;
  const ready = async (page) => page.getByTestId('interviews-prepare').waitFor({ timeout: 30_000 });
  const textOf = async (page, tid) => ((await page.getByTestId(tid).first().innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  const planPrompts = async (page) => (await page.getByTestId('interviews-plan-prompt').allInnerTexts()).map((s) => s.trim());
  let page = null;

  // ── I1.7a ──
  try {
    page = await hugo.newPage();
    await page.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-my-interviews-table').waitFor({ timeout: 30_000 });
    await page.getByTestId('interviews-desk-tab-to-prepare').click();
    const row = page.getByTestId('interviews-my-interviews-table').locator('tr', { hasText: 'Nadia' }).first();
    await row.getByTestId('interviews-desk-prepare').click();
    await page.waitForURL(new RegExp(`/rounds/${id}/prepare$`), { timeout: 30_000 });
    await ready(page);
    const missing = await textOf(page, 'interviews-prepare-missing');
    const resume = await page.getByTestId('interviews-prepare-resume').count();
    const shots = await shootPage(page, 'prepare');
    const state = await textOf(page, 'interviews-prepare-state');
    record('I1.7a', /Waiting for a time|Choose at least one question/.test(missing) && resume === 1 && shots.every((s) => s.ok) && !/\b(iv|rd|q)-[a-z0-9]/.test(await page.getByTestId('interviews-prepare').innerText()),
      `opened from To prepare: chip "${state}", line "${missing}", résumé column ${resume ? 'beside the questions' : 'missing'}; ${shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ' fits'}`).join(', ')}`);
  } catch (e) { record('I1.7a', false, `prepare: ${e.message.split('\n')[0]}`); }

  // ── I1.7b ──
  let offered = 0;
  try {
    const adds = page.getByTestId('interviews-bank-add');
    for (let n = 0; n < 3; n += 1) { if (await adds.count() === 0) break; await adds.first().click(); offered += 1; await page.waitForTimeout(300); }
    const before = await planPrompts(page);
    await page.getByRole('button', { name: 'Move question 1 down' }).click();
    const moved = await planPrompts(page);
    await page.getByRole('button', { name: `Take question ${offered} out of your plan` }).click();
    const trimmed = await planPrompts(page);
    await page.getByTestId('interviews-plan-save').click();
    await page.getByTestId('interviews-plan-note').waitFor({ timeout: 30_000 });
    const after = await read(hugo);
    await page.getByTestId('interviews-prepare-room').waitFor({ timeout: 30_000 });
    const chip = await textOf(page, 'interviews-prepare-state');
    const ok = offered >= 2 && before.length === offered && moved[0] === before[1] && moved[1] === before[0] && trimmed.length === offered - 1 && JSON.stringify(trimmed) === JSON.stringify(moved.slice(0, offered - 1))
      && after?.state === 'ready' && after?.questionsChosen?.length === offered - 1 && /Ready/i.test(chip);
    record('I1.7b', ok, `${offered} added (the bank offered that many), the first moved down, the last taken out, saved: ${trimmed.length} questions in that order; the round is ${after?.state} (chip "${chip}") and Open the room is shown`);
  } catch (e) { record('I1.7b', false, `plan: ${e.message.split('\n')[0]}`); }

  // ── I1.7c ──
  try {
    const cleared = await setTime(greta, id, null);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    const missing = await textOf(page, 'interviews-prepare-missing');
    const room = await page.getByTestId('interviews-prepare-room').count();
    const after = await read(hugo);
    record('I1.7c', cleared.status === 200 && after?.state === 'accepted' && /Waiting for a time/.test(missing) && room === 0 && after?.questionsChosen?.length === offered - 1,
      `time cleared (${cleared.status}): round ${after?.state}, the plan kept (${after?.questionsChosen?.length}), line "${missing}", Open the room ${room ? 'still shown' : 'gone'}`);
  } catch (e) { record('I1.7c', false, `cleared time: ${e.message.split('\n')[0]}`); }

  // ── I1.7d ──
  try {
    const pp = await hugo.newPage();
    await pp.goto(`${portal}/interviews/rounds/${SEED.panelInterview}/prepare`, { waitUntil: 'domcontentloaded' });
    await ready(pp);
    const line = await textOf(pp, 'interviews-prepare-readonly');
    const controls = (await pp.getByTestId('interviews-plan-save').count()) + (await pp.getByTestId('interviews-bank-add').count()) + (await pp.getByTestId('interviews-draft-ask').count());
    const write = await api(hugo, 'PUT', `/api/interviews/interviews/${SEED.panelInterview}/questions`, { revision: (await read(hugo, SEED.panelInterview)).revision, questionIds: [] });
    await pp.close();
    record('I1.7d', /chooses the questions/.test(line) && controls === 0 && write.status === 403, `panel member reads "${line}"; ${controls} editing controls; a write answers ${write.status}`);
  } catch (e) { record('I1.7d', false, `panel member: ${e.message.split('\n')[0]}`); }

  // ── I1.7e ──
  try {
    const other = await hugo.newPage();
    await other.goto(url, { waitUntil: 'domcontentloaded' });
    await ready(other);
    // The first page saves while the second still holds the old revision.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.getByTestId('interviews-bank-add').first().click();
    await page.getByTestId('interviews-plan-save').click();
    await page.getByTestId('interviews-plan-note').waitFor({ timeout: 30_000 });
    await other.getByTestId('interviews-bank-add').first().click();
    await other.getByTestId('interviews-plan-save').click();
    await other.getByTestId('interviews-plan-problem').waitFor({ timeout: 30_000 });
    const problem = await textOf(other, 'interviews-plan-problem');
    await other.waitForTimeout(1500);
    const shown = (await planPrompts(other)).length;
    const saved = (await read(hugo))?.questionsChosen?.length;
    await other.close();
    record('I1.7e', /Someone else|out of date|reload/i.test(problem) && shown === saved, `a stale save says "${problem.slice(0, 120)}"; the page then shows ${shown} questions and ${saved} are saved`);
  } catch (e) { record('I1.7e', false, `stale save: ${e.message.split('\n')[0]}`); }

  // ── I1.7f ──
  try {
    const bodies = [JSON.stringify(await read(hugo)), JSON.stringify(await read(greta)), await page.content()];
    const money = bodies.map((b) => /budgetCap|interviewCap|Usd|\$\s?\d/.test(b));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await ready(page);
    const crumbs = await page.getByRole('navigation', { name: /breadcrumb/i }).first().innerText().catch(() => '');
    await page.getByRole('navigation', { name: /breadcrumb/i }).first().getByText('My interviews').first().click();
    await page.waitForURL(/\/interviews\/my-interviews/, { timeout: 15_000 });
    record('I1.7f', money.every((m) => !m) && /My interviews/.test(crumbs) && /Nadia/.test(crumbs), `no money in the record the lead and the recruiter read or on the page; the trail "${crumbs.replace(/\s+/g, ' ')}" leads back to My interviews`);
  } catch (e) { record('I1.7f', false, `money and trail: ${e.message.split('\n')[0]}`); }

  void clock; void wen;
  for (const c of [hugo, greta, wen]) await c.close().catch(() => undefined);
  await resetMock();
}
