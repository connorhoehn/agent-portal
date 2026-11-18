// Piece I1.1-desks: My interviews as Hugo and Wen (interviewers) and the address as Greta (recruiter). Reads only.
//   I1.1b  Hugo: the live round is first under Upcoming with Live now and Join and nothing else on its row; every tab opened, its count equal to its rows
//   I1.1c  Wen: every tab opened, its count equal to its rows
//   I1.1d  no tab scrolls sideways at 1280 (scrollWidth against clientWidth on the page and on the table's scroller), for Hugo and Wen
//   I1.1e  Greta (recruiter) has no desk: the address shows the no-access page
const TABS = ['to-accept', 'to-prepare', 'upcoming', 'scorecard-due', 'done'];

export default async function run({ portal, SEED, record, signIn }) {
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const greta = await signIn(SEED.cast.recruiter);
  const open = async (ctx, width = 1440) => {
    const p = await ctx.newPage();
    await p.setViewportSize({ width, height: 900 });
    await p.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('interviews-my-interviews-table').waitFor({ timeout: 30_000 });
    return p;
  };
  const tabs = async (p) => {
    const out = {};
    for (const id of TABS) {
      const tab = p.getByTestId(`interviews-desk-tab-${id}`);
      await tab.click();
      await p.waitForFunction((t) => document.querySelector(`[data-testid="interviews-desk-tab-${t}"]`)?.getAttribute('aria-selected') === 'true', id, { timeout: 10_000 });
      await p.waitForTimeout(300);
      const label = ((await tab.innerText()).replace(/\s+/g, ' ')).trim();
      const rows = await p.getByTestId('interviews-my-interviews-table').getByTestId('interviews-desk-candidate').count();
      const shown = (label.match(/(\d+)\s*$/) || [])[1];
      const sideways = await p.evaluate(() => {
        const doc = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        const t = document.querySelector('[data-testid="interviews-my-interviews-table"]');
        const scrollers = t ? [t, ...t.querySelectorAll('*')].filter((e) => e.scrollWidth > e.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(e).overflowX)) : [];
        return doc || scrollers.length > 0;
      });
      out[id] = { label, rows, shown: shown === undefined ? null : Number(shown), sideways };
    }
    return out;
  };
  const countsMatch = (by) => TABS.every((id) => by[id].shown === null ? by[id].rows >= 0 : by[id].shown === by[id].rows);

  try {
    const p = await open(hugo);
    await p.getByTestId('interviews-desk-tab-upcoming').click();
    await p.waitForTimeout(400);
    const first = p.getByTestId('interviews-my-interviews-table').locator('tbody tr').first();
    const name = (await first.getByTestId('interviews-desk-candidate').innerText()).trim().split('\n').pop().trim();
    const live = await first.getByTestId('interviews-desk-live').count();
    const join = await first.getByTestId('interviews-desk-join').count();
    const others = await first.locator('button, a').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') || e.textContent || '').trim()).filter((t) => t && !t.includes(name) && !/join|candidate|live/i.test(t)));
    const by = await tabs(p);
    await p.close();
    record('I1.1b', name === 'Kwame Asante' && live === 1 && join === 1 && others.length === 0 && countsMatch(by),
      `first row under Upcoming: ${name}, Live now ${live}, Join ${join}, other controls ${JSON.stringify(others)}; tabs ${JSON.stringify(Object.fromEntries(TABS.map((t) => [t, `${by[t].label} / ${by[t].rows} rows`])))}`);
  } catch (e) { record('I1.1b', false, `Hugo's desk: ${e.message.split('\n')[0]}`); }

  try {
    const p = await open(wen);
    const by = await tabs(p);
    await p.close();
    record('I1.1c', countsMatch(by), `Wen's tabs ${JSON.stringify(Object.fromEntries(TABS.map((t) => [t, `${by[t].label} / ${by[t].rows} rows`])))}`);
  } catch (e) { record('I1.1c', false, `Wen's desk: ${e.message.split('\n')[0]}`); }

  try {
    const bad = [];
    for (const [who, ctx] of [['Hugo', hugo], ['Wen', wen]]) {
      const p = await open(ctx, 1280);
      const by = await tabs(p);
      for (const id of TABS) if (by[id].sideways) bad.push(`${who}/${id}`);
      await p.close();
    }
    record('I1.1d', bad.length === 0, bad.length ? `sideways scroll at 1280 on ${bad.join(', ')}` : 'no tab scrolls sideways at 1280 for Hugo or Wen');
  } catch (e) { record('I1.1d', false, `widths: ${e.message.split('\n')[0]}`); }

  try {
    const p = await greta.newPage();
    await p.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    const refused = await p.getByTestId('no-access').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    await p.close();
    record('I1.1e', refused, `the recruiter at My interviews sees the no-access page: ${refused}`);
  } catch (e) { record('I1.1e', false, `recruiter at the desk: ${e.message.split('\n')[0]}`); }

  for (const c of [hugo, wen, greta]) await c.close().catch(() => undefined);
}
