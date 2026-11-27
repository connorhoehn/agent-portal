// Piece G2: the screens built for the gap audit's second batch that no walk had seen (the ledger's G2 walk). It writes,
// so it puts the mock world back to its seeds first and again at the end. Screenshots go to --out under short names
// (G2a-notes-900.png) with the mechanical facts beside them in G2-facts.json.
//   G2a  Notes in the room: typed, saved, still there after a reload; the tab row at three widths; nobody else reads them
//   G2b  Notes into the scorecard: "Use my notes from the interview" fills the summary, the draft is on the server
//   G2c  Red flags ticked on the scorecard show on the debrief with who ticked them, and not to a second interviewer
//   G2d  A closed opening is not offered to the add-candidate form, and the API refuses it (409)
//   G2e  One record per email: adding a known email to another opening answers the existing candidate
//   G2f  The no-cap warning on the assign form and the prepare page
//   G2g  Settings: the recruiter opens it, an interviewer cannot (page and API)
//   G2h  The stage menu and a cancelled round on the profile at 900 wide
// Every screenshot carries: sideways scroll of the page, and whether the element under test clips its text.
import fs from 'node:fs';
import path from 'node:path';
import { rateAllUI, openRecapStep } from './h4-kit.mjs';

export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, api, endInterview, out, portal } = ctx;
  const facts = [];
  const why = (e) => (e instanceof Error ? e.message.split('\n')[0] : String(e));
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const squash = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const save = () => fs.writeFileSync(path.join(out, 'G2-facts.json'), JSON.stringify(facts, null, 2));

  /** One screenshot per width; `sel` is the element under test (a test id), judged for clipped text. */
  async function snap(page, name, widths, sel) {
    const rows = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      const f = await page.evaluate((s) => {
        const el = s ? document.querySelector(`[data-testid="${s}"]`) : null;
        const clip = el ? (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) : null;
        return { horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, elementFound: !!el, elementClipped: clip };
      }, sel ?? null);
      const file = `${name}-${width}.png`;
      await page.screenshot({ path: path.join(out, file) });
      rows.push({ file, width, ...f });
      facts.push({ file, width, ...f });
    }
    return rows;
  }
  const fmt = (rows) => rows.map((r) => `@${r.width}${r.horizontalScroll ? ' PAGE-SCROLLS-SIDEWAYS' : ' no-hscroll'}${r.elementClipped ? ' CLIPPED' : ''}`).join(' ');
  const roomUrl = (iv) => `${portal}/interviews/rounds/${iv}/room`;
  const myNotes = (who, iv) => api(who, 'GET', `/api/interviews/interviews/${iv}/my-notes`);

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const amara = await signIn(SEED.cast.hiringManager);
  let KWAME = null; // a fresh design round on Mateo's backend application: lead Hugo, Wen on the panel (set up below)
  const NOTE = 'The candidate talked through the retry budget before writing any code. Asked about the fan-out for large accounts without being prompted. Hesitated on the cache invalidation but recovered.';

  // A fresh design round: Hugo leads, Wen sits on the panel (so she is "a second interviewer who has not submitted" for
  // G2c). Hugo accepts it and chooses the Twitter design question, whose answer key carries the red flags G2c ticks.
  const made = await api(greta, 'POST', '/api/interviews/interviews', { applicationId: SEED.applications.mateo, roundId: 'rd-design', leadId: SEED.cast.interviewer, panelIds: [SEED.cast.interviewer2] });
  KWAME = made.body?.interview?.id ?? null;
  if (!KWAME) { record('G2', false, `the setup round was not assigned: ${made.status} ${made.body?.error ?? ''}`); await resetMock(); return; }
  const rev = async (who) => { const r = (await api(who, 'GET', `/api/interviews/interviews/${KWAME}`)).body; return (r?.interview ?? r)?.revision; };
  for (const [who, name] of [[hugo, 'hugo'], [wen, 'wen']]) {
    const notice = (await api(who, 'GET', '/api/interviews/interviews/panel-notice')).body ?? {};
    if (notice.acknowledged === false && notice.notice?.version) await api(who, 'POST', `/api/interviews/interviews/${KWAME}/panel-notice`, { version: notice.notice.version });
  }
  const accepted = await api(hugo, 'POST', `/api/interviews/interviews/${KWAME}/answer`, { revision: await rev(hugo), answer: 'accept' });
  const qset = await api(hugo, 'PUT', `/api/interviews/interviews/${KWAME}/questions`, { revision: await rev(hugo), questionIds: ['q-be-twitter'] });
  // Notes are written in the accepted state, before the round starts (G2a), then it starts and ends (G2b).
  const startsAt = new Date(Math.ceil((Date.now() + 5 * 60_000) / 60_000) * 60_000).toISOString();
  const timed = await ctx.setTime(greta, KWAME, startsAt);
  const setup = `setup: assign ${made.status}, accept ${accepted.status}, questions ${qset.status}, time ${timed.status}`;

  // ── G2a: notes in the room ──────────────────────────────────────────────────────────────────────────────
  await step('G2a', async () => {
    const page = await hugo.newPage();
    await page.goto(roomUrl(KWAME), { waitUntil: 'domcontentloaded' });
    const tab = page.getByRole('tab', { name: /^Notes/ });
    await tab.waitFor({ timeout: 30_000 });
    await tab.click();
    const present = await seen(page, 'interview-room-notes-text', 15_000);
    if (!present) { await snap(page, 'G2a-notes-missing', [1440], null); return { ok: false, detail: `no notes field after opening the Notes tab (${setup})` }; }
    const empty = await snap(page, 'G2a-notes-empty', [1440], 'interview-room-notes');
    const privacy = squash(await page.getByTestId('interview-room-notes').innerText());
    await page.getByTestId('interview-room-notes-text').fill(NOTE);
    const sawSaving = await page.getByTestId('interview-room-notes-state').filter({ hasText: /Saving|Saved/ }).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
    const saved = await page.getByTestId('interview-room-notes-state').filter({ hasText: /^Saved/ }).first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
    const savedShot = await snap(page, 'G2a-notes-saved', [1440], 'interview-room-notes');
    const server = (await myNotes(hugo, KWAME)).body?.notes;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /^Notes/ }).click();
    await seen(page, 'interview-room-notes-text', 20_000);
    await page.waitForTimeout(500);
    const after = await page.getByTestId('interview-room-notes-text').inputValue();
    // The tab row at three widths: one line, none clipped.
    const rowFacts = [];
    const shots = [];
    for (const w of [1440, 1280, 900]) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(500);
      const g = await page.evaluate(() => {
        const list = document.querySelector('[role="tablist"]');
        if (!list) return null;
        const lr = list.getBoundingClientRect();
        const tabs = [...list.querySelectorAll('[role="tab"]')].map((t) => { const r = t.getBoundingClientRect(); return { label: (t.textContent || '').trim().split('\n')[0], top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), clipped: t.scrollWidth > t.clientWidth + 1 }; });
        const tops = new Set(tabs.map((t) => t.top));
        return { count: tabs.length, oneLine: tops.size === 1, listScrolls: list.scrollWidth > list.clientWidth + 1, beyondList: tabs.some((t) => t.right > Math.round(lr.right) + 1 || t.left < Math.round(lr.left) - 1), anyTabClipped: tabs.some((t) => t.clipped), labels: tabs.map((t) => t.label) };
      });
      rowFacts.push({ width: w, ...g });
      shots.push(...await snap(page, 'G2a-notes', [w], 'interview-room-notes'));
    }
    fs.writeFileSync(path.join(out, 'G2a-tabrow.json'), JSON.stringify(rowFacts, null, 2));
    await page.close();
    const wenRead = await myNotes(wen, KWAME);
    const gretaRead = await myNotes(greta, KWAME);
    const wenBody = wenRead.body?.notes?.body ?? null;
    const row900 = rowFacts.find((r) => r.width === 900);
    const rowOk = rowFacts.every((r) => r.oneLine && !r.listScrolls && !r.beyondList && !r.anyTabClipped);
    const ok = sawSaving && saved && server?.body === NOTE && after === NOTE && wenRead.status === 200 && wenBody === '' && ![404, 403].includes(wenRead.status) === true
      ? (rowOk && [404, 403].includes(gretaRead.status)) : false;
    return { ok, detail: `${setup}; empty ${fmt(empty)}; privacy line ${/Only you can see these notes/.test(privacy)}; saving seen ${sawSaving}, "Saved." ${saved}; server holds the text ${server?.body === NOTE} (rev ${server?.revision}); after reload ${after === NOTE}; tab row ${rowFacts.map((r) => `${r.width}:${r.count} tabs ${r.oneLine ? 'one line' : 'WRAPPED'}${r.anyTabClipped || r.beyondList || r.listScrolls ? ' CLIPPED/SCROLLING' : ''}`).join(', ')} (900 labels ${JSON.stringify(row900?.labels)}); ${fmt(shots)}; Wen reads ${wenRead.status} body ${JSON.stringify(wenBody)}; Greta reads ${gretaRead.status}` };
  });
  save();

  // ── G2b: notes into the scorecard ───────────────────────────────────────────────────────────────────────
  let hugoPage = null;
  await step('G2b', async () => {
    const started = await ctx.startInterview(hugo, KWAME);
    const ended = await endInterview(hugo, KWAME);
    const page = await hugo.newPage();
    hugoPage = page;
    await page.goto(`${portal}/interviews/rounds/${KWAME}/scorecard`, { waitUntil: 'domcontentloaded' });
    if (!await seen(page, 'interviews-scorecard-form')) return { ok: false, detail: `no scorecard form after ending the round (start ${started.status}, start ${started.status}, end ${ended.status}; ${setup})` };
    await rateAllUI(page, [3, 4]);
    await openRecapStep(page);
    await page.getByTestId('interviews-scorecard-to-decide').click();
    await seen(page, 'interviews-scorecard-decide-step');
    const offered = await seen(page, 'interviews-scorecard-use-notes', 15_000);
    const offerShot = await snap(page, 'G2b-use-notes-offer', [1440], 'interviews-scorecard-decide-step');
    if (!offered) return { ok: false, detail: `the notes offer is not shown although notes exist (start ${started.status}, start ${started.status}, end ${ended.status}; ${setup}) ${fmt(offerShot)}` };
    const offerText = squash(await page.getByTestId('interviews-scorecard-use-notes').innerText());
    await page.getByTestId('interviews-scorecard-use-notes').click();
    await page.waitForTimeout(300);
    const summary = await page.getByTestId('interviews-scorecard-summary').first().inputValue();
    const filled = await snap(page, 'G2b-summary-filled', [1440], 'interviews-scorecard-summary');
    const offerGone = (await page.getByTestId('interviews-scorecard-use-notes').count()) === 0;
    // The draft is pushed a moment after the change.
    let draft = null;
    for (let n = 0; n < 12 && !(draft?.draft?.draft?.draft?.summary === NOTE); n += 1) {
      await page.waitForTimeout(500);
      draft = (await api(hugo, 'GET', `/api/interviews/interviews/${KWAME}/scorecard-draft`)).body;
    }
    const onServer = draft?.draft?.draft?.draft?.summary === NOTE;
    const line = squash(await page.getByTestId('interviews-scorecard-draft-state').first().innerText().catch(() => ''));
    return { ok: summary === NOTE && onServer && offerGone, detail: `start ${started.status}, end ${ended.status}; offer "${offerText}" ${fmt(offerShot)}; summary equals the notes ${summary === NOTE}; offer gone after use ${offerGone}; server draft holds the summary ${onServer} (rev ${draft?.draft?.draft?.revision}); line "${line}"; ${fmt(filled)}` };
  });
  save();

  // ── G2c: red flags on the debrief ───────────────────────────────────────────────────────────────────────
  await step('G2c', async () => {
    const page = hugoPage ?? await hugo.newPage();
    // Back to the ratings step through the same page: reload (the draft comes from the server), tick, submit.
    await page.goto(`${portal}/interviews/rounds/${KWAME}/scorecard`, { waitUntil: 'domcontentloaded' });
    if (!await seen(page, 'interviews-scorecard-form') && !await seen(page, 'interviews-scorecard-decide-step', 5000) && !await seen(page, 'interviews-scorecard-recap-step', 5000)) return { ok: false, detail: 'the scorecard did not reopen from the server draft' };
    let step_ = (await page.getByTestId('interviews-scorecard-form').count()) ? 'ratings' : (await page.getByTestId('interviews-scorecard-recap-step').count()) ? 'recap' : 'decide';
    if (step_ === 'recap') await page.getByTestId('interviews-scorecard-back-to-ratings').click();
    if (step_ === 'decide') { await page.getByTestId('interviews-scorecard-back-to-recap').click(); await page.getByTestId('interviews-scorecard-back-to-ratings').click(); }
    await seen(page, 'interviews-scorecard-form');
    const flagsBox = page.getByTestId('interviews-scorecard-red-flags');
    if (!await seen(page, 'interviews-scorecard-red-flags', 10_000)) { await snap(page, 'G2c-no-red-flags-form', [1440], null); return { ok: false, detail: `no "Red flags seen" on the form (reopened at ${step_}); ${setup}` }; }
    const groups = await page.getByTestId('interviews-scorecard-red-flag-group').count();
    const boxes = flagsBox.getByRole('checkbox');
    const total = await boxes.count();
    const flagText = squash(await flagsBox.locator('label').first().innerText());
    await boxes.first().check();
    await page.waitForTimeout(300);
    const formShot = await snap(page, 'G2c-red-flags-form', [1440], 'interviews-scorecard-red-flags');
    // Continue to the recap, then the decision, and submit (rated already; summary is the notes).
    await page.getByTestId('interviews-scorecard-to-recap').click();
    const ask = page.getByTestId('interviews-scorecard-ask-option-open');
    if (await ask.count()) await ask.click();
    await seen(page, 'interviews-scorecard-recap-step');
    await page.getByTestId('interviews-scorecard-to-decide').click();
    await seen(page, 'interviews-scorecard-decide-step');
    const rec = page.getByTestId('interviews-scorecard-recommendation');
    if (!(await rec.locator('input:checked').count())) await rec.locator('label').filter({ hasText: /^No$/ }).click();
    if (!(await page.getByTestId('interviews-scorecard-summary').first().inputValue())) await page.getByTestId('interviews-scorecard-summary').first().fill(NOTE);
    await page.getByTestId('interviews-scorecard-submit').click();
    await page.getByTestId('interviews-scorecard-ask-option-submit').click();
    const submitted = await seen(page, 'interviews-scorecard-mine', 20_000);
    const mineFlags = await page.getByTestId('interviews-scorecard-mine').getByTestId('interviews-scorecard-red-flags').count();
    const mineShot = await snap(page, 'G2c-scorecard-submitted', [1440], 'interviews-scorecard-mine');
    // Amara reads the debrief.
    const cand = SEED.candidates.mateo;
    const ap = await amara.newPage();
    await ap.goto(`${portal}/interviews/candidates/${cand}/debrief`, { waitUntil: 'domcontentloaded' });
    const onDebrief = await seen(ap, 'interviews-debrief-red-flag', 20_000);
    const lines = (await ap.getByTestId('interviews-debrief-red-flag').allInnerTexts()).map(squash);
    await ap.getByTestId('interviews-debrief-red-flag').first().scrollIntoViewIfNeeded();
    const debShot = await snap(ap, 'G2c-debrief-flags', [1440, 900], 'interviews-debrief-round');
    await ap.getByTestId('interviews-debrief-red-flag').first().scrollIntoViewIfNeeded();
    await ap.screenshot({ path: path.join(out, 'G2c-debrief-flags-900-scrolled.png') });
    // Wen sits on the panel and has not submitted: she must see none of it, by the page's routes or her own scorecard page.
    const wenCard = await api(wen, 'GET', `/api/interviews/interviews/${KWAME}/scorecard`);
    const wenJson = JSON.stringify(wenCard.body ?? {});
    // Her own form lists the round's flags (view.redFlags) to tick; what she must not get is anyone's ticked ones.
    const ticked = [];
    (function walk(v, at) { if (Array.isArray(v)) v.forEach((x, n) => walk(x, `${at}[${n}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'redFlagsSeen' && Array.isArray(x) && x.length) ticked.push(at + '.' + k); walk(x, `${at}.${k}`); } })(wenCard.body, '$');
    fs.writeFileSync(path.join(out, 'G2c-wen-scorecard-route.json'), JSON.stringify({ othersHidden: wenCard.body?.scorecard?.othersHidden, keys: Object.keys(wenCard.body?.scorecard ?? {}), ticked }, null, 2));
    const wenHasFlags = ticked.length > 0;
    const wenDebrief = await api(wen, 'GET', `/api/interviews/candidates/${cand}/debrief`);
    const wp = await wen.newPage();
    await wp.goto(`${portal}/interviews/rounds/${KWAME}/scorecard`, { waitUntil: 'domcontentloaded' });
    await seen(wp, 'interviews-scorecard-form', 20_000);
    await wp.waitForTimeout(500);
    const wenPageText = squash(await wp.locator('body').innerText());
    const wenShot = await snap(wp, 'G2c-second-interviewer-view', [1440], null);
    const wenPageShows = /ticked by|Hugo Marchetti, .*coding|Red flag:/i.test(wenPageText) && /Red flag/i.test(wenPageText);
    await ap.close(); await wp.close();
    const ok = submitted && onDebrief && lines.some((l) => /ticked by Hugo Marchetti/.test(l)) && !wenHasFlags && !wenPageShows && wenDebrief.status !== 200;
    return { ok, detail: `form: ${groups} groups, ${total} flags, ticked "${flagText.slice(0, 70)}" ${fmt(formShot)}; submitted ${submitted}, own scorecard lists the flag ${mineFlags > 0} ${fmt(mineShot)}; debrief lines ${JSON.stringify(lines)} ${fmt(debShot)}; Wen (not submitted): scorecard route ${wenCard.status} carries ticked flags ${wenHasFlags} ${JSON.stringify(ticked)} (othersHidden ${wenCard.body?.scorecard?.othersHidden}), page shows flags ${wenPageShows}, debrief route ${wenDebrief.status} ${fmt(wenShot)}` };
  });
  save();


  // A helper: change an opening's details through the API (as the editor's Save does), reading its record first.
  const setOpening = async (who, id, patch) => {
    const read = (await api(who, 'GET', `/api/interviews/openings/${id}`)).body;
    const o = read?.opening ?? read;
    const body = { revision: o.revision, title: o.title, level: o.level, team: o.team, location: o.location, hiringManagerId: o.hiringManagerId ?? null, state: o.state, budgetCapUsd: o.budgetCapUsd ?? null, interviewCapUsd: o.interviewCapUsd ?? null, ...patch };
    return api(who, 'PUT', `/api/interviews/openings/${id}/details`, body);
  };
  // The list's rows are applications: people are the distinct candidate ids on them.
  const people = async () => { const items = (await api(greta, 'GET', '/api/interviews/candidates')).body?.items ?? []; return { rows: items.length, people: new Set(items.map((c) => c.candidate?.id ?? c.candidateId ?? c.id)).size }; };
  const candidateCount = async () => (await people()).people;
  const deepList = (v, key) => { if (v && typeof v === 'object') { if (Array.isArray(v[key])) return v[key]; for (const x of Object.values(v)) { const r = deepList(x, key); if (r) return r; } } return null; };

  // ── G2d: a paused opening refuses candidates ────────────────────────────────────────────────────────────
  await step('G2d', async () => {
    const em = SEED.openings.em;
    const paused = await setOpening(greta, em, { state: 'paused' });
    const page = await greta.newPage();
    await page.goto(`${portal}/interviews/candidates/new`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-new-candidate-form');
    await page.waitForTimeout(800);
    await page.getByTestId('interviews-candidate-opening').click();
    await page.getByRole('option').first().waitFor({ timeout: 8000 }).catch(() => undefined);
    const options = (await page.getByRole('option').allInnerTexts()).map(squash);
    const shot = await snap(page, 'G2d-add-candidate-paused', [1440], 'interviews-new-candidate-form');
    await page.keyboard.press('Escape');
    await page.close();
    const before = await candidateCount();
    const post = await api(greta, 'POST', '/api/interviews/candidates', { name: 'Test Person', email: 'test.person@example.com', openingId: em });
    const after = await candidateCount();
    const emTitle = ((await api(greta, 'GET', `/api/interviews/openings/${em}`)).body?.opening ?? {}).title ?? '';
    await setOpening(greta, em, { state: 'open' }); // back to open for the steps after
    const offered = options.some((o) => emTitle && o.startsWith(emTitle));
    const openOnes = options.filter((o) => o && !/Choose an opening/.test(o));
    const sentence = post.body?.error ?? '';
    return { ok: paused.status === 200 && openOnes.length >= 2 && !offered && post.status === 409 && !!sentence && after === before, detail: `pause ${paused.status}; options ${JSON.stringify(options)} (${openOnes.length} openings offered); paused opening "${emTitle}" offered ${offered}; ${fmt(shot)}; API add answered ${post.status} "${sentence}"; candidates ${before} -> ${after}` };
  });
  save();

  // ── G2e: one record per email ───────────────────────────────────────────────────────────────────────────
  await step('G2e', async () => {
    const mateo = SEED.candidates.mateo;
    const find = (v) => { if (v && typeof v === 'object') { if (typeof v.email === 'string' && v.email) return v.email; for (const x of Object.values(v)) { const r = find(x); if (r) return r; } } return null; };
    const read = (await api(greta, 'GET', `/api/interviews/candidates/${mateo}`)).body;
    const email = find(read) ?? find(((await api(greta, 'GET', '/api/interviews/candidates')).body?.items ?? []).find((c) => c.id === mateo || c.candidate?.id === mateo));
    if (!email) return { ok: false, detail: `could not read the seeded candidate's email from the API (keys ${JSON.stringify(Object.keys(read ?? {}))}); the email is not on the wire to the recruiter, so the walk cannot type it` };
    const before = await people();
    const page = await greta.newPage();
    await page.goto(`${portal}/interviews/candidates/new`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-new-candidate-form');
    await page.getByTestId('interviews-candidate-name').fill('M. Alvarez');
    await page.getByTestId('interviews-candidate-email').fill(email.toUpperCase());
    await page.waitForTimeout(800);
    await page.getByTestId('interviews-candidate-opening').click();
    await page.getByRole('option', { name: /iOS/i }).first().click();
    const form = await snap(page, 'G2e-add-known-email', [1440], 'interviews-new-candidate-form');
    await page.getByTestId('interviews-new-candidate-create').click();
    await page.getByTestId('collection-command-composer-prompts').getByRole('button', { name: 'Add candidate' }).click();
    await page.waitForURL(/\/interviews\/candidates\/cand-/, { timeout: 20_000 }).catch(() => undefined);
    const landed = page.url().split('/').pop();
    await seen(page, 'interviews-profile-rounds', 20_000);
    await page.waitForTimeout(800);
    const after = await people();
    const apps = deepList((await api(greta, 'GET', `/api/interviews/candidates/${mateo}`)).body, 'applications') ?? [];
    const profile = await snap(page, 'G2e-profile-two-applications', [1440], null);
    const text = squash(await page.locator('main, body').first().innerText());
    const openingsShown = ['Backend', 'iOS'].filter((w) => text.includes(w));
    await page.close();
    return { ok: landed === mateo && after.people === before.people && apps.length === 2, detail: `typed the seeded email in capitals; landed on ${landed} (existing ${mateo}) ${landed === mateo}; people ${before.people} -> ${after.people} (list rows ${before.rows} -> ${after.rows}); applications by API ${apps.length}; page mentions ${JSON.stringify(openingsShown)}; ${fmt(form)} ${fmt(profile)}` };
  });
  save();

  // ── G2f: the no-cap warning ─────────────────────────────────────────────────────────────────────────────
  await step('G2f', async () => {
    const ios = SEED.openings.ios;
    const cleared = await setOpening(greta, ios, { budgetCapUsd: null, interviewCapUsd: null });
    const page = await greta.newPage();
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.aiko}/assign`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-assign-form');
    const onAssign = await seen(page, 'interviews-no-spending-cap', 10_000);
    const a = await snap(page, 'G2f-assign-nocap', [1440, 900], 'interviews-no-spending-cap');
    const text = squash(await page.getByTestId('interviews-no-spending-cap').first().innerText().catch(() => ''));
    await page.close();
    const wp = await wen.newPage();
    await wp.goto(`${portal}/interviews/rounds/${SEED.interviews.aikoCoding}/prepare`, { waitUntil: 'domcontentloaded' });
    const onPrepare = await seen(wp, 'interviews-no-spending-cap', 20_000);
    const b = await snap(wp, 'G2f-prepare-nocap', [1440, 900], 'interviews-no-spending-cap');
    const text2 = squash(await wp.getByTestId('interviews-no-spending-cap').first().innerText().catch(() => ''));
    await wp.close();
    return { ok: cleared.status === 200 && onAssign && onPrepare, detail: `cap cleared ${cleared.status}; assign form warning ${onAssign} "${text.slice(0, 130)}" ${fmt(a)}; prepare page warning ${onPrepare} "${text2.slice(0, 130)}" ${fmt(b)}` };
  });
  save();

  // ── G2g: settings ───────────────────────────────────────────────────────────────────────────────────────
  await step('G2g', async () => {
    const page = await greta.newPage();
    await page.goto(`${portal}/interviews/openings`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-settings-link');
    await page.getByTestId('interviews-settings-link').click();
    const onSettings = await seen(page, 'interviews-settings-table', 20_000);
    await page.waitForTimeout(600);
    const rows = await page.getByTestId('interviews-settings-table').locator('tbody tr').count();
    const shots = await snap(page, 'G2g-settings', [1440, 900], 'interviews-settings-table');
    await page.close();
    const hp = await hugo.newPage();
    await hp.goto(`${portal}/interviews/settings`, { waitUntil: 'domcontentloaded' });
    await hp.waitForTimeout(2500);
    const hugoSees = (await hp.getByTestId('interviews-settings').count()) > 0 || (await hp.getByTestId('interviews-settings-table').count()) > 0;
    const hugoUrl = hp.url().replace(portal, '');
    await snap(hp, 'G2g-settings-as-interviewer', [1440], null);
    await hp.close();
    const hugoApi = await api(hugo, 'GET', '/api/interviews/settings');
    const gretaApi = await api(greta, 'GET', '/api/interviews/settings');
    return { ok: onSettings && rows > 0 && !hugoSees && [403, 404].includes(hugoApi.status) && gretaApi.status === 200, detail: `recruiter: table ${onSettings}, ${rows} rows ${fmt(shots)}, API ${gretaApi.status}; interviewer: page shows settings ${hugoSees} (at ${hugoUrl}), API ${hugoApi.status}` };
  });
  save();

  // ── G2h: the stage menu and a cancelled round at 900 ────────────────────────────────────────────────────
  await step('G2h', async () => {
    const page = await greta.newPage();
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.nadia}`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-profile-rounds');
    const row = page.getByTestId('interviews-profile-rounds').locator('tr', { hasText: /System design|Design/ }).first();
    await row.waitFor({ timeout: 20_000 });
    const rowsText = squash(await page.getByTestId('interviews-profile-rounds').innerText());
    const stage = { at: 'opening the row menu' };
    try {
      await row.getByTestId('interviews-profile-round-actions').click({ timeout: 8000 });
      stage.at = 'choosing Cancel round';
      await page.getByTestId('interviews-round-cancel').click({ timeout: 8000 });
    } catch (e) { await snap(page, 'G2h-stuck', [900], null); return { ok: false, detail: `stuck ${stage.at}: ${why(e)}; rounds table "${rowsText.slice(0, 260)}"` }; }
    await seen(page, 'interviews-round-close-dialog');
    await page.getByTestId('interviews-round-close-note').fill('The panel is not free that day.');
    const dlgBtn = page.locator('[role="dialog"], [role="alertdialog"]').last().getByRole('button', { name: 'Cancel round' });
    try { await dlgBtn.click({ timeout: 8000 }); } catch (e) {
      await snap(page, 'G2h-dialog-stuck', [900], null);
      return { ok: false, detail: `the dialog's "Cancel round" would not click: ${why(e)}; dialog says "${squash(await page.locator('[role="dialog"], [role="alertdialog"]').last().innerText().catch(() => '')).slice(0, 300)}"` };
    }
    await page.getByTestId('interviews-round-close-dialog').waitFor({ state: 'detached', timeout: 20_000 });
    await page.waitForTimeout(800);
    const cancelled = await snap(page, 'G2h-cancelled-round', [900], 'interviews-profile-rounds');
    const again = await page.getByTestId('interviews-profile-assign-again').count();
    await page.setViewportSize({ width: 900, height: 900 });
    // The stage menu is offered where a stage can be moved by hand (Chloe, applied: Start screening), not on an
    // interviewing candidate, who moves on through the debrief. Open Chloe's profile at 900.
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(`${portal}/interviews/candidates/${SEED.candidates.chloe}`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-profile-rounds');
    await page.waitForTimeout(600);
    const reach = { moveStage: await page.getByTestId('interviews-profile-move-stage').count(), visible: await page.getByTestId('interviews-profile-move-stage').first().isVisible().catch(() => false) };
    if (!reach.visible) {
      await snap(page, 'G2h-stage-menu-missing', [900], null);
      return { ok: false, detail: `"Move stage" is not reachable on an applied candidate at 900 wide: ${JSON.stringify(reach)}; the cancelled round itself reads fine (${again} Assign again, ${fmt(cancelled)})` };
    }
    await page.getByTestId('interviews-profile-move-stage').click();
    await page.waitForTimeout(400);
    const items = (await page.locator('[data-testid^="interviews-profile-move-"]').allInnerTexts()).map(squash);
    const menuFacts = await page.evaluate(() => {
      const m = document.querySelector('[role="menu"]'); if (!m) return null;
      const r = m.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), inViewport: r.left >= 0 && r.right <= innerWidth, clipped: m.scrollWidth > m.clientWidth + 1 };
    });
    const menu = await snap(page, 'G2h-stage-menu', [900], null);
    await page.close();
    return { ok: again >= 1 && items.length > 0 && (menuFacts ? menuFacts.inViewport && !menuFacts.clipped : true) && !cancelled[0].horizontalScroll && !menu[0].horizontalScroll, detail: `cancelled row ${fmt(cancelled)}, ${again} Assign again; stage menu items ${JSON.stringify(items)} geometry ${JSON.stringify(menuFacts)} ${fmt(menu)}` };
  });

  await resetMock();
  save();
}
