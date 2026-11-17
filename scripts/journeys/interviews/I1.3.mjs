// Piece I1.3: Openings and the kit editor (docs/interviews-tenant-plan.md row I1.3). It writes, so it puts the
// mock world back to its seeds first and again at the end (later pieces count the seeded rows).
//   I1.3a  the recruiter's Openings: three rows with the kit at a glance, dense at both widths
//   I1.3b  the recruiter adds a question in the kit editor, saves it through the composer's prompt, and sees it after a reload
//   I1.3c  the hiring manager reads the opening and the new question, read only, and their Openings are only their own
//   I1.3d  an interviewer cannot reach the editor (the no-access page) and the write is refused (403)
const NEW_QUESTION = 'Walk me through how you would add a second card network to the ledger without stopping captures.';

export default async function run({ portal, out, path, record, signIn, shoot, resetMock }) {
  await resetMock();

  const wideEnough = (shots) => shots.every((s) => !s.horizontalScroll);
  const shotLine = (shots) => shots.map((s) => `@${s.width}: first row at ${s.firstRowTop}px${s.horizontalScroll ? ', scrolls sideways' : ''}`).join('; ');

  // ── I1.3a: Openings ─────────────────────────────────────────────────────
  const greta = await signIn('u-greta');
  const page = await greta.newPage();
  try {
    await page.goto(`${portal}/interviews/openings`, { waitUntil: 'domcontentloaded' });
    const table = page.getByTestId('interviews-openings-table');
    await table.getByText('Senior Backend Engineer', { exact: true }).waitFor({ timeout: 30_000 });
    const titles = (await table.getByTestId('interviews-opening-title').allInnerTexts()).map((s) => s.trim());
    const kits = (await table.getByTestId('interviews-opening-kit').allInnerTexts()).map((s) => s.trim());
    const text = await table.innerText();
    const shots = await shoot(page, 'recruiter-openings', 'interviews-openings-table');
    const ok = titles.length === 3 && ['Engineering Manager', 'iOS Engineer', 'Senior Backend Engineer'].every((t) => titles.includes(t))
      && kits.includes('3 rounds · 6 questions') && /Not named yet/.test(text) && /Interviewing \d/.test(text)
      && !/\b(op|rd|q)-[a-z]/.test(text) && shots.every((s) => s.ok);
    record('I1.3a', ok, `recruiter's Openings: ${JSON.stringify(titles)}; kits ${JSON.stringify(kits)}; ${shotLine(shots)}`);
  } catch (e) {
    record('I1.3a', false, `Openings did not load: ${e.message.split('\n')[0]}`);
  }

  // ── I1.3b: the kit editor, saved through the prompt, seen after a reload ─
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${portal}/interviews/openings`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-openings-table').getByText('Senior Backend Engineer', { exact: true }).click();
    await page.waitForURL(/\/interviews\/openings\/op-backend$/, { timeout: 30_000 });
    await page.getByTestId('interviews-opening-edit').click();
    await page.waitForURL(/\/interviews\/openings\/op-backend\/edit$/, { timeout: 30_000 });
    const editor = page.getByTestId('interviews-kit-editor');
    await editor.waitFor({ timeout: 30_000 });
    const before = await editor.getByTestId('interviews-kit-question-prompt').count();
    await page.getByTestId('interviews-kit-add-question').click();
    const form = page.getByTestId('interviews-kit-question-form');
    await form.waitFor({ timeout: 10_000 });
    await form.getByTestId('interviews-kit-question-prompt-input').fill(NEW_QUESTION);
    await form.getByTestId('interviews-kit-add-followup').click();
    await form.getByLabel('Follow-up 1', { exact: true }).fill('Which part would you ship first?');
    const shots = [];
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => ({ horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }));
      await page.screenshot({ path: path.join(out, `interviews-kit-editor-${width}.png`) });
      shots.push({ width, firstRowTop: 'n/a', ...g });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const unsaved = (await page.getByTestId('interviews-opening-editor').innerText()).includes('Unsaved changes');
    await page.getByTestId('interviews-opening-save').click();
    const deck = page.getByTestId('collection-command-composer-prompts');
    await deck.getByText(/Save these changes\?/).waitFor({ timeout: 10_000 });
    const asked = await deck.innerText();
    await deck.getByRole('button', { name: /\bSave\b/ }).first().click();
    await page.getByTestId('interviews-opening-editor').getByText('Saved', { exact: true }).waitFor({ timeout: 15_000 });
    // Reload the opening as anyone would: the question is in the saved kit.
    await page.goto(`${portal}/interviews/openings/op-backend`, { waitUntil: 'domcontentloaded' });
    const technical = page.getByTestId('interviews-kit-technical-questions');
    await technical.getByText(NEW_QUESTION, { exact: true }).waitFor({ timeout: 30_000 });
    const after = await page.getByTestId('interviews-question-prompt').count();
    const ok = unsaved && /1 question added/.test(asked) && after === before + 1 && wideEnough(shots);
    record('I1.3b', ok, `editor: ${before} questions, one added with a follow-up; the prompt asked "${asked.replace(/\s+/g, ' ').slice(0, 120)}"; after a reload ${after} questions with the new one; editor ${shotLine(shots)}`);
  } catch (e) {
    record('I1.3b', false, `kit editor: ${e.message.split('\n')[0]}`);
  }
  await greta.close();

  // ── I1.3c: the hiring manager reads it, read only ───────────────────────
  {
    const amara = await signIn('u-amara');
    const p = await amara.newPage();
    try {
      await p.goto(`${portal}/interviews/openings/op-backend`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('interviews-kit-technical-questions').getByText(NEW_QUESTION, { exact: true }).waitFor({ timeout: 30_000 });
      const readOnly = await p.getByTestId('interviews-opening-readonly').isVisible();
      const editButtons = await p.getByTestId('interviews-opening-edit').count();
      await p.goto(`${portal}/interviews/openings`, { waitUntil: 'domcontentloaded' });
      const table = p.getByTestId('interviews-openings-table');
      await table.getByText('Engineering Manager', { exact: true }).waitFor({ timeout: 30_000 });
      const titles = (await table.getByTestId('interviews-opening-title').allInnerTexts()).map((s) => s.trim());
      const newButtons = await p.getByTestId('interviews-new-opening').count();
      const write = await amara.request.put(`${portal}/api/interviews/openings/op-backend/details`, { data: { revision: 2, title: 'x' } });
      const ok = readOnly && editButtons === 0 && newButtons === 0 && titles.length === 2 && !titles.includes('iOS Engineer') && write.status() === 403;
      record('I1.3c', ok, `hiring manager sees the new question read only (no Edit kit, no New opening); their Openings ${JSON.stringify(titles)}; a write answers ${write.status()}`);
    } catch (e) {
      record('I1.3c', false, `hiring manager: ${e.message.split('\n')[0]}`);
    }
    await amara.close();
  }

  // ── I1.3d: an interviewer cannot reach the editor ───────────────────────
  {
    const hugo = await signIn('u-hugo');
    const p = await hugo.newPage();
    try {
      await p.goto(`${portal}/interviews/openings/op-backend/edit`, { waitUntil: 'domcontentloaded' });
      await p.getByTestId('no-access').waitFor({ timeout: 30_000 });
      const editors = await p.getByTestId('interviews-kit-editor').count();
      const kit = (await (await hugo.request.get(`${portal}/api/interviews/openings/op-backend`)).json()).opening;
      const write = await hugo.request.put(`${portal}/api/interviews/openings/op-backend/kit`, {
        data: { revision: kit.revision, kit: { rounds: kit.rounds, competencies: kit.competencies, questions: [] } },
      });
      const body = await write.json().catch(() => ({}));
      const ok = editors === 0 && write.status() === 403 && body.action === 'ManageCandidates';
      record('I1.3d', ok, `interviewer at the edit route sees the no-access page; their write answers ${write.status()} (${body.action ?? 'no action named'})`);
    } catch (e) {
      record('I1.3d', false, `interviewer: ${e.message.split('\n')[0]}`);
    }
    await hugo.close();
  }

  await resetMock();
}
