// Piece I1.2: the candidate profile. The recruiter opens one from Candidates and sees the header, the stage tracker, the
// history and the rounds; a hiring manager and an interviewer reach only the candidates theirs, and the others show the
// not-found page by address. Reads only, so the world stays as the seed had it.
export default async function run({ portal, out, path, record, signIn }) {
  // ── I1.2a: the recruiter, from the Candidates table ────────────────────
  {
    const context = await signIn('u-greta');
    const page = await context.newPage();
    await page.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    const table = page.getByTestId('interviews-candidates-table');
    await table.getByText('Ingrid Solberg', { exact: true }).first().waitFor({ timeout: 30_000 });
    await table.getByRole('link', { name: 'Ingrid Solberg' }).first().click();
    await page.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
    await page.getByTestId('interviews-profile-rounds').getByTestId('interviews-profile-round').first().waitFor({ timeout: 30_000 });
    const url = new URL(page.url()).pathname;
    const header = await page.getByTestId('interviews-profile-header').innerText();
    const tracker = await page.getByTestId('interviews-profile-tracker').innerText();
    const history = await page.getByTestId('interviews-profile-history').innerText();
    const rounds = await page.getByTestId('interviews-profile-rounds').innerText();
    const crumbs = await page.locator('nav[aria-label*="readcrumb" i]').first().innerText().catch(() => '');
    const body = await page.getByTestId('interviews-candidate-profile').innerText();
    const roundCount = await page.getByTestId('interviews-profile-rounds').getByTestId('interviews-profile-round').count();
    const ok = /^\/interviews\/candidates\/cand-ingrid$/.test(url)
      && /Senior Backend Engineer/.test(header) && /Applied/.test(header) && /Came from/.test(header)
      && /Interviewing/.test(tracker) && /Debrief/.test(tracker) && /Hired/.test(tracker)
      && /Interviewing/.test(history) && /Greta Lindqvist/.test(history)
      && roundCount === 2 && /Coding/.test(rounds) && /Working together/.test(rounds) && /Hugo Marchetti|Wen Zhao/.test(rounds)
      && /Yes|No/.test(rounds) && /Done|Scorecard due/.test(rounds)
      && /Hire/.test(crumbs) && /Candidates/.test(crumbs) && /Ingrid Solberg/.test(crumbs)
      && !/\b(cand|app|iv|op|sc)-[a-z]/.test(body);
    record('I1.2a', ok, `recruiter opened ${url} from the table: header ${/Came from/.test(header) ? 'with' : 'without'} its source, tracker ${/Debrief/.test(tracker) ? 'over the stages' : 'missing'}, history by name ${/Greta Lindqvist/.test(history)}, ${roundCount} rounds, breadcrumb "${crumbs.replace(/\s+/g, ' ').trim()}"`);
    // Screenshots at both widths: the rounds table must sit in view and the page must not scroll sideways.
    const shots = [];
    for (const width of [1440, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="interviews-profile-rounds"] tbody tr');
        return { roundsTop: row ? Math.round(row.getBoundingClientRect().top) : null, viewport: innerHeight, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      });
      await page.screenshot({ path: path.join(out, `interviews-candidate-profile-${width}.png`) });
      shots.push({ width, ...g, ok: g.roundsTop !== null && g.roundsTop < g.viewport && !g.sideways });
    }
    record('I1.2b', shots.every((s) => s.ok), shots.map((s) => `${s.width}: first round at ${s.roundsTop}px of ${s.viewport}${s.sideways ? ', scrolls sideways' : ''}`).join('; '));
    await context.close();
  }

  // ── I1.2c: the hiring manager ───────────────────────────────────────────
  {
    const context = await signIn('u-amara');
    const page = await context.newPage();
    await page.goto(`${portal}/interviews/my-openings`, { waitUntil: 'domcontentloaded' });
    const table = page.getByTestId('interviews-my-openings-table');
    await table.getByText('Ingrid Solberg', { exact: true }).first().waitFor({ timeout: 30_000 });
    await table.getByRole('link', { name: 'Ingrid Solberg' }).first().click();
    await page.getByTestId('interviews-profile-rounds').waitFor({ timeout: 30_000 });
    const own = new URL(page.url()).pathname;
    await page.goto(`${portal}/interviews/candidates/cand-aiko`, { waitUntil: 'domcontentloaded' });
    const missing = await page.getByTestId('record-not-found').waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const text = await page.locator('main').first().innerText().catch(() => '');
    const api = await context.request.get(`${portal}/api/interviews/candidates/cand-aiko`);
    record('I1.2c', own === '/interviews/candidates/cand-ingrid' && missing && /not found/i.test(text) && api.status() === 404,
      `hiring manager opened ${own} from My openings; the iOS candidate by address shows the not-found page ${missing} (API ${api.status()})`);
    await context.close();
  }

  // ── I1.2d: an interviewer ───────────────────────────────────────────────
  {
    const context = await signIn('u-hugo');
    const page = await context.newPage();
    await page.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    const table = page.getByTestId('interviews-my-interviews-table');
    await table.getByText('Mateo Álvarez', { exact: true }).first().waitFor({ timeout: 30_000 });
    await table.getByRole('link', { name: 'Mateo Álvarez' }).first().click();
    await page.getByTestId('interviews-profile-rounds').waitFor({ timeout: 30_000 });
    const own = new URL(page.url()).pathname;
    const rounds = await page.getByTestId('interviews-profile-rounds').innerText();
    await page.goto(`${portal}/interviews/candidates/cand-aiko`, { waitUntil: 'domcontentloaded' });
    const missing = await page.getByTestId('record-not-found').waitFor({ timeout: 30_000 }).then(() => true, () => false);
    record('I1.2d', /^\/interviews\/candidates\/cand-mateo$/.test(own) && rounds.trim().length > 0 && missing,
      `interviewer opened ${own} from My interviews; a candidate they do not interview shows the not-found page ${missing}`);
    await context.close();
  }
}
