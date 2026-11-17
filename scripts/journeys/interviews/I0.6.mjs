// Piece I0.6: an opening's money (row I0.6). The recruiter reads and edits both caps (they survive a reload), the hiring manager
// of the opening reads the line with no edit, an interviewer sees no line and the API sends them no cap.
//   I0.6a  the recruiter reads the money line on the Backend opening: the cap, what is spent and the cap per interview
//   I0.6b  the recruiter edits both caps and saves; after a reload the line shows the new numbers
//   I0.6c  the hiring manager reads the line and has no Edit control
//   I0.6d  an interviewer sees no money line, and the opening record the API sends carries no cap
//   I0.6e  screenshots of the opening at 1440 and 1280
export default async function run({ portal, SEED, record, signIn, resetMock, api, shootPage }) {
  await resetMock();
  const op = SEED.openings.backend;
  const url = `${portal}/interviews/openings/${op}`;
  const greta = await signIn(SEED.cast.recruiter);
  const amara = await signIn(SEED.cast.hiringManager);
  const hugo = await signIn(SEED.cast.interviewer);
  const line = async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-opening-meta').waitFor({ timeout: 30_000 });
    const el = page.getByTestId('interviews-opening-money');
    if (!(await el.count().catch(() => 0))) return null;
    await el.waitFor({ timeout: 15_000 }).catch(() => undefined);
    return (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  };
  const g = await greta.newPage();

  try {
    const text = await line(g);
    record('I0.6a', !!text && /Spending cap \$\d/.test(text) && /per interview/.test(text), `the recruiter reads: ${JSON.stringify(text)}`);
  } catch (e) { record('I0.6a', false, `money line: ${e.message.split('\n')[0]}`); }

  try {
    await g.goto(`${url}/edit`, { waitUntil: 'domcontentloaded' });
    await g.getByTestId('interviews-opening-tab-details').click();
    const cap = g.getByTestId('interviews-opening-budget-cap');
    await cap.waitFor({ timeout: 30_000 });
    await cap.fill('240');
    await g.getByTestId('interviews-opening-interview-cap').fill('12');
    await g.getByTestId('interviews-opening-save').click();
    const deck = g.getByTestId('collection-command-composer-prompts');
    await deck.getByText(/Save these changes\?/).waitFor({ timeout: 10_000 });
    await deck.getByRole('button', { name: /\bSave\b/ }).first().click();
    await g.getByTestId('interviews-opening-editor').getByText('Saved', { exact: true }).waitFor({ timeout: 15_000 });
    const text = await line(g);
    record('I0.6b', !!text && /Spending cap \$240/.test(text) && /\$12(\.00)? per interview/.test(text) && !/the default/.test(text), `after a reload the recruiter reads: ${JSON.stringify(text)}`);
  } catch (e) { record('I0.6b', false, `editing the caps: ${e.message.split('\n')[0]}`); }

  try {
    const p = await amara.newPage();
    const text = await line(p);
    const edit = await p.getByTestId('interviews-opening-edit').count();
    record('I0.6c', !!text && /Spending cap \$240/.test(text) && edit === 0, `the hiring manager reads ${JSON.stringify(text)}; Edit controls: ${edit}`);
    await p.close();
  } catch (e) { record('I0.6c', false, `hiring manager: ${e.message.split('\n')[0]}`); }

  try {
    const p = await hugo.newPage();
    const text = await line(p);
    const rec = await api(hugo, 'GET', `/api/interviews/openings/${op}`);
    const money = await api(hugo, 'GET', `/api/interviews/openings/${op}/spend`);
    const mine = JSON.stringify(rec.body ?? {});
    const recruiterRec = JSON.stringify((await api(greta, 'GET', `/api/interviews/openings/${op}`)).body ?? {});
    record('I0.6d', text === null && !/budgetCapUsd/.test(mine) && /budgetCapUsd/.test(recruiterRec) && money.status === 404,
      `the interviewer's line ${JSON.stringify(text)}; the record has a cap: ${/budgetCapUsd/.test(mine)} (status ${rec.status}); the recruiter's record has one: ${/budgetCapUsd/.test(recruiterRec)}; spend read ${money.status}`);
    await p.close();
  } catch (e) { record('I0.6d', false, `interviewer: ${e.message.split('\n')[0]}`); }

  try {
    await g.goto(url, { waitUntil: 'domcontentloaded' });
    await g.getByTestId('interviews-opening-money').waitFor({ timeout: 30_000 });
    await shootPage(g, 'interviews-opening-money');
    record('I0.6e', true, 'screenshots of the opening with its money line at 1440 and 1280');
  } catch (e) { record('I0.6e', false, `screenshots: ${e.message.split('\n')[0]}`); }

  for (const c of [greta, amara, hugo]) await c.close().catch(() => undefined);
  await resetMock();
}
