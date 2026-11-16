// Piece I0: the three homes and the access rules (steps I0.5a to I0.5g). Each piece's default export receives
// the shared context from interviews/lib.mjs.
export default async function run({ portal, record, signIn, namesIn, shoot, homes }) {
  // ── I0.5a: the recruiter ────────────────────────────────────────────────
  {
    const context = await signIn('u-greta');
    const page = await context.newPage();
    await page.goto(`${portal}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/interviews\/candidates$/, { timeout: 30_000 });
    const names = await namesIn(page, 'interviews-candidates-table', 'interviews-candidate-name', 'Mateo Álvarez');
    const want = ['Mateo Álvarez', 'Ingrid Solberg', 'Aiko Tanaka', 'Ravi Menon', 'Nadia Petrova', 'Jonah Whitaker', 'Chloé Martin', 'Elif Demir'];
    const text = await page.getByTestId('interviews-candidates-table').innerText();
    const ok = names.length === 12 && want.every((n) => names.includes(n)) && /System design · Tomorrow \d\d:\d\d/.test(text) && /Yes · Coding/.test(text)
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
    const names = await namesIn(page, 'interviews-my-interviews-table', 'interviews-desk-candidate', 'Kwame Asante');
    const states = (await page.getByTestId('interviews-my-interviews-table').getByTestId('interviews-desk-state').allInnerTexts()).map((s) => s.trim());
    const others = ['Aiko Tanaka', 'Ravi Menon', 'Jonah Whitaker'];
    const ok = names.length === 4 && ['Kwame Asante', 'Mateo Álvarez', 'Nadia Petrova'].every((n) => names.includes(n)) && others.every((n) => !names.includes(n))
      && states[0] === 'Accept or decline';
    record('I0.5b', ok, `interviewer lands on ${new URL(page.url()).pathname}; desk rows ${JSON.stringify(names)}; first waits for "${states[0]}"; none of ${others.join(', ')}`);
    homes.push({ name: 'interviewer-my-interviews', shots: await shoot(page, 'interviewer-my-interviews', 'interviews-my-interviews-table') });

    const theirs = await context.request.get(`${portal}/api/interviews/interviews/iv-aiko-coding`);
    const mine = await context.request.get(`${portal}/api/interviews/interviews/iv-mateo-design`);
    const theirCandidate = await context.request.get(`${portal}/api/interviews/candidates/cand-aiko`);
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
    const names = await namesIn(page, 'interviews-my-interviews-table', 'interviews-desk-candidate', 'Jonah Whitaker');
    const text = await page.getByTestId('interviews-my-interviews-table').innerText();
    const ok = names.includes('Jonah Whitaker') && /Scorecard due/.test(text) && !names.includes('Kwame Asante') && !names.includes('Mateo Álvarez');
    record('I0.5c', ok, `second interviewer's desk ${JSON.stringify(names)}; a scorecard due; none of Hugo's alone`);
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
}
