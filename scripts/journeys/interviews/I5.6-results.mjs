// Piece I5.6-results: the three result bells of row I5.6 (docs/interviews-tenant-plan.md decisions 4 and 15; hardening lane H4;
// H1 owns the rest of I5.6 in I5.6.mjs). Each bell is read as the person it is for, on their open page, and carries the opening
// and the round and nothing about the candidate: no name, no rating, no recommendation, no reason, no recap line. It writes, so it
// puts the mock world back to its seeds first and again at the end. Kwame's round (Hugo leads, Wen on the panel, live at the
// reset) is the one that ends.
//   I5.6r-a  the round ends: each seat's bell says their scorecard is due, for the round and the opening
//   I5.6r-b  a scorecard in: the recruiter is told on each, the hiring manager once every seat's is in
//   I5.6r-c  a decision: the recruiter is told one was recorded and by whom, never what
import { scorecardBody, seen, squash, why } from './h4-kit.mjs';

const SUMMARY_HUGO = 'The first fix was found late and the second was never tested before the break.';
const SUMMARY_WEN = 'Reached for a clamp straight away and explained the off-by-one in plain words.';
const REASON = 'Holding while the second team confirms the headcount for this quarter.';

export default async function run(ctx) {
  const { SEED, portal, record, signIn, api, bells, resetMock, endInterview } = ctx;
  await resetMock();
  const KWAME = SEED.interviews.kwameLive;
  const NAME = ['Kwame', 'Asante'];
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const greta = await signIn(SEED.cast.recruiter);
  const amara = await signIn(SEED.cast.hiringManager);
  const pages = {};
  const landing = { hugo: ['/interviews/my-interviews', hugo], wen: ['/interviews/my-interviews', wen], greta: ['/interviews/candidates', greta], amara: ['/interviews/my-openings', amara] };
  for (const [k, [path, who]] of Object.entries(landing)) {
    pages[k] = await who.newPage();
    await pages[k].goto(`${portal}${path}`, { waitUntil: 'domcontentloaded' });
    await seen(pages[k], 'activity-bell').catch(() => pages[k].locator('[data-testid="activity-bell"]').first().waitFor({ timeout: 30_000 }));
  }
  const panelText = async (got) => squash(await got.panel.innerText().catch(() => ''));
  /** The bell for `re` on `who`'s page, and what in it would be about the candidate. */
  const ring = async (key, re, words) => {
    const got = await bells(pages[key], re, { ms: 25_000 });
    const whole = got.panel ? await panelText(got) : '';
    const lines = got.lines.map(squash);
    const leaked = [...NAME, ...words].filter((w) => lines.join(' ').includes(w) || whole.includes(w));
    if (got.panel) await pages[key].keyboard.press('Escape');
    return { lines, leaked, whole };
  };

  // ── I5.6r-a: the round ends ────────────────────────────────────────────────────────────────────────────────────────────
  try {
    const ended = await endInterview(hugo, KWAME);
    const rung = [await ring('hugo', /scorecard is due/i, []), await ring('wen', /scorecard is due/i, [])];
    const ok = ended.status === 200 && rung.every((r) => r.lines.length >= 1 && /Coding/.test(r.lines.join(' ')) && /Senior Backend Engineer/.test(r.lines.join(' ')) && r.leaked.length === 0);
    record('I5.6r-a', ok, `the round ended (${ended.status}); Hugo's bell "${(rung[0].lines[0] ?? '').slice(0, 80)}", Wen's "${(rung[1].lines[0] ?? '').slice(0, 80)}"; about the candidate: ${JSON.stringify(rung.flatMap((r) => r.leaked))}`);
  } catch (e) { record('I5.6r-a', false, `scorecard due: ${why(e)}`); }

  // ── I5.6r-b: scorecards in ────────────────────────────────────────────────────────────────────────────────────────────
  try {
    const hugoCard = await api(hugo, 'POST', `/api/interviews/interviews/${KWAME}/scorecard`, await scorecardBody(ctx, hugo, KWAME, { summary: SUMMARY_HUGO, recommendation: 'strong-no' }));
    const first = await ring('greta', /submitted a scorecard/i, [SUMMARY_HUGO, 'Strong no', 'strong-no']);
    // The seed already holds an "every scorecard is in" bell for another round (mock/interviews-money.ts): only this round's counts.
    const early = await bells(pages.amara, /Every scorecard is in: Coding/i, { ms: 3000, absent: true });
    await pages.amara.keyboard.press('Escape').catch(() => undefined);
    const wenCard = await api(wen, 'POST', `/api/interviews/interviews/${KWAME}/scorecard`, await scorecardBody(ctx, wen, KWAME, { summary: SUMMARY_WEN, recommendation: 'strong-yes' }));
    const all = await ring('amara', /Every scorecard is in/i, [SUMMARY_WEN, SUMMARY_HUGO, 'Strong yes', 'strong-yes']);
    const ok = hugoCard.status === 201 && wenCard.status === 201 && first.lines.length >= 1 && /Hugo Marchetti submitted a scorecard: Coding for Senior Backend Engineer/.test(first.lines.join(' ')) && first.leaked.length === 0
      && early.lines.length === 0 && all.lines.length >= 1 && /Coding for Senior Backend Engineer/.test(all.lines.join(' ')) && all.leaked.length === 0;
    record('I5.6r-b', ok, `the recruiter's bell "${(first.lines[0] ?? '').slice(0, 85)}"; the hiring manager had none after one of two (${early.lines.length}) and, after both, "${(all.lines[0] ?? '').slice(0, 60)}"; about the candidate: ${JSON.stringify([...first.leaked, ...all.leaked])}`);
  } catch (e) { record('I5.6r-b', false, `scorecard in: ${why(e)}`); }

  // ── I5.6r-c: a decision ───────────────────────────────────────────────────────────────────────────────────────────────
  try {
    const view = (await api(amara, 'GET', `/api/interviews/candidates/${SEED.candidates.kwame}/debrief`)).body.debrief.applications[0];
    const decided = await api(amara, 'POST', `/api/interviews/applications/${SEED.applications.kwame}/stage`, { decision: 'hold', reason: REASON, basedOn: view.basedOn });
    const rung = await ring('greta', /decision was recorded/i, [REASON, 'Hold', 'on-hold', SUMMARY_HUGO, SUMMARY_WEN]);
    const ok = decided.status === 201 && rung.lines.length >= 1 && /A decision was recorded on Senior Backend Engineer/.test(rung.lines.join(' ')) && /Recorded by Amara Okafor/.test(rung.whole) && rung.leaked.length === 0;
    record('I5.6r-c', ok, `the recruiter's bell "${(rung.lines[0] ?? '').slice(0, 120)}", read whole: "${(rung.whole.match(/Recorded by[^.]*\./) ?? [''])[0]}"; status ${decided.status}; about the candidate or the reason: ${JSON.stringify(rung.leaked)}`);
  } catch (e) { record('I5.6r-c', false, `decided: ${why(e)}`); }

  for (const p of Object.values(pages)) await p.close().catch(() => undefined);
  for (const c of [hugo, wen, greta, amara]) await c.close().catch(() => undefined);
  await resetMock();
}
