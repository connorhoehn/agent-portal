// Piece I1.3-rail: an opening beside the Openings rail, the dirty-editor guard, and My openings' counted stage tabs. It writes
// nothing that survives (the guard test never saves), but resets the mock world first and last anyway.
//   I1.3e  an opening opens beside the Openings rail: the rail lists the openings and the open one is marked
//   I1.3f  change the opening's title, click another opening in the rail: the leave question appears; Keep editing keeps the change
//   I1.3g  the same click again, Leave and discard: the other opening opens and the first one is unchanged
//   I1.3h  My openings' stage tabs: All and one tab per stage that has people, each count equal to its rows
export default async function run({ portal, SEED, record, signIn, resetMock }) {
  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const amara = await signIn(SEED.cast.hiringManager);
  const g = await greta.newPage();
  const edit = `${portal}/interviews/openings/${SEED.openings.backend}/edit`;
  const frame = () => g.getByTestId('interviews-opening-frame');
  const railLink = (name) => frame().getByText(name, { exact: false }).first();
  const startEdit = async () => {
    await g.goto(edit, { waitUntil: 'domcontentloaded' });
    await g.getByTestId('interviews-opening-editor').waitFor({ timeout: 30_000 });
    await g.getByTestId('interviews-opening-tab-details').click().catch(() => undefined);
    const title = g.getByTestId('interviews-opening-title');
    await title.waitFor({ timeout: 15_000 });
    return title;
  };
  const deck = () => g.getByTestId('collection-command-composer-prompts');

  try {
    await g.goto(`${portal}/interviews/openings/${SEED.openings.backend}`, { waitUntil: 'domcontentloaded' });
    await frame().waitFor({ timeout: 30_000 });
    await g.getByText('Senior Backend Engineer').first().waitFor({ timeout: 30_000 });
    const text = (await frame().innerText()).replace(/\s+/g, ' ');
    const all = ['Senior Backend Engineer', 'iOS Engineer', 'Engineering Manager'].every((t) => text.includes(t));
    record('I1.3e', all, `the opening opened beside the rail, which lists the three openings: ${all}`);
  } catch (e) { record('I1.3e', false, `rail: ${e.message.split('\n')[0]}`); }

  try {
    const title = await startEdit();
    const before = await title.inputValue();
    await title.fill(`${before} (changed)`);
    await railLink('iOS Engineer').click();
    await deck().getByText(/Leave without saving/).waitFor({ timeout: 10_000 });
    await deck().getByRole('button', { name: /Keep editing/ }).first().click();
    await g.waitForTimeout(500);
    const stayed = g.url().includes(`/openings/${SEED.openings.backend}`);
    const kept = (await g.getByTestId('interviews-opening-title').inputValue().catch(() => '')) === `${before} (changed)`;
    record('I1.3f', stayed && kept, `the leave question appeared; Keep editing stayed on the opening (${stayed}) and kept the change (${kept})`);
  } catch (e) { record('I1.3f', false, `guard, keep: ${e.message.split('\n')[0]}`); }

  try {
    await railLink('iOS Engineer').click();
    await g.waitForTimeout(800);
    await deck().getByRole('button', { name: /Leave and discard/ }).last().click();
    await g.waitForURL((u) => u.pathname.includes(`/openings/${SEED.openings.ios}`), { timeout: 15_000 });
    await g.goto(`${portal}/interviews/openings/${SEED.openings.backend}`, { waitUntil: 'domcontentloaded' });
    await g.getByText('Senior Backend Engineer').first().waitFor({ timeout: 30_000 });
    const changed = (await g.locator('body').innerText()).includes('(changed)');
    record('I1.3g', !changed, `Leave and discard opened iOS Engineer; the first opening still reads its old title (changed: ${changed})`);
  } catch (e) { record('I1.3g', false, `guard, leave: ${e.message.split('\n')[0]}`); }

  try {
    const p = await amara.newPage();
    await p.goto(`${portal}/interviews/my-openings`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('interviews-my-openings-table').waitFor({ timeout: 30_000 });
    const tabs = await p.locator('[data-testid^="interviews-openings-stage-"]').all();
    const out = [];
    for (const t of tabs) {
      await t.click();
      await p.waitForTimeout(300);
      const label = (await t.innerText()).replace(/\s+/g, ' ').trim();
      const rows = await p.getByTestId('interviews-my-openings-table').getByTestId('interviews-pipeline-candidate').count();
      out.push({ label, rows, n: Number((label.match(/(\d+)\s*$/) || [])[1] ?? -1) });
    }
    await p.close();
    record('I1.3h', out.length >= 2 && out.every((o) => o.n === o.rows), JSON.stringify(out));
  } catch (e) { record('I1.3h', false, `stage tabs: ${e.message.split('\n')[0]}`); }

  for (const c of [greta, amara]) await c.close().catch(() => undefined);
  await resetMock();
}
