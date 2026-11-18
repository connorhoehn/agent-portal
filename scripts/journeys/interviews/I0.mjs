// Piece I0: the three homes and the access rules (steps I0.5a to I0.5g). Each piece's default export receives
// the shared context from interviews/lib.mjs.
export default async function run({ portal, record, signIn, namesIn, shoot, homes }) {
  // ── I0.5a: the recruiter ────────────────────────────────────────────────
  // The seed counts days from UTC midnight and the page shows local time, so the next interview reads "Tomorrow 09:00"
  // or, in the hours after UTC midnight, a dated label ("Wed 18 Nov, 09:00"): either passes.
  {
    const context = await signIn('u-greta');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/candidates$/, { timeout: 30_000 });
    const names = await namesIn(page, 'interviews-candidates-table', 'interviews-candidate-name', 'Mateo Álvarez');
    const want = ['Mateo Álvarez', 'Ingrid Solberg', 'Aiko Tanaka', 'Ravi Menon', 'Nadia Petrova', 'Jonah Whitaker', 'Chloé Martin', 'Elif Demir'];
    const text = await page.getByTestId('interviews-candidates-table').innerText();
    const ok = names.length === 12 && want.every((n) => names.includes(n)) && /Coding · (Tomorrow|[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2},) \d\d:\d\d/.test(text) && /Yes · System design/.test(text)
      && !/\b(cand|app|iv|op|sc)-[a-z]/.test(text);
    record('I0.5a', ok, `recruiter lands on ${new URL(page.url()).pathname}; ${names.length} candidate rows; next interview and last result shown; no ids in the table`);
    homes.push({ name: 'recruiter-candidates', shots: await shoot(page, 'recruiter-candidates', 'interviews-candidates-table') });
    await context.close();
  }

  // ── I0.5b, I0.5d, I0.5e: Hugo, an interviewer ───────────────────────────
  {
    const context = await signIn('u-hugo');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-interviews$/, { timeout: 30_000 });
    // The desk is tabbed (To accept, To prepare, Upcoming, Scorecards due, Done) and opens on Upcoming while one of
    // the interviewer's rounds is live, with that round first: Live now and Join, nothing else to do on it.
    const landed = await deskTabSelected(page);
    await namesIn(page, 'interviews-my-interviews-table', 'interviews-desk-candidate', 'Kwame Asante');
    const firstRow = page.getByTestId('interviews-my-interviews-table').locator('tbody tr').first();
    const firstName = (await firstRow.getByTestId('interviews-desk-candidate').innerText()).trim().split('\n').pop().trim();
    const liveFirst = firstName === 'Kwame Asante' && await firstRow.getByTestId('interviews-desk-live').count() === 1
      && await firstRow.getByTestId('interviews-desk-join').count() === 1 && await firstRow.getByTestId('interviews-desk-accept').count() === 0;
    homes.push({ name: 'interviewer-my-interviews', shots: await shoot(page, 'interviewer-my-interviews', 'interviews-my-interviews-table') });
    const desk = await deskByTab(page);
    const names = [...new Set(Object.values(desk).flatMap((t) => t.names))];
    const others = ['Aiko Tanaka', 'Ravi Menon', 'Jonah Whitaker'];
    const ok = landed === 'upcoming' && liveFirst
      && ['Kwame Asante', 'Mateo Álvarez', 'Nadia Petrova', 'Ingrid Solberg'].every((n) => names.includes(n)) && others.every((n) => !names.includes(n))
      && desk['to-accept'].states[0] === 'Accept or decline' && desk['to-accept'].names[0] === 'Kwame Asante';
    record('I0.5b', ok, `interviewer lands on ${new URL(page.url()).pathname}, tab ${landed}; first row ${firstName}${liveFirst ? ' with Live now and Join' : ' WITHOUT Live now and Join alone'}; by tab ${JSON.stringify(desk)}; none of ${others.join(', ')}`);

    const theirs = await context.request.get(`${portal}/api/interviews/interviews/iv-c3k8w2ma`);
    const mine = await context.request.get(`${portal}/api/interviews/interviews/iv-k1p5w8ra`);
    const theirCandidate = await context.request.get(`${portal}/api/interviews/candidates/cand-s52jevud`);
    record('I0.5d', theirs.status() === 404 && theirCandidate.status() === 404 && mine.status() === 200,
      `another interviewer's interview by address: ${theirs.status()}, its candidate: ${theirCandidate.status()}; their own: ${mine.status()}`);

    await page.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-interviews$/, { timeout: 15_000 }).catch(() => {});
    const frontDoor = new URL(page.url()).pathname;
    await page.goto(`${portal}/interviews/my-openings`, { waitUntil: 'domcontentloaded' });
    const refused = await page.getByTestId('no-access').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    record('I0.5e', frontDoor === '/interviews/my-interviews' && refused && new URL(page.url()).pathname === '/interviews/my-openings',
      `the front door sends the interviewer to ${frontDoor}; the hiring manager's page shows the no-access page with its address kept`);
    await context.close();
  }

  // ── I0.5c: Wen, the second interviewer ──────────────────────────────────
  {
    const context = await signIn('u-wen');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-interviews$/, { timeout: 30_000 });
    const landed = await deskTabSelected(page);
    await namesIn(page, 'interviews-my-interviews-table', 'interviews-desk-candidate', 'Kwame Asante');
    const desk = await deskByTab(page);
    const names = [...new Set(Object.values(desk).flatMap((t) => t.names))];
    // Wen sits on Hugo's live round as the panel, so it is hers too; Mateo's rounds are Hugo's alone.
    const ok = landed === 'upcoming' && desk['scorecard-due'].names.includes('Jonah Whitaker') && desk['scorecard-due'].states.includes('Scorecard due')
      && names.includes('Kwame Asante') && !names.includes('Mateo Álvarez');
    record('I0.5c', ok, `second interviewer lands on tab ${landed}; by tab ${JSON.stringify(desk)}; Jonah's scorecard due; none of Hugo's alone`);
    await context.close();
  }

  // ── I0.5f: Amara, the hiring manager ────────────────────────────────────
  {
    const context = await signIn('u-amara');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/my-openings$/, { timeout: 30_000 });
    const names = await namesIn(page, 'interviews-my-openings-table', 'interviews-pipeline-candidate', 'Ingrid Solberg');
    const body = await page.getByTestId('interviews-my-openings').innerText();
    const iosCandidates = ['Aiko Tanaka', 'Ravi Menon', 'Chloé Martin', 'Samuel Adeyemi'];
    const openings = await (await context.request.get(`${portal}/api/interviews/openings`)).json();
    const titles = (openings.items ?? []).map((o) => o.title).sort();
    const ios = await context.request.get(`${portal}/api/interviews/openings/op-ios`);
    const ok = names.length === 8 && iosCandidates.every((n) => !names.includes(n)) && !/iOS Engineer/.test(body) && names[0] === 'Ingrid Solberg'
      && /8 candidates on 2 openings/.test(body) && /Scorecard due/.test(body)
      && JSON.stringify(titles) === JSON.stringify(['Engineering Manager', 'Senior Backend Engineer']) && ios.status() === 404;
    record('I0.5f', ok, `hiring manager lands on ${new URL(page.url()).pathname}; ${names.length} candidates on her openings ${JSON.stringify(titles)}, debrief first (${names[0]}), a scorecard due shown; the iOS opening by address: ${ios.status()}`);
    homes.push({ name: 'hiring-manager-my-openings', shots: await shoot(page, 'hiring-manager-my-openings', 'interviews-my-openings-table') });
    await context.close();
  }

  // ── I0.5g: a Work-only persona ───────────────────────────────────────────
  {
    const context = await signIn('u-theo');
    const page = await context.newPage();
    await page.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    const shown = await page.getByTestId('other-workspace').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const api = await context.request.get(`${portal}/api/interviews/candidates`);
    record('I0.5g', shown && new URL(page.url()).pathname === '/interviews/candidates' && api.status() === 403,
      `Work-only persona: other-workspace page ${shown ? 'shown' : 'missing'} at ${new URL(page.url()).pathname}; the API answers ${api.status()}`);
    await context.close();
  }

  /** The desk tab that is selected now ('to-accept', 'upcoming', …). */
  async function deskTabSelected(page) {
    const tab = page.locator('[data-testid^="interviews-desk-tab-"][aria-selected="true"]').first();
    await tab.waitFor({ timeout: 30_000 });
    return ((await tab.getAttribute('data-testid')) ?? '').replace('interviews-desk-tab-', '');
  }

  /** Every desk tab clicked in turn: its candidate names and its state chips, row by row. */
  async function deskByTab(page) {
    const out = {};
    for (const id of ['to-accept', 'to-prepare', 'upcoming', 'scorecard-due', 'done']) {
      await page.getByTestId(`interviews-desk-tab-${id}`).click();
      await page.waitForFunction((t) => document.querySelector(`[data-testid="interviews-desk-tab-${t}"]`)?.getAttribute('aria-selected') === 'true', id, { timeout: 10_000 });
      await page.waitForTimeout(300);
      const table = page.getByTestId('interviews-my-interviews-table');
      out[id] = {
        names: (await table.getByTestId('interviews-desk-candidate').allInnerTexts()).map((s) => s.trim().split('\n').pop().trim()),
        states: (await table.getByTestId('interviews-desk-state').allInnerTexts()).map((s) => s.trim()),
      };
    }
    return out;
  }
}
