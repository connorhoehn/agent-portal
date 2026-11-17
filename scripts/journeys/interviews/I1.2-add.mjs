// Piece I1.2-add: Add a candidate (no ledger row of its own; judged under I1.2). It writes, so it puts the mock world back to its
// seeds first and again at the end. An invented name and an @example.com address only.
//   I1.2e  Greta adds a candidate: the profile opens, the stage history has one entry, and the row is in Candidates at the first stage
//   I1.2f  the same email again (another case) reads the duplicate sentence on the email field and adds nobody
//   I1.2g  a bad field reads its own sentence and adds nobody
//   I1.2h  the hiring manager and an interviewer have no Add button; the address shows the no-access page
//   I1.2i  the form at 1440 and 1280 fits without sideways scrolling
const NAME = 'Odalys Brightwater';
const EMAIL = 'odalys.brightwater@example.com';

export default async function run({ portal, SEED, record, signIn, resetMock, api, shootPage }) {
  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const amara = await signIn(SEED.cast.hiringManager);
  const hugo = await signIn(SEED.cast.interviewer);
  const g = await greta.newPage();
  const pick = async (page, testId, name) => { await page.getByTestId(testId).click(); await page.getByRole('option', { name }).click(); };
  const open = async () => {
    await g.goto(`${portal}/interviews/candidates/new`, { waitUntil: 'domcontentloaded' });
    await g.getByTestId('interviews-new-candidate-form').waitFor({ timeout: 30_000 });
  };
  const submit = async () => {
    await g.getByTestId('interviews-new-candidate-create').click();
    const deck = g.getByTestId('collection-command-composer-prompts');
    await deck.getByText(/Add .* as a candidate/).waitFor({ timeout: 10_000 });
    await deck.getByRole('button', { name: /Add candidate/ }).first().click();
  };
  const fill = async (name, email) => {
    await g.getByTestId('interviews-candidate-name').fill(name);
    await g.getByTestId('interviews-candidate-email').fill(email);
    await pick(g, 'interviews-candidate-opening', /Senior Backend Engineer/);
  };

  try {
    await open();
    await fill(NAME, EMAIL);
    await submit();
    await g.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
    const url = new URL(g.url()).pathname;
    await g.getByTestId('interviews-profile-tab-activity').click();
    await g.getByTestId('interviews-profile-history').waitFor({ timeout: 30_000 });
    const list = (await api(greta, 'GET', '/api/interviews/candidates')).body?.items ?? [];
    const row = list.find((r) => r.candidate?.name === NAME);
    const moves = await g.getByTestId('interviews-profile-history').getByRole('row').count();
    record('I1.2e', /\/interviews\/candidates\/[^/]+$/.test(url) && url !== '/interviews/candidates/new' && !!row && row.stage === 'applied' && moves === 2,
      `the profile opened at ${url}; the list row is at stage ${row?.stage}; history rows (with the header) ${moves}`);
  } catch (e) { record('I1.2e', false, `adding: ${e.message.split('\n')[0]}`); }

  try {
    await open();
    await fill(NAME, EMAIL.toUpperCase());
    await submit();
    const field = await g.getByText('This person is already a candidate for this opening.').first().waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
    const stillThere = g.url().includes('/candidates/new');
    const rows = ((await api(greta, 'GET', '/api/interviews/candidates')).body?.items ?? []).filter((r) => r.candidate?.name === NAME).length;
    record('I1.2f', field && stillThere && rows === 1, `duplicate sentence shown: ${field}; still on the form: ${stillThere}; rows for the name: ${rows}`);
  } catch (e) { record('I1.2f', false, `duplicate: ${e.message.split('\n')[0]}`); }

  try {
    await open();
    await fill('Pellam Ashgrove', 'not-an-email');
    await submit();
    await g.waitForTimeout(800);
    const stillThere = g.url().includes('/candidates/new');
    const rows = ((await api(greta, 'GET', '/api/interviews/candidates')).body?.items ?? []).filter((r) => r.candidate?.name === 'Pellam Ashgrove').length;
    const problem = await g.getByTestId('interviews-new-candidate-form').innerText();
    record('I1.2g', stillThere && rows === 0 && /\.$/m.test(problem) && /valid|email/i.test(problem), `a bad email adds nobody (${rows} rows); still on the form: ${stillThere}; the form says ${JSON.stringify(problem.replace(/\s+/g, ' ').slice(-200))}`);
  } catch (e) { record('I1.2g', false, `bad field: ${e.message.split('\n')[0]}`); }

  try {
    const out = [];
    for (const [who, ctx] of [['hiring manager', amara], ['interviewer', hugo]]) {
      const p = await ctx.newPage();
      await p.goto(`${portal}/interviews/${who === 'interviewer' ? 'my-interviews' : 'my-openings'}`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('interviews-my-interviews-table').or(p.getByTestId('interviews-my-openings-table')).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      const button = await p.getByTestId('interviews-add-candidate').count();
      await p.goto(`${portal}/interviews/candidates/new`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1500);
      const form = await p.getByTestId('interviews-new-candidate-form').count();
      out.push({ who, button, form, noAccess: (await p.getByTestId('no-access').count()) > 0 });
      await p.close();
    }
    record('I1.2h', out.every((o) => o.button === 0 && o.form === 0 && o.noAccess), `${JSON.stringify(out)}`);
  } catch (e) { record('I1.2h', false, `no Add for others: ${e.message.split('\n')[0]}`); }

  try {
    await open();
    const sizes = [];
    for (const width of [1440, 1280]) {
      await g.setViewportSize({ width, height: 900 });
      await g.waitForTimeout(300);
      sizes.push(await g.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    }
    await g.setViewportSize({ width: 1440, height: 900 });
    await shootPage(g, 'interviews-new-candidate');
    record('I1.2i', sizes.every(Boolean), `no sideways scroll at 1440 and 1280: ${JSON.stringify(sizes)}`);
  } catch (e) { record('I1.2i', false, `widths: ${e.message.split('\n')[0]}`); }

  for (const c of [greta, amara, hugo]) await c.close().catch(() => undefined);
  await resetMock();
}
