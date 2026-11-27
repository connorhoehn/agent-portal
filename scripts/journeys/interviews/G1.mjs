// Piece G1: the screens built for the gap audit that no walk had seen (the ledger's G1 walk). It writes, so it puts the
// mock world back to its seeds first and again at the end. Screenshots go to --out under short names
// (G1a-cancel-dialog-1440.png) with the mechanical facts beside them in G1-facts.json.
//   G1f  the pad's "Simulated runner" label on the lead's pad (1440, 1280, 900) and the candidate's (1280, 390)
//   G1a  Cancel a round, the row's reason, "Assign again"
//   G1b  "Did not take place" on a round whose start has passed
//   G1c  Mark withdrawn
//   G1d  Move stage: Start screening, Mark hired, Reopen
//   G1e  an opening with no hiring manager: the warning on the opening, the assign form and the debrief
//   G1g  the waiting candidate while the lead is not on the page: the seats' bells and the candidate's line
// Every screenshot carries: sideways scroll of the page, and whether the element under test clips its text.
import fs from 'node:fs';
import path from 'node:path';

export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, api, bells, mintInvite, openGuest, toWaiting, admit, startInterview, setTime, out, portal } = ctx;
  const facts = [];
  const why = (e) => (e instanceof Error ? e.message.split('\n')[0] : String(e));
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };

  /** One screenshot per width; `sel` is the element under test (a test id or role), judged for clipped text. */
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
  const fmt = (rows) => rows.map((r) => `@${r.width}${r.horizontalScroll ? ' PAGE-SCROLLS-SIDEWAYS' : ' no-hscroll'}${r.elementClipped ? ' CLIPPED' : ''}`).join(' ');
  const save = () => fs.writeFileSync(path.join(out, 'G1-facts.json'), JSON.stringify(facts, null, 2));

  const dialogOf = (page) => page.locator('[role="dialog"], [role="alertdialog"]').last();
  const roundRow = (page, text) => page.getByTestId('interviews-profile-rounds').locator('tr', { hasText: text }).first();
  const profileOf = async (ctxt, cand) => {
    const page = await ctxt.newPage();
    await page.goto(`${portal}/interviews/candidates/${cand}`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-profile-rounds');
    return page;
  };
  const allRounds = async (greta) => (await api(greta, 'GET', '/api/interviews/interviews')).body?.items ?? [];
  const opened = [];
  const histOf = async (page) => {
    await page.getByRole('tab', { name: /^Activity/ }).click();
    await seen(page, 'interviews-profile-history', 10_000);
    return (await page.getByTestId('interviews-profile-history').innerText().catch(() => '')).replace(/\s+/g, ' ');
  };
  const histShot = async (page, name) => { await page.getByRole('tab', { name: /^Activity/ }).click().catch(() => undefined); await seen(page, 'interviews-profile-history', 10_000); return snap(page, name, [1440], 'interviews-profile-history'); };

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const amara = await signIn(SEED.cast.hiringManager);
  const I = SEED.interviews;

  // ── G1f: the pad's runner label ─────────────────────────────────────────────────────────────────────────
  await step('G1f-lead', async () => {
    const iv = SEED.guestInterview;
    const page = await hugo.newPage();
    await page.goto(`${portal}/interviews/rounds/${iv}/room`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interview-room-idle');
    let pad = await seen(page, 'interview-pad-run', 8000);
    let how = 'before the call';
    const labelBefore = pad ? await seen(page, 'interview-pad-runner-label', 6000) : false;
    if (!pad || !labelBefore) {
      // The runner is read with the pad's runs: try again with the round live (the lead's own Start).
      const s = await startInterview(hugo, iv);
      await page.reload({ waitUntil: 'domcontentloaded' });
      pad = await seen(page, 'interview-pad-run', 20_000);
      await seen(page, 'interview-pad-runner-label', 10_000);
      how = `after Start (${s.status}); before Start the label was ${labelBefore ? 'there' : 'absent'}`;
    }
    if (!pad) {
      const tabs = (await page.getByRole('tab').allInnerTexts().catch(() => [])).map((t) => t.trim().split('\n')[0]);
      await snap(page, 'G1f-lead-nopad', [1440], null);
      return { ok: false, detail: `no pad toolbar (interview-pad-run) in the lead's room, tabs ${JSON.stringify(tabs)}` };
    }
    const label = page.getByTestId('interview-pad-runner-label').first();
    const labelText = (await label.innerText({ timeout: 3000 }).catch(() => '')).trim();
    const runner = await label.getAttribute('data-runner', { timeout: 3000 }).catch(() => null);
    const rows = [];
    const geo = [];
    for (const w of [1440, 1280, 900]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(500);
      const g = await page.evaluate(() => {
        const l = document.querySelector('[data-testid="interview-pad-runner-label"]');
        const b = document.querySelector('[data-testid="interview-pad-run"]');
        const c = b /* the Run button: the control is the button alone since the label moved over the output */;
        if (!l || !b) return { label: false };
        const lr = l.getBoundingClientRect(); const br = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
        // The toolbar: the nearest ancestor that holds the run control and is as tall as one row of controls.
        let bar = c.parentElement; while (bar && bar.getBoundingClientRect().height > 80 && bar.parentElement) bar = bar.parentElement;
        const bw = bar ? { scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth, right: Math.round(bar.getBoundingClientRect().right) } : null;
        return {
          label: true, labelLines: Math.round(lr.height / parseFloat(getComputedStyle(l).lineHeight || '16')), labelRect: [Math.round(lr.left), Math.round(lr.top), Math.round(lr.width), Math.round(lr.height)],
          runRect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)],
          overlapsRun: lr.right > br.left + 0.5 && lr.left < br.right && lr.bottom > br.top && lr.top < br.bottom,
          controlRight: Math.round(cr.right), viewport: innerWidth, controlBeyondViewport: cr.right > innerWidth + 1, bar: bw,
          labelTextClipped: l.scrollWidth > l.clientWidth + 1, barClipsContent: bw ? bw.scrollWidth > bw.clientWidth + 1 : null,
        };
      });
      geo.push({ width: w, ...g });
      rows.push(...await snap(page, `G1f-lead-pad-${w}`.replace(/-\d+$/, ''), [w], 'interview-pad-runner-label'));
    }
    fs.writeFileSync(path.join(out, 'G1f-lead-geometry.json'), JSON.stringify(geo, null, 2));
    await page.close();
    const bad = geo.filter((g) => g.label && (g.overlapsRun || g.controlBeyondViewport || g.barClipsContent || g.labelTextClipped));
    return { ok: bad.length === 0 && !!labelText, detail: `lead's pad (${how}) says "${labelText}" (runner ${runner}); ${fmt(rows)}; label lines ${geo.map((g) => `${g.width}:${g.labelLines}`).join(',')}; overlap/beyond/clipped at ${bad.length ? bad.map((g) => g.width).join(',') : 'no width'}` };
  });

  await step('G1f-candidate', async () => {
    const iv = SEED.guestInterview;
    const inv = await mintInvite(greta, iv);
    if (!inv.linkPath) throw new Error(`no invite: ${inv.status} ${inv.error}`);
    const g = await openGuest(inv.linkPath, { width: 1280 });
    opened.push(g.context);
    await toWaiting(g.page);
    await admit(hugo, iv, true);
    const inRoom = await seen(g.page, 'join-room', 30_000);
    if (!inRoom) return { ok: false, detail: `the candidate was admitted but the room did not show (landed ${g.landed})` };
    const padShown = await seen(g.page, 'interview-pad-run', 20_000);
    await seen(g.page, 'interview-pad-runner-label', 10_000);
    if (!padShown) {
      await snap(g.page, 'G1f-cand-nopad', [1280], null);
      const tabs = (await g.page.getByRole('tab').allInnerTexts().catch(() => [])).map((t) => t.trim().split('\n')[0]);
      return { ok: false, detail: `no pad toolbar for the candidate; tabs ${JSON.stringify(tabs)}` };
    }
    const rows = [];
    const geo = [];
    for (const w of [1280, 390]) {
      await g.page.setViewportSize({ width: w, height: 800 });
      await g.page.waitForTimeout(500);
      const gg = await g.page.evaluate(() => {
        const l = document.querySelector('[data-testid="interview-pad-runner-label"]');
        const b = document.querySelector('[data-testid="interview-pad-run"]');
        const c = b /* the Run button: the control is the button alone since the label moved over the output */;
        if (!l || !b) return { label: false };
        const lr = l.getBoundingClientRect(); const br = b.getBoundingClientRect(); const cr = c.getBoundingClientRect();
        return { label: true, text: l.textContent, labelLines: Math.round(lr.height / parseFloat(getComputedStyle(l).lineHeight || '16')), labelRect: [Math.round(lr.left), Math.round(lr.top), Math.round(lr.width), Math.round(lr.height)], runRect: [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)],
          overlapsRun: lr.right > br.left + 0.5 && lr.left < br.right && lr.bottom > br.top && lr.top < br.bottom, controlRight: Math.round(cr.right), controlBeyondViewport: cr.right > innerWidth + 1, labelTextClipped: l.scrollWidth > l.clientWidth + 1 };
      });
      geo.push({ width: w, ...gg });
      rows.push(...await snap(g.page, 'G1f-cand-pad', [w], 'interview-pad-runner-label').then((r) => r.map((x) => ({ ...x, file: x.file }))));
    }
    fs.writeFileSync(path.join(out, 'G1f-cand-geometry.json'), JSON.stringify(geo, null, 2));
    const bad = geo.filter((x) => x.label && (x.overlapsRun || x.controlBeyondViewport || x.labelTextClipped));
    return { ok: bad.length === 0 && !!geo[0].label && !rows.some((r) => r.horizontalScroll), detail: `candidate's pad label "${geo[0].text ?? ''}"; ${fmt(rows)}; label lines ${geo.map((x) => `${x.width}:${x.labelLines}`).join(',')}; overlap/beyond/clipped at ${bad.length ? bad.map((x) => x.width).join(',') : 'no width'}` };
  });
  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  save();
  await resetMock();

  // ── G1a: cancel a round ─────────────────────────────────────────────────────────────────────────────────
  const gretaA = await signIn(SEED.cast.recruiter);
  await step('G1a', async () => {
    // Nadia's design round: accepted, five days out.
    const page = await profileOf(gretaA, SEED.candidates.nadia);
    const row = roundRow(page, 'System design').or(roundRow(page, 'Design')).first();
    await row.waitFor({ timeout: 20_000 });
    await row.getByTestId('interviews-profile-round-actions').click();
    const menu = await snap(page, 'G1a-actions-menu', [1440], null);
    await page.getByTestId('interviews-round-cancel').click();
    await seen(page, 'interviews-round-close-dialog');
    const radios = await page.getByTestId('interviews-round-cancel-reason').getByRole('radio').count();
    const noteBox = await page.getByTestId('interviews-round-close-note').count();
    const dlg = await snap(page, 'G1a-cancel-dialog', [1440, 900], 'interviews-round-close-dialog');
    await page.getByTestId('interviews-round-close-note').fill('The panel is not free that day.');
    await dialogOf(page).getByRole('button', { name: 'Cancel round' }).click();
    await page.getByTestId('interviews-round-close-dialog').waitFor({ state: 'detached', timeout: 20_000 });
    await page.waitForTimeout(800);
    const rowText = (await roundRow(page, 'Cancelled').innerText().catch(() => '')).replace(/\s+/g, ' ');
    const why1 = (await page.getByTestId('interviews-profile-round-cancelled').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    const after = await snap(page, 'G1a-cancelled-row', [1440, 1280], 'interviews-profile-rounds');
    const again = await page.getByTestId('interviews-profile-assign-again').count();
    const aShot = await snap(page, 'G1a-assign-again', [1440], 'interviews-profile-rounds');
    const apiRound = (await allRounds(gretaA)).find((r) => r.id === I.nadiaDesign);
    await page.close();
    const ok = radios >= 2 && noteBox === 1 && /Cancelled/.test(rowText) && again >= 1 && apiRound?.state === 'cancelled' && !!why1;
    return { ok, detail: `menu ${fmt(menu)}; ${radios} reason radios, ${noteBox} note box; dialog ${fmt(dlg)}; row after: "${rowText.slice(0, 140)}"; reason line "${why1.slice(0, 120)}"; ${again} Assign again button(s); api state ${apiRound?.state}; row ${fmt(after)} / ${fmt(aShot)}` };
  });

  // ── G1b: did not take place ─────────────────────────────────────────────────────────────────────────────
  await step('G1b', async () => {
    // Aiko's iOS coding round is ready, two days out: move its start into the past through the API, as a recruiter would on the time form.
    // The time form refuses a past time (400), so the clocks move instead: the interviews clock eight days on, and this page's own clock with it.
    const moved = await ctx.clock.advance(8 * 86_400_000);
    const page = await gretaA.newPage();
    await page.clock.install({ time: Date.now() + 8 * 86_400_000 });
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.aiko}`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-profile-rounds');
    const row = roundRow(page, 'Coding');
    await row.waitFor({ timeout: 20_000 });
    await row.getByTestId('interviews-profile-round-actions').click();
    const hasItem = await page.getByTestId('interviews-round-not-held').count();
    if (!hasItem) {
      await snap(page, 'G1b-actions-menu', [1440], null);
      return { ok: false, detail: `no "Did not take place…" in the menu after setting the start to the past (clock offset ${moved.offsetMs ?? moved.status}, ${hasItem} item)` };
    }
    await page.getByTestId('interviews-round-not-held').click();
    await seen(page, 'interviews-round-close-dialog');
    const radios = await page.getByTestId('interviews-round-not-held-reason').getByRole('radio').count();
    const dlg = await snap(page, 'G1b-not-held-dialog', [1440], 'interviews-round-close-dialog');
    await page.getByTestId('interviews-round-close-note').fill('Nobody joined.');
    await dialogOf(page).getByRole('button', { name: 'Mark as not held' }).click();
    await page.getByTestId('interviews-round-close-dialog').waitFor({ state: 'detached', timeout: 20_000 });
    await page.waitForTimeout(800);
    const after = await snap(page, 'G1b-not-held-result', [1440], 'interviews-profile-rounds');
    const apiRound = (await allRounds(gretaA)).find((r) => r.id === I.aikoCoding);
    const rowText = (await page.getByTestId('interviews-profile-rounds').innerText()).replace(/\s+/g, ' ');
    await page.close();
    return { ok: !!apiRound && apiRound.state !== 'ready', detail: `clock offset ${moved.offsetMs ?? moved.status}; ${radios} reason radios; dialog ${fmt(dlg)}; api state ${apiRound?.state}; table "${rowText.slice(0, 200)}"; ${fmt(after)}` };
  });

  await ctx.clock.reset();

  // ── G1c: mark withdrawn ─────────────────────────────────────────────────────────────────────────────────
  await step('G1c', async () => {
    const page = await profileOf(gretaA, SEED.candidates.ravi);
    await page.getByTestId('interviews-profile-withdraw').first().click();
    await page.waitForTimeout(400);
    const confirm = await snap(page, 'G1c-withdraw-confirm', [1440], null);
    const q = await page.getByText(/Mark withdrawn\? Rounds not yet held/).first().innerText().catch(() => '(question text not found)');
    await page.getByRole('button', { name: 'Mark withdrawn' }).last().click();
    await until(async () => (await api(gretaA, 'GET', `/api/interviews/candidates/${SEED.candidates.ravi}`)).body?.applications?.[0]?.stage === 'withdrawn' || (await page.getByTestId('interviews-profile-stage').innerText()).includes('Withdrew'), 15_000);
    await page.waitForTimeout(800);
    const after = await snap(page, 'G1c-withdrawn-profile', [1440], 'interviews-profile-stage');
    const stageText = (await page.getByTestId('interviews-profile-stage').innerText()).replace(/\s+/g, ' ');
    const rounds = (await allRounds(gretaA)).filter((r) => r.candidate?.id === SEED.candidates.ravi).map((r) => `${r.round?.name}:${r.state}`);
    await page.close();
    return { ok: /Withdr(ew|awn)/i.test(stageText) && rounds.every((s) => !/assigned|accepted|ready/.test(s.split(':')[1])), detail: `confirm text "${q.slice(0, 90)}" ${fmt(confirm)}; stage "${stageText.slice(0, 120)}"; Ravi's rounds ${JSON.stringify(rounds)}; ${fmt(after)}` };
  });

  // ── G1d: move stage ─────────────────────────────────────────────────────────────────────────────────────
  await step('G1d-screen', async () => {
    const page = await profileOf(gretaA, SEED.candidates.chloe);
    await page.getByTestId('interviews-profile-move-stage').click();
    const menu = await snap(page, 'G1d-menu-applied', [1440], null);
    const items = (await page.locator('[data-testid^="interviews-profile-move-"]').allInnerTexts()).map((t) => t.trim());
    await page.getByTestId('interviews-profile-move-screen').click();
    await seen(page, 'interviews-stage-move-dialog');
    const dlg = await snap(page, 'G1d-screen-dialog', [1440], 'interviews-stage-move-dialog');
    await dialogOf(page).getByRole('button', { name: 'Start screening' }).click();
    await page.getByTestId('interviews-stage-move-dialog').waitFor({ state: 'detached', timeout: 20_000 });
    await page.waitForTimeout(800);
    const hist = await histOf(page);
    await page.close();
    return { ok: /creening/.test(hist), detail: `menu items ${JSON.stringify(items)} ${fmt(menu)}; dialog ${fmt(dlg)}; history "${hist.slice(0, 140)}"` };
  });

  await step('G1d-hire', async () => {
    // No seeded candidate is at the offer stage: Amara advances Ingrid (debrief) through the API to put her there.
    const view = (await api(amara, 'GET', `/api/interviews/candidates/${SEED.candidates.ingrid}/debrief`)).body?.debrief?.applications?.[0];
    const adv = await api(amara, 'POST', `/api/interviews/applications/${SEED.applications.ingrid}/stage`, { decision: 'advance', reason: 'All three rounds are strong; make the offer.', basedOn: view?.basedOn });
    const page = await profileOf(gretaA, SEED.candidates.ingrid);
    const stage = (await page.getByTestId('interviews-profile-stage').innerText()).replace(/\s+/g, ' ');
    await page.getByTestId('interviews-profile-move-stage').click();
    const menu = await snap(page, 'G1d-menu-offer', [1440], null);
    const items = (await page.locator('[data-testid^="interviews-profile-move-"]').allInnerTexts()).map((t) => t.trim());
    if (!(await page.getByTestId('interviews-profile-move-hire').count())) { await page.close(); return { ok: false, detail: `no "Mark hired" (advance answered ${adv.status}); stage "${stage.slice(0, 100)}"; items ${JSON.stringify(items)}` }; }
    await page.getByTestId('interviews-profile-move-hire').click();
    await seen(page, 'interviews-stage-move-dialog');
    const dlg = await snap(page, 'G1d-hire-dialog', [1440], 'interviews-stage-move-dialog');
    await page.getByTestId('interviews-stage-move-reason').fill('Offer accepted, starting in January.');
    await dialogOf(page).getByRole('button', { name: 'Mark hired' }).click();
    await page.getByTestId('interviews-stage-move-dialog').waitFor({ state: 'detached', timeout: 20_000 });
    await page.waitForTimeout(800);
    const hist = await histOf(page);
    await histShot(page, 'G1d-hired-history');
    await page.close();
    return { ok: /ired/.test(hist), detail: `advance ${adv.status}, stage "${stage.slice(0, 80)}"; items ${JSON.stringify(items)} ${fmt(menu)}; dialog ${fmt(dlg)}; history "${hist.slice(0, 160)}"` };
  });

  await step('G1d-reopen', async () => {
    const page = await profileOf(gretaA, SEED.candidates.ravi);
    await page.getByTestId('interviews-profile-move-stage').click();
    await snap(page, 'G1d-menu-withdrawn', [1440], null);
    await page.getByTestId('interviews-profile-move-reopen').click();
    await seen(page, 'interviews-stage-move-dialog');
    const dlg = await snap(page, 'G1d-reopen-dialog', [1440, 900], 'interviews-stage-move-dialog');
    // A reason that is too short, then a real one.
    await page.getByTestId('interviews-stage-move-reason').fill('no');
    await dialogOf(page).getByRole('button', { name: 'Reopen' }).click();
    await page.waitForTimeout(500);
    const refused = (await dialogOf(page).innerText()).replace(/\s+/g, ' ');
    await snap(page, 'G1d-reopen-too-short', [1440], 'interviews-stage-move-dialog');
    await page.getByTestId('interviews-stage-move-reason').fill('He withdrew by mistake and wants back in.');
    await dialogOf(page).getByRole('button', { name: 'Reopen' }).click();
    await page.getByTestId('interviews-stage-move-dialog').waitFor({ state: 'detached', timeout: 20_000 });
    await page.waitForTimeout(800);
    const hist = await histOf(page);
    await histShot(page, 'G1d-reopened-history');
    await page.close();
    return { ok: /by mistake/.test(hist), detail: `dialog ${fmt(dlg)}; short reason shows "${refused.slice(-110)}"; history "${hist.slice(0, 200)}"` };
  });
  save();

  // ── G1e: no hiring manager (the iOS opening has none in the seed) ───────────────────────────────────────
  await step('G1e', async () => {
    const opening = SEED.openings.ios;
    const page = await gretaA.newPage();
    await page.goto(`${portal}/interviews/openings/${opening}`, { waitUntil: 'domcontentloaded' });
    const onOpening = await seen(page, 'interviews-no-hiring-manager');
    const a = await snap(page, 'G1e-opening-warning', [1440, 1280], 'interviews-no-hiring-manager');
    const warnText = (await page.getByTestId('interviews-no-hiring-manager').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    // The assign form for an iOS candidate with a closed-door stage that still takes a round (Chloe, applied).
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.aiko}/assign`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-assign-form');
    const onAssign = await seen(page, 'interviews-no-hiring-manager', 5000);
    const b = await snap(page, 'G1e-assign-warning', [1440], 'interviews-assign-form');
    // The debrief of an iOS candidate with a finished round: Ravi (scored coding round), as Greta.
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.ravi}/debrief`, { waitUntil: 'domcontentloaded' });
    const onDebrief = await seen(page, 'interviews-debrief-no-decision', 15_000);
    const c = await snap(page, 'G1e-debrief-reason', [1440], 'interviews-debrief-no-decision');
    const reason = (await page.getByTestId('interviews-debrief-no-decision').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
    await page.close();
    return { ok: onOpening && onAssign && onDebrief, detail: `opening warning ${onOpening} "${warnText.slice(0, 120)}" ${fmt(a)}; assign form warning ${onAssign} ${fmt(b)}; debrief reason ${onDebrief} "${reason.slice(0, 140)}" ${fmt(c)}` };
  });
  save();

  // ── G1g: the waiting candidate, the lead not on the room page ───────────────────────────────────────────
  await resetMock();
  const hugoG = await signIn(SEED.cast.interviewer);
  const wenG = await signIn(SEED.cast.interviewer2);
  const gretaG = await signIn(SEED.cast.recruiter);
  await step('G1g', async () => {
    const iv = SEED.panelInterview; // lead Wen, panel Hugo
    const deskOf = async (c) => { const p = await c.newPage(); await p.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' }); await seen(p, 'interviews-my-interviews-table'); return p; };
    const hp = await deskOf(hugoG);
    const wp = await deskOf(wenG);
    const inv = await mintInvite(gretaG, iv);
    if (!inv.linkPath) throw new Error(`no invite for the panel interview: ${inv.status} ${inv.error}`);
    const g = await openGuest(inv.linkPath, { width: 1440 });
    opened.push(g.context);
    await toWaiting(g.page);
    await g.page.waitForTimeout(2500);
    const told = await g.page.getByTestId('join-waiting-told').count();
    const will = await g.page.getByTestId('join-waiting-will-tell').count();
    const telling = await g.page.getByTestId('join-waiting-telling').count();
    const line = told ? 'join-waiting-told' : will ? 'join-waiting-will-tell' : telling ? 'join-waiting-telling' : 'none';
    const cShots = await snap(g.page, 'G1g-candidate-waiting', [1440], 'join-waiting');
    const re = /waiting/i;
    const hb = await bells(hp, re, { ms: 20_000 });
    const hShot = hb.panel ? await snap(hp, 'G1g-hugo-bell', [1440], 'role:dialog') : [];
    await hp.keyboard.press('Escape');
    const wb = await bells(wp, re, { ms: 20_000 });
    const wShot = wb.panel ? await snap(wp, 'G1g-wen-bell', [1440], 'role:dialog') : [];
    const names = (ls) => ls.some((l) => /Hana|Candidate|cand-/i.test(l));
    const opening = (ls) => ls.some((l) => /Senior|Engineering Manager|Backend|iOS|Manager/.test(l));
    const candName = (await api(gretaG, 'GET', `/api/interviews/interviews/${iv}`)).body?.interview?.candidate?.name ?? '';
    const leak = (ls) => (candName ? ls.some((l) => l.includes(candName.split(' ')[0])) : false);
    await g.page.close().catch(() => undefined);
    save();
    const ok = hb.lines.length > 0 && wb.lines.length > 0 && !leak(hb.lines) && !leak(wb.lines);
    return { ok, detail: `candidate line ${line} ${fmt(cShots)}; Hugo's bell ${JSON.stringify(hb.lines.slice(0, 2))} (names the candidate: ${leak(hb.lines)}, names an opening: ${opening(hb.lines)}); Wen's bell ${JSON.stringify(wb.lines.slice(0, 2))} (names the candidate: ${leak(wb.lines)}); ${[...hShot, ...wShot].length ? 'bell shots ' + fmt([...hShot, ...wShot]) : 'no bell panel opened'}; NOT WALKED: the panel member's Admit (who is in the call comes from live sockets the mock world lacks)` };
  });

  for (const c of opened.splice(0)) await c.close().catch(() => undefined);
  save();
  await resetMock();
}
