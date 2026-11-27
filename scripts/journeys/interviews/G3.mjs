// Piece G3: the scheduling and scorecard screens built for the gap audit's C-17 and C-9 rows that no walk had seen (the
// ledger's G3 walk). It writes, so it puts the mock world back to its seeds first and again at the end. Screenshots go to
// --out under short names (G3a-upcoming-saved-1440.png) with the mechanical facts beside them in G3-facts.json.
//   G3a  The double-booking warning: saved with a warning naming the interviewer and the other round's time, never a candidate;
//        a time that only touches the other round's end warns of nothing
//   G3b  Missed: the red pill on Upcoming, My interviews, the candidate profile and the prepare page; Cancel and
//        "Did not take place" are still offered
//   G3c  The overdue scorecard reminder: one bell per owed scorecard, once only, none for who already submitted
//   G3d  "Milo recommends" is off by default: nothing about it on the scorecard page
//   G3e  The recruiter's Settings page lists the overdue delay and the Milo recommendation entry
// Every screenshot carries: sideways scroll of the page, and whether the element under test clips its text.
import fs from 'node:fs';
import path from 'node:path';
import { scorecardBody } from './h4-kit.mjs';

const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, api, bells, endInterview, out, portal } = ctx;
  const facts = [];
  const why = (e) => (e instanceof Error ? e.message.split('\n')[0] : String(e));
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const save = () => fs.writeFileSync(path.join(out, 'G3-facts.json'), JSON.stringify(facts, null, 2));

  /** One screenshot per width; `sel` is the element under test (a test id or `role:x`), judged for clipped text. */
  async function snap(page, name, widths, sel) {
    const rows = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const f = await page.evaluate((s) => {
        const el = s ? (s.startsWith('role:') ? document.querySelector(`[role="${s.slice(5)}"]`) : document.querySelector(`[data-testid="${s}"]`)) : null;
        const clip = el ? (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) : null;
        return { horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, elementFound: !!el, elementClipped: clip };
      }, sel ?? null);
      const file = `${name}-${width}.png`;
      await page.screenshot({ path: path.join(out, file) });
      rows.push({ file, width, ...f });
      facts.push({ file, width, ...f });
    }
    return rows;
  }
  const fmt = (rows) => rows.map((r) => `@${r.width}${r.horizontalScroll ? ' PAGE-SCROLLS-SIDEWAYS' : ' no-hscroll'}${r.elementFound === false ? ' ELEMENT-NOT-FOUND' : ''}${r.elementClipped ? ' CLIPPED' : ''}`).join(' ');
  const allRounds = async (who) => (await api(who, 'GET', '/api/interviews/interviews')).body?.items ?? [];
  const roundOf = async (who, id) => (await allRounds(who)).find((r) => r.id === id);

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const I = SEED.interviews;

  // ── G3a: the double-booking warning ─────────────────────────────────────────────────────────────────────
  await step('G3a', async () => {
    // Two seeded rounds that share an interviewer: Nadia's design round (Hugo leads) and her leadership round (Wen leads, Hugo on the panel).
    const target = await roundOf(greta, I.nadiaDesign);
    const other = await roundOf(greta, I.nadiaLeadership);
    const shares = target.lead.id === SEED.cast.interviewer && (other.panel ?? []).some((p) => p.id === SEED.cast.interviewer);
    if (!shares) return { ok: false, detail: `the seed no longer has two rounds sharing Hugo: design lead ${target.lead.id}, leadership panel ${JSON.stringify(other.panel)}` };
    const otherStart = new Date(other.scheduledAt);
    const otherEnd = new Date(otherStart.getTime() + other.round.minutes * 60_000);
    const expectWindow = `${hm.format(otherStart)} to ${hm.format(otherEnd)}`;
    const overlap = new Date(Math.ceil((otherStart.getTime() + 10 * 60_000) / 60_000) * 60_000);

    const page = await greta.newPage();
    const row = () => page.getByTestId('interviews-upcoming-table').locator('tr', { hasText: 'Nadia' }).filter({ hasText: /design/i }).first();
    const setTimeThroughPage = async (when) => {
      await page.goto(`${portal}/interviews/upcoming`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('interviews-upcoming-table').getByText('Nadia', { exact: false }).first().waitFor({ timeout: 30_000 });
      await row().getByTestId('interviews-upcoming-actions').click();
      await page.getByRole('menuitem', { name: /Change the time/ }).click();
      await page.getByTestId('interviews-upcoming-time-field-input').fill(localInput(when));
      const deck = page.getByTestId('collection-command-composer-prompts');
      await deck.getByText(/Set the time to/).waitFor({ timeout: 15_000 });
      await deck.getByRole('button', { name: /Confirm/ }).click();
      await row().getByTestId('interviews-upcoming-saved').waitFor({ timeout: 30_000 });
      return squash(await row().getByTestId('interviews-upcoming-saved').innerText());
    };

    // The overlapping time, from the Upcoming page.
    const savedLine = await setTimeThroughPage(overlap);
    const upShot = await snap(page, 'G3a-upcoming-saved', [1440], 'interviews-upcoming-saved');
    const stored = await roundOf(greta, I.nadiaDesign);
    const storedOk = Math.abs(Date.parse(stored.scheduledAt) - overlap.getTime()) < 60_000;

    // The assign form (the round's Reassign page): the warning on load, then after saving.
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.nadia}/assign?round=${I.nadiaDesign}`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-assign-form');
    const onLoad = await seen(page, 'interviews-assign-conflicts', 8000);
    const loadText = onLoad ? squash(await page.getByTestId('interviews-assign-conflicts').first().innerText()) : '';
    const loadShot = await snap(page, 'G3a-assign-preview', [1440], onLoad ? 'interviews-assign-conflicts' : 'interviews-assign-form');
    // Reassigning with the same seats is refused ("Nobody was reassigned"), so Wen takes panel seat 0; she leads the other round, so she clashes too.
    await page.getByTestId('interviews-assign-panel-0').click();
    await page.getByRole('option', { name: SEED.names[SEED.cast.interviewer2] }).click();
    await page.waitForTimeout(500);
    await page.getByTestId('interviews-assign-submit').click();
    await page.waitForTimeout(1500);
    const afterSave = await seen(page, 'interviews-assign-conflicts', 8000);
    const assignText = afterSave ? squash(await page.getByTestId('interviews-assign-conflicts').first().innerText()) : '';
    const savedPrefix = /^Saved\./.test(assignText);
    const err = await page.getByTestId('interviews-assign-error').first().innerText({ timeout: 1000 }).catch(() => '');
    const saveShot = await snap(page, 'G3a-assign-saved', [1440], afterSave ? 'interviews-assign-conflicts' : 'interviews-assign-form');

    // A time that only touches the other round's end: no warning on the Upcoming row or on the assign form.
    const touchLine = await setTimeThroughPage(otherEnd);
    const touchShot = await snap(page, 'G3a-upcoming-touching', [1440], 'interviews-upcoming-saved');
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.nadia}/assign?round=${I.nadiaDesign}`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-assign-form');
    await page.waitForTimeout(1200);
    const touchWarns = await page.getByTestId('interviews-assign-conflicts').count();
    const touchAssignShot = await snap(page, 'G3a-assign-touching', [1440], 'interviews-assign-form');
    await page.close();

    const says = (t) => t.includes('Marchetti') && t.includes(expectWindow) && !/Nadia|Mikhail/.test(t) && /is also on a round/.test(t);
    const ok = storedOk && says(savedLine) && afterSave && savedPrefix && says(assignText) && /Zhao/.test(assignText) && onLoad && says(loadText) && !/is also on a round/.test(touchLine) && touchWarns === 0 && !err;
    return { ok, detail: `time saved (${storedOk}); Upcoming row "${savedLine}" ${fmt(upShot)}; assign form on load "${loadText}" ${fmt(loadShot)}; after Reassign (Wen on panel seat 0, a second clash) "${assignText}" (error "${err}") ${fmt(saveShot)}; expected the other round at ${expectWindow}, names Hugo and no candidate; touching time: row "${touchLine}" ${fmt(touchShot)}, ${touchWarns} warning(s) on the assign form ${fmt(touchAssignShot)}` };
  });
  save();
  await resetMock();

  // ── G3b: missed ─────────────────────────────────────────────────────────────────────────────────────────
  const gretaB = await signIn(SEED.cast.recruiter);
  const wenB = await signIn(SEED.cast.interviewer2);
  await step('G3b', async () => {
    // Aiko's coding round: ready, Wen leads, two days out, an hour long. Eight days on, its window is long over.
    const iv = I.aikoCoding;
    const before = await roundOf(gretaB, iv);
    const moved = await ctx.clock.advance(8 * 86_400_000);
    const after = await roundOf(gretaB, iv);
    const shots = [];
    const pills = {};
    const read = async (page, id) => squash(await page.getByTestId(id).first().innerText({ timeout: 8000 }).catch(() => '(not found)'));

    const up = await gretaB.newPage();
    // The page's own clock moves with the interviews clock (as G1b does): "Did not take place" is offered by the browser's reading of the start.
    await up.clock.install({ time: Date.now() + 8 * 86_400_000 });
    await up.goto(`${portal}/interviews/upcoming`, { waitUntil: 'domcontentloaded' });
    const upRow = up.getByTestId('interviews-upcoming-table').locator('tr', { hasText: 'Aiko' }).first();
    await upRow.waitFor({ timeout: 30_000 });
    pills.upcoming = squash(await upRow.getByTestId('interviews-upcoming-state').innerText().catch(() => '(not found)'));
    shots.push(...await snap(up, 'G3b-upcoming', [1440, 900], 'interviews-upcoming-state'));
    await upRow.getByTestId('interviews-upcoming-actions').click();
    const menu = (await up.getByRole('menuitem').allInnerTexts()).map(squash);
    shots.push(...await snap(up, 'G3b-upcoming-menu', [1440], 'role:menu'));
    await up.keyboard.press('Escape');
    await up.close();

    const mine = await wenB.newPage();
    await mine.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await seen(mine, 'interviews-my-interviews-table');
    const myRow = mine.getByTestId('interviews-my-interviews-table').locator('tr', { hasText: 'Aiko' }).first();
    await myRow.waitFor({ timeout: 30_000 });
    pills.myInterviews = squash(await myRow.getByTestId('interviews-desk-state').innerText().catch(() => '(not found)'));
    shots.push(...await snap(mine, 'G3b-my-interviews', [1440, 900], 'interviews-desk-state'));
    await mine.close();

    const prof = await gretaB.newPage();
    await prof.goto(`${portal}/interviews/candidates/${SEED.candidates.aiko}`, { waitUntil: 'domcontentloaded' });
    await seen(prof, 'interviews-profile-rounds');
    pills.profile = squash(await prof.getByTestId('interviews-profile-rounds').locator('tr', { hasText: 'Coding' }).first().getByTestId('interviews-profile-round-status').innerText().catch(() => '(not found)'));
    shots.push(...await snap(prof, 'G3b-profile', [1440, 900], 'interviews-profile-round-status'));
    await prof.close();

    const prep = await wenB.newPage();
    await prep.goto(`${portal}/interviews/rounds/${iv}/prepare`, { waitUntil: 'domcontentloaded' });
    await seen(prep, 'interviews-prepare-state');
    pills.prepare = await read(prep, 'interviews-prepare-state');
    shots.push(...await snap(prep, 'G3b-prepare', [1440, 900], 'interviews-prepare-state'));
    await prep.close();

    await ctx.clock.reset();
    save();
    const offers = { cancel: menu.some((m) => /^Cancel round/.test(m)), notHeld: menu.some((m) => /^Did not take place/.test(m)) };
    const allMissed = Object.values(pills).every((p) => p === 'Missed');
    return { ok: allMissed && after?.missed === true && !before?.missed && offers.cancel && offers.notHeld, detail: `clock offset ${moved.offsetMs}; api missed before ${before?.missed ?? false}, after ${after?.missed ?? false}; pills ${JSON.stringify(pills)}; menu ${JSON.stringify(menu)} (Cancel ${offers.cancel}, Did not take place ${offers.notHeld}); ${shots.map((s) => `${s.file} ${fmt([s])}`).join('; ')}` };
  });
  await ctx.clock.reset();
  save();
  await resetMock();

  // ── G3c: the overdue scorecard reminder ─────────────────────────────────────────────────────────────────
  const hugoC = await signIn(SEED.cast.interviewer);
  const wenC = await signIn(SEED.cast.interviewer2);
  await step('G3c', async () => {
    // Wen owes Jonah's leadership round (seeded, ended yesterday). Kwame's live round (Hugo leads, Wen on the panel) is ended now and
    // Hugo submits, so Wen owes that one too and Hugo owes nothing.
    const jonah = I.jonahLeadership;
    const kw = I.kwameLive;
    const ended = await endInterview(hugoC, kw);
    const sub = await api(hugoC, 'POST', `/api/interviews/interviews/${kw}/scorecard`, await scorecardBody(ctx, hugoC, kw));
    const endsAt = [await roundOf(gretaB, jonah), await roundOf(gretaB, kw)].map((r) => Date.parse(r?.endedAt ?? r?.scheduledAt));
    const jonahRound = await roundOf(gretaB, jonah);
    const setup = `Kwame's round ended ${JSON.stringify(ended.status)}, Hugo's scorecard ${sub.status}, states ${jonahRound?.state}/${(await roundOf(gretaB, kw))?.state}`;
    const nowBefore = await ctx.clock.now();
    const earlyRing = await ctx.clock.sweep('overdue');
    const wenPageEarly = await wenC.newPage();
    await wenPageEarly.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await seen(wenPageEarly, 'interviews-my-interviews-table');
    const early = await bells(wenPageEarly, /overdue/i, { ms: 2500, absent: true });
    await wenPageEarly.close();

    // 25 hours past the later end.
    const latestEnd = Math.max(...endsAt.filter(Number.isFinite), nowBefore.getTime());
    const moved = await ctx.clock.advance(Math.max(0, latestEnd + 25 * 3_600_000 - (await ctx.clock.now()).getTime()));
    const ring1 = await ctx.clock.sweep('overdue');

    const wp = await wenC.newPage();
    await wp.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await seen(wp, 'interviews-my-interviews-table');
    const got = await bells(wp, /overdue/i, { ms: 20_000 });
    const text = squash(await got.panel?.innerText().catch(() => '') ?? '');
    const shot = got.panel ? await snap(wp, 'G3c-wen-bell', [1440], 'role:dialog') : [];
    // The bell's action: it opens the scorecard.
    let opened = '(no bell panel)';
    if (got.panel) {
      const controls = await got.panel.locator('a, button').evaluateAll((els) => els.map((e) => `${(e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)}${e.getAttribute('href') ? ' -> ' + e.getAttribute('href') : ''}`));
      const item = got.panel.getByText(/Your scorecard is overdue: Leadership/).first();
      await item.click();
      await wp.waitForTimeout(2500);
      opened = `${new URL(wp.url()).pathname} (bell controls ${JSON.stringify(controls.slice(0, 8))})`;
    }
    await wp.close();

    // A second sweep rings nobody twice.
    const ring2 = await ctx.clock.sweep('overdue');
    const wp2 = await wenC.newPage();
    await wp2.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await seen(wp2, 'interviews-my-interviews-table');
    const again = await bells(wp2, /overdue/i, { ms: 3000, absent: true });
    await wp2.close();

    // Hugo submitted: no overdue bell for him.
    const hp = await hugoC.newPage();
    await hp.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await seen(hp, 'interviews-my-interviews-table');
    const hugoBell = await bells(hp, /overdue/i, { ms: 3000, absent: true });
    await hp.close();

    const names = await api(gretaB, 'GET', `/api/interviews/interviews/${jonah}`);
    const candName = (names.body?.interview?.candidate?.name ?? 'Jonah').split(' ')[0];
    const leak = got.lines.some((l) => l.includes(candName)) || /Aiko|Mateo|Kwame/.test(got.lines.join(' '));
    const namesRound = got.lines.some((l) => /Leadership|leadership/.test(l)) && got.lines.some((l) => /Engineering Manager|Manager/.test(l));
    const ok = got.lines.length >= 2 && !leak && namesRound && /\/scorecard \(/.test(opened) && again.lines.length <= got.lines.length && new Set(again.lines).size === again.lines.length && hugoBell.lines.length === 0 && early.lines.length === 0;
    save();
    return { ok, detail: `${setup}; before 24h the sweep rang ${JSON.stringify(earlyRing.sweep?.rang)} and Wen's bell held ${early.lines.length}; clock moved to ${moved.now}; first sweep rang ${JSON.stringify(ring1.sweep?.rang)}; Wen's bell ${JSON.stringify(got.lines)} (names the candidate: ${leak}; names an opening and a round: ${namesRound}); its action opened ${opened}; second sweep rang ${JSON.stringify(ring2.sweep?.rang)} and Wen's bell still held ${again.lines.length} (was ${got.lines.length}; the bell I clicked was consumed: ${JSON.stringify(again.lines)}); Hugo (submitted) holds ${hugoBell.lines.length} overdue bell(s); ${fmt(shot)}` };
  });
  await ctx.clock.reset();
  save();

  // ── G3d: "Milo recommends" is off by default ────────────────────────────────────────────────────────────
  await resetMock();
  const wenD = await signIn(SEED.cast.interviewer2);
  await step('G3d', async () => {
    const page = await wenD.newPage();
    await page.goto(`${portal}/interviews/rounds/${I.jonahLeadership}/scorecard`, { waitUntil: 'domcontentloaded' });
    const form = await seen(page, 'interviews-scorecard-form');
    await page.waitForTimeout(2500);
    const body = squash(await page.locator('body').innerText());
    const advice = await page.getByTestId('interviews-scorecard-milo-advice').count();
    const recommends = /Milo recommends/i.test(body);
    const none = /Milo has no recommendation yet/i.test(body);
    const shot = await snap(page, 'G3d-scorecard-top', [1440], 'interviews-scorecard-form');
    await page.close();
    return { ok: form && !advice && !recommends && !none, detail: `scorecard form shown ${form}; "Milo recommends" on the page ${recommends}; "Milo has no recommendation yet" ${none}; advice block ${advice}; ${fmt(shot)}` };
  });

  // ── G3e: Settings lists the new entries ─────────────────────────────────────────────────────────────────
  const gretaE = await signIn(SEED.cast.recruiter);
  await step('G3e', async () => {
    const page = await gretaE.newPage();
    await page.goto(`${portal}/interviews/settings`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-settings-table');
    await page.waitForTimeout(1500);
    const rows = (await page.getByTestId('interviews-settings-table').locator('tbody tr').allInnerTexts()).map(squash);
    const overdue = rows.find((r) => /overdue/i.test(r)) ?? null;
    const milo = rows.find((r) => /MILO_RECOMMENDATION|recommendation/i.test(r)) ?? null;
    const shot = await snap(page, 'G3e-settings', [1440], 'interviews-settings-table');
    // The Milo entry is the last row, below the first screen: bring it into view for a second shot.
    await page.getByTestId('interviews-settings-table').locator('tbody tr', { hasText: 'INTERVIEWS_MILO_RECOMMENDATION' }).first().scrollIntoViewIfNeeded().catch(() => undefined);
    shot.push(...await snap(page, 'G3e-settings-milo-row', [1440], 'interviews-settings-table'));
    await page.close();
    return { ok: !!overdue && !!milo, detail: `${rows.length} settings; overdue entry ${JSON.stringify(overdue)}; Milo recommendation entry ${JSON.stringify(milo)}; ${fmt(shot)}` };
  });

  save();
  await ctx.clock.reset();
  await resetMock();
}
