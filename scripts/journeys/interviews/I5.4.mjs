// Piece I5.4: the recruiter's review and the debrief (docs/interviews-tenant-plan.md row I5.4; hardening lane H4). It writes
// nothing, but it widens the debrief's answer on the page (see I5.4d), so it resets the mock world first anyway.
//   I5.4a  the recruiter: Candidates → Ingrid's Last result → the debrief, with no decision deck; the rounds side by side, each
//          interviewer's rating and note, nothing averaged, no consent answer
//   I5.4b  the recap's disclosure agrees with the recap route (every statement and quote the route holds is what it shows)
//   I5.4c  "Open the record" opens the round's record
//   I5.4d  one table per application with a column group per round; at 1280 the Competency column stays in view when the table
//          is wider than the window (the page's layout, read with the answer widened to five scorecards)
// plus the table I5.4.404 (the runner adds that step).
import { consentIn, failing, miloScoresIn, seen, squash, why } from './h4-kit.mjs';

export default async function run(ctx) {
  const { SEED, portal, record, signIn, api, resetMock, shootPage } = ctx;
  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const page = await greta.newPage();
  const ingridId = SEED.candidates.ingrid;
  const debriefApi = (who, id) => api(who, 'GET', `/api/interviews/candidates/${id}/debrief`);
  const widths = (shots) => shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ''}`).join(' ');
  const truth = (await debriefApi(greta, ingridId)).body.debrief;
  const name = truth.candidate.name;
  const app = truth.applications[0];

  // ── I5.4a: Candidates → Last result → the debrief ─────────────────────────────────────────────────────────────────────
  try {
    await page.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    const table = page.getByTestId('interviews-candidates-table');
    await table.getByText(name, { exact: true }).first().waitFor({ timeout: 30_000 });
    await table.locator('tr', { hasText: name }).getByTestId('interviews-result-debrief').click();
    await page.waitForURL(new RegExp(`/interviews/candidates/${ingridId}/debrief$`), { timeout: 30_000 });
    await seen(page, 'interviews-debrief');
    await seen(page, 'interviews-debrief-side-by-side');
    await page.waitForTimeout(500);
    const text = squash(await page.getByTestId('interviews-debrief').innerText());
    const deckOptions = await page.locator('[data-composer-prompt-option]').count();
    const decideLine = await page.getByTestId('interviews-debrief-decide-line').count();
    const side = squash(await page.getByTestId('interviews-debrief-side-by-side').innerText());
    const people = app.rounds.flatMap((r) => r.scorecards.map((s) => s.interviewer.name));
    const shots = await shootPage(page, 'debrief-recruiter');
    const checks = {
      noDeck: deckOptions === 0, noDecideLine: decideLine === 0, routeOffersNone: app.decide === null, people: people.every((n) => side.includes(n)), ratings: /of 4/.test(side), rounds: app.rounds.length === 2,
      noAverage: !/\b(average|total|overall score|rank)\b/i.test(text), consent: !consentIn(text), milo: !miloScoresIn(text), shots: shots.every((s) => s.ok),
    };
    const ok = Object.values(checks).every(Boolean);
    record('I5.4a', ok, `[failing: ${failing(checks)}] ${name}: debrief reached from Last result; ${deckOptions} decision options, decide line ${decideLine}; ${app.rounds.length} rounds, scorecards by ${people.join(', ')}; nothing averaged or ranked; ${widths(shots)}`);
  } catch (e) { record('I5.4a', false, `the recruiter's debrief: ${why(e)}`); }

  // ── I5.4b: the recap's disclosure agrees with the route ───────────────────────────────────────────────────────────────
  try {
    let round = null;
    let route = null;
    for (const r of app.rounds) {
      const got = (await api(greta, 'GET', r.recapPath)).body?.recap;
      if (got?.state === 'ready') { round = r; route = got; break; }
    }
    if (!round) throw new Error('no round of this candidate has a recap that is ready');
    const block = page.getByTestId('interviews-debrief-round').filter({ hasText: round.name }).first();
    await block.getByTestId('interviews-debrief-recap').click();
    await page.waitForTimeout(1200);
    const shown = squash(await block.getByTestId('interviews-debrief-recap').innerText());
    const evidence = route.competencies.flatMap((c) => c.evidence);
    const allShown = evidence.every((e) => shown.includes(squash(e.text)) && shown.includes(squash(e.source.quote)));
    const names = route.competencies.every((c) => shown.includes(c.name));
    const notCovered = route.notCovered.every((c) => shown.includes(c.name));
    record('I5.4b', route.state === 'ready' && evidence.length > 0 && allShown && names && notCovered && !miloScoresIn(shown),
      `${round.name}: the route holds ${evidence.length} statements over ${route.competencies.length} competencies and ${route.notCovered.length} not covered; the disclosure shows every one with its quote`);
  } catch (e) { record('I5.4b', false, `recap disclosure: ${why(e)}`); }

  // ── I5.4c: Open the record ────────────────────────────────────────────────────────────────────────────────────────────
  try {
    const round = app.rounds[0];
    await page.getByTestId('interviews-debrief-round').filter({ hasText: round.name }).first().getByTestId('interviews-debrief-record').click();
    await page.waitForURL(new RegExp(`/interviews/rounds/${round.interviewId}/record$`), { timeout: 30_000 });
    await seen(page, 'interviews-record');
    record('I5.4c', true, `"Open the record" on ${round.name} reached /interviews/rounds/${round.interviewId}/record`);
  } catch (e) { record('I5.4c', false, `open the record: ${why(e)}`); }

  // ── I5.4d: one table per application, a group per round, the Competency column kept in view ─────────────────────────
  try {
    // The seed holds two scorecards on this application; the page's layout rule is about more of them than a window holds,
    // so the answer is widened on the page with copies under invented seats. Nothing is written.
    await page.route(`**/api/interviews/candidates/${ingridId}/debrief`, async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      const a = body.debrief.applications[0];
      const extra = (round, n) => {
        const from = round.scorecards[0];
        for (let i = 0; i < n; i += 1) round.scorecards.push({ ...structuredClone(from), id: `${from.id}-copy-${i}`, interviewer: { id: `u-copy-${round.interviewId}-${i}`, name: `Interviewer ${String.fromCharCode(65 + i)} (${round.name})` } });
      };
      extra(a.rounds[0], 2);
      extra(a.rounds[1], 1);
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${portal}/interviews/candidates/${ingridId}/debrief`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-debrief-side-by-side');
    await page.waitForTimeout(500);
    const measure = async (width) => {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(300);
      return page.evaluate(() => {
        const table = document.querySelector('[data-testid="interviews-debrief-side-by-side"]');
        let el = table;
        let scroller = null;
        while (el && el !== document.body) {
          if (/(auto|scroll)/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1) { scroller = el; break; }
          el = el.parentElement;
        }
        const tables = document.querySelectorAll('[data-testid="interviews-debrief-side-by-side"]').length;
        const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
        const head = [...table.querySelectorAll('thead th')].find((th) => /^Competency$/.test(th.textContent.trim()));
        const before = head ? Math.round(head.getBoundingClientRect().left) : null;
        if (scroller) scroller.scrollLeft = scroller.scrollWidth;
        const after = head ? Math.round(head.getBoundingClientRect().left) : null;
        const box = (scroller ?? table).getBoundingClientRect();
        const row = table.querySelector('tbody tr td');
        const cell = row ? Math.round(row.getBoundingClientRect().left) : null;
        return { tables, headers, scrolls: !!scroller, before, after, left: Math.round(box.left), cell, pageSideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 };
      });
    };
    const w1280 = await measure(1280);
    const w1440 = await measure(1440);
    const groups = ['Coding', 'Working together'].every((g) => w1280.headers.some((h) => h.includes(g)));
    const kept = (m) => m.scrolls && m.after !== null && Math.abs(m.after - m.left) <= 2 && m.cell !== null && Math.abs(m.cell - m.left) <= 2;
    const checks = { oneTable: w1280.tables === 1, groups, keptAt1280: kept(w1280), noSideways1280: !w1280.pageSideways, noSideways1440: !w1440.pageSideways };
    const ok = Object.values(checks).every(Boolean);
    await shootPage(page, 'debrief-wide');
    record('I5.4d', ok, `[failing: ${failing(checks)}] one table for the application; column groups ${JSON.stringify(w1280.headers.slice(0, 3))}…; at 1280 the table scrolls inside itself and, scrolled to the end, the Competency column is at x=${w1280.after} (table edge ${w1280.left}) with its cells at ${w1280.cell}; at 1440 it ${w1440.scrolls ? `scrolls and keeps it at ${w1440.after}` : 'fits'}; the page scrolls sideways: ${w1280.pageSideways} at 1280, ${w1440.pageSideways} at 1440`);
  } catch (e) { record('I5.4d', false, `the wide table: ${why(e)}`); }

  await page.close();
  await greta.close();
  await resetMock();
}
