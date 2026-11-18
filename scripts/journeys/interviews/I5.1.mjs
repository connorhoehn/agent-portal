// Piece I5.1: the interview record on one clock (docs/interviews-tenant-plan.md row I5.1, decisions 4 and 12; hardening lane H4).
// It writes nothing: it reads finished rounds of the seeded world (the steps follow middleware/src/routes/__tests__/
// interviews-record.test.ts "the parts": Mateo's coding round has the stand-in recording, a transcript with names, one Milo
// question marker, two runs (failed, then passed) and a pad log with one paste). A few steps change the record's answer on the
// page (marked in their lines) to reach a state the seeds do not hold; the server's own states are held by that route test.
//   I5.1a  Hugo opens Mateo's record: the stand-in line, the transcript with both names, the code, the markers; nothing to download or share;
//          the answer is never cached and carries no guest id, no code source and no consent answer
//   I5.1b  a click on the question marker: the code pane, the transcript's current line and the player's time agree
//   I5.1c  a click on the paste marker: the same, and the marker names a size, never an accusation
//   I5.1d  a click on each run marker: the same, and the chosen run's output is under the code; again at 1280
//   I5.1e  two runs close together read as one marker naming both (the answer's run times moved on the page)
//   I5.1f  with the recording declined, or deleted (the answer's recording state set on the page), the code and the words still
//          move together
//   I5.1g  a behavioural round (Ingrid's, as Wen and as Amara): the moments list, and a moment moves the transcript
//   I5.1h  who opens it: the recruiter, the hiring manager and the lead; Wen on Mateo's is told not-found; Jonah's round has its record
//   I5.1i  the profile's Recordings tab: its count is the finished rounds the viewer may open, each opens the record (O-263)
// plus the table I5.1.404 (the runner adds that step).
import { consentIn, leaks, miloScoresIn, msOfClock, seen, squash, why } from './h4-kit.mjs';

const CODE = '[data-testid="interviews-record-code-playback"]';
const MARKER = '[data-testid="interviews-record-code-playback-marker"]';
const SEG = '[data-testid="interviews-record-transcript-panel"] [data-seg-index]';

export default async function run(ctx) {
  const { SEED, portal, record, signIn, api, resetMock, shootPage } = ctx;
  await resetMock();
  const MATEO = SEED.interviews.mateoCoding;
  const widths = (shots) => shots.map((s) => `@${s.width}${s.horizontalScroll ? ' scrolls sideways' : ''}`).join(' ');
  const recordApi = (who, id) => api(who, 'GET', `/api/interviews/interviews/${id}/record`);

  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const greta = await signIn(SEED.cast.recruiter);
  const amara = await signIn(SEED.cast.hiringManager);
  const everyone = [hugo, wen, greta, amara];

  // What the page should show at a time, worked out from the raw answers, not from the page.
  const raw = (await recordApi(hugo, MATEO)).body.record;
  const log = (await api(hugo, 'GET', `/api/interviews/interviews/${MATEO}/pad/log?after=0`)).body;
  const startedAt = Date.parse(raw.interview.startedAt);
  const frames = log.events.filter((e) => e.kind === 'snapshot' && typeof e.text === 'string').map((e) => ({ atMs: Math.max(0, Date.parse(e.at) - startedAt), text: e.text })).sort((a, b) => a.atMs - b.atMs);
  const expected = (lines, ms) => ({
    code: squash([...frames].filter((f) => f.atMs <= ms).at(-1)?.text ?? ''),
    line: [...lines].filter((l) => l.atMs <= ms).at(-1) ?? null,
  });

  /** Does the page show, at `ms`, the code of that moment, the line being said and that time? */
  const agree = async (page, lines, ms) => {
    const want = expected(lines, ms);
    const code = squash(await page.locator(`${CODE} .cm-content`).innerText());
    const seg = page.locator(`${SEG}.ring-primary`).first();
    const said = await seg.count() ? squash(await seg.innerText()) : '';
    const shown = msOfClock(await page.getByTestId('interviews-record-code-playback-time').innerText());
    const codeOk = code === want.code;
    const lineOk = !!want.line && said.includes(squash(want.line.text));
    const timeOk = shown !== null && Math.abs(shown - ms) < 1000;
    return { ok: codeOk && lineOk && timeOk, codeOk, lineOk, timeOk, line: want.line?.seq ?? null, shown };
  };
  const markerTimeOf = async (loc) => {
    const label = (await loc.getAttribute('aria-label')) ?? '';
    const m = /, at (\d+:\d{2}(?::\d{2})?)$/.exec(label);
    return { label, ms: m ? msOfClock(m[1]) : null };
  };
  const clickMarker = async (page, selector) => {
    const loc = page.locator(`${MARKER}${selector}`).first();
    await loc.waitFor({ timeout: 15_000 });
    const t = await markerTimeOf(loc);
    await loc.click();
    await page.waitForTimeout(400);
    return t;
  };
  const open = async (who, id, setup) => {
    const page = await who.newPage();
    if (setup) await setup(page);
    await page.goto(`${portal}/interviews/rounds/${id}/record`, { waitUntil: 'domcontentloaded' });
    await seen(page, 'interviews-record');
    return page;
  };
  const technical = async (page) => { await seen(page, 'interviews-record-code-playback'); await seen(page, 'interviews-record-transcript-panel'); await page.waitForTimeout(500); };

  let page = null;
  // ── I5.1a ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  try {
    const res = await recordApi(hugo, MATEO);
    page = await open(hugo, MATEO);
    await technical(page);
    const text = squash(await page.getByTestId('interviews-record').innerText());
    // A stand-in recording is one meta line in the header (E4 lane B), not its own section: read the line there when the section is absent.
    const recordingLine = page.getByTestId('interviews-record-recording-line');
    const recording = (await recordingLine.count()) ? squash(await recordingLine.innerText()) : text;
    const transcript = squash(await page.getByTestId('interviews-record-transcript-panel').innerText());
    const forbidden = await page.getByRole('button', { name: /download|share|copy|export/i }).count() + await page.getByRole('link', { name: /download|share|copy|export/i }).count();
    const markers = await page.locator(MARKER).evaluateAll((els) => els.map((e) => ({ kind: e.getAttribute('data-kind'), label: e.getAttribute('aria-label') })));
    const names = [raw.transcript.lines.find((l) => l.side === 'panel').speaker, raw.transcript.lines.find((l) => l.side === 'candidate').speaker];
    const shots = await shootPage(page, 'record-technical');
    const kinds = [...new Set(markers.map((m) => m.kind))].sort().join(',');
    const ok = res.status === 200 && res.headers['cache-control'] === 'no-store' && leaks(res.body).length === 0 && /Recording: 58 minutes/.test(recording) && /not kept in this demo/.test(recording)
      && names.every((n) => transcript.includes(n)) && kinds === 'paste,question,run' && forbidden === 0 && !consentIn(text) && !miloScoresIn(text) && shots.every((s) => s.ok);
    record('I5.1a', ok, `${raw.interview.candidate.name}'s round: "${recording.slice(0, 70)}…"; transcript names ${names.join(' and ')}; markers ${kinds} (${markers.length}); download/share controls ${forbidden}; Cache-Control ${res.headers['cache-control']}, leaks ${JSON.stringify(leaks(res.body))}; ${widths(shots)}`);
  } catch (e) { record('I5.1a', false, `the technical record: ${why(e)}`); }

  // ── I5.1b / I5.1c: a question marker, a paste marker ──────────────────────────────────────────────────────────────────
  try {
    const t = await clickMarker(page, '[aria-label^="Question: What happens to a request"]');
    const a = await agree(page, raw.transcript.lines, t.ms);
    record('I5.1b', t.ms === raw.markers[0].atMs && a.ok, `the question marker at ${Math.floor(t.ms / 1000)}s: code ${a.codeOk}, transcript line ${a.line} ${a.lineOk}, time readout ${a.shown} ${a.timeOk}`);
  } catch (e) { record('I5.1b', false, `the question marker: ${why(e)}`); }
  try {
    const t = await clickMarker(page, '[data-kind="paste"]');
    const a = await agree(page, raw.transcript.lines, t.ms);
    const named = /^Paste: Paste, \d+ lines?, at \d+:\d{2}$/.test(t.label) || /^Paste: Paste, \d+ lines?[,.]/.test(t.label);
    const accused = /cheat|suspicious|copied|plagiar|stole|dishonest/i.test(t.label);
    record('I5.1c', a.ok && named && !accused, `the paste marker "${t.label}": code ${a.codeOk}, transcript line ${a.line} ${a.lineOk}, time ${a.timeOk}; it names a size and nothing else`);
  } catch (e) { record('I5.1c', false, `the paste marker: ${why(e)}`); }

  // ── I5.1d: the run markers, the output under the code, both widths ────────────────────────────────────────────────────
  try {
    const runs = raw.runs;
    const seen1 = [];
    for (const [i, run] of runs.entries()) {
      const t = await clickMarker(page, `[data-kind="run"][aria-label^="Run: Run ${i + 1}"]`);
      const a = await agree(page, raw.transcript.lines, t.ms);
      const output = squash(await page.getByTestId('interviews-record-run-output').innerText());
      const wanted = squash((run.result?.stderr || run.result?.stdout || '').split('\n').find((l) => l.trim()) ?? '');
      seen1.push({ i: i + 1, a, outputOk: wanted !== '' && output.includes(wanted), status: run.status });
      if (i === runs.length - 1) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.waitForTimeout(400);
        const at1280 = await agree(page, raw.transcript.lines, t.ms);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        seen1.push({ i: 'at 1280', a: at1280, outputOk: true, sideways });
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    }
    const shots = await shootPage(page, 'record-run');
    record('I5.1d', runs.length >= 2 && seen1.every((r) => r.a.ok && r.outputOk && !r.sideways) && shots.every((s) => s.ok),
      seen1.map((r) => `run ${r.i}${r.status ? ` (${r.status})` : ''}: code ${r.a.codeOk}, line ${r.a.lineOk}, time ${r.a.timeOk}${r.i === 'at 1280' ? '' : `, output ${r.outputOk}`}`).join('; ') + `; ${widths(shots)}`);
  } catch (e) { record('I5.1d', false, `the run markers: ${why(e)}`); }
  await page?.close().catch(() => undefined);

  // ── I5.1e: two close runs read as one marker ──────────────────────────────────────────────────────────────────────────
  try {
    const p = await open(hugo, MATEO, async (pg) => {
      await pg.route(`**/api/interviews/interviews/${MATEO}/record`, async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        const first = Date.parse(body.record.runs[0].queuedAt);
        body.record.runs[1].queuedAt = new Date(first + 30_000).toISOString();
        await route.fulfill({ response: res, json: body });
      });
    });
    await technical(p);
    const runMarkers = await p.locator(`${MARKER}[data-kind="run"]`).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    const t = await clickMarker(p, '[data-kind="run"]');
    const a = await agree(p, raw.transcript.lines, t.ms);
    const output = squash(await p.getByTestId('interviews-record-run-output').innerText());
    const first = squash((raw.runs[0].result?.stderr ?? '').split('\n').find((l) => l.trim()) ?? '');
    await p.close();
    record('I5.1e', runMarkers.length === 1 && /Runs 1 and 2/.test(runMarkers[0]) && a.ok && output.includes(first),
      `with the two runs 30 s apart there is ${runMarkers.length} run marker: "${(runMarkers[0] ?? '').slice(0, 70)}"; clicking it: code ${a.codeOk}, line ${a.lineOk}, time ${a.timeOk}; the first run's output is under the code`);
  } catch (e) { record('I5.1e', false, `the merged marker: ${why(e)}`); }

  // ── I5.1f: the recording declined or deleted; the words and the code still move together ──────────────────────────────
  try {
    const lines = [];
    for (const state of ['declined', 'deleted']) {
      const p = await open(hugo, MATEO, async (pg) => {
        await pg.route(`**/api/interviews/interviews/${MATEO}/record`, async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          body.record.recording = { state, playbackUrl: null, durationSeconds: null };
          await route.fulfill({ response: res, json: body });
        });
      });
      await technical(p);
      const line = squash(await p.getByTestId('interviews-record-recording-line').innerText());
      const t = await clickMarker(p, '[data-kind="paste"]');
      const a = await agree(p, raw.transcript.lines, t.ms);
      const t2 = await clickMarker(p, '[data-kind="run"]');
      const a2 = await agree(p, raw.transcript.lines, t2.ms);
      const shots = await shootPage(p, `record-${state}`);
      lines.push({ state, line, ok: a.ok && a2.ok && shots.every((s) => s.ok) && (state === 'declined' ? /chose not to be recorded/ : /has been deleted/).test(line) });
      await p.close();
    }
    record('I5.1f', lines.every((l) => l.ok), lines.map((l) => `${l.state}: "${l.line.slice(0, 60)}…", the paste and run moments agree: ${l.ok}`).join('; '));
  } catch (e) { record('I5.1f', false, `declined or deleted: ${why(e)}`); }

  // ── I5.1g: a behavioural round ────────────────────────────────────────────────────────────────────────────────────────
  try {
    const TOGETHER = SEED.interviews.ingridTogether;
    const t = (await recordApi(wen, TOGETHER)).body.record;
    const rows = [];
    for (const [who, name] of [[wen, 'Wen'], [amara, 'Amara']]) {
      const p = await open(who, TOGETHER);
      await seen(p, 'interviews-record-markers');
      await seen(p, 'interviews-record-transcript-panel');
      const marker = p.getByTestId('interviews-record-marker').first();
      const label = squash(await marker.innerText());
      const at = msOfClock(label);
      await marker.click();
      await p.waitForTimeout(400);
      const line = [...t.transcript.lines].filter((l) => l.atMs <= at).at(-1);
      const said = squash(await p.locator(`${SEG}.ring-primary`).first().innerText());
      const code = await p.getByTestId('interviews-record-code-playback').count();
      if (name === 'Wen') await shootPage(p, 'record-behavioural');
      rows.push({ name, label, at, ok: at === t.markers[0].atMs && /Question asked|Milo asked/.test(label) && said.includes(squash(line.text)) && code === 0 });
      await p.close();
    }
    record('I5.1g', rows.every((r) => r.ok), rows.map((r) => `${r.name}: first moment "${r.label.slice(0, 60)}" moved the transcript to the line said then (${r.ok}); no code pane`).join('; '));
  } catch (e) { record('I5.1g', false, `the behavioural record: ${why(e)}`); }

  // ── I5.1h: who opens it ───────────────────────────────────────────────────────────────────────────────────────────────
  try {
    const seesRecord = async (who, id) => {
      const p = await who.newPage();
      await p.goto(`${portal}/interviews/rounds/${id}/record`, { waitUntil: 'domcontentloaded' });
      const landed = await Promise.any([seen(p, 'interviews-record').then(() => 'record'), p.getByText('Interview not found', { exact: true }).first().waitFor({ timeout: 30_000 }).then(() => 'not-found')]).catch(() => 'neither');
      await p.close();
      return landed;
    };
    const rows = [
      ['Greta (recruiter) on Mateo\'s', await seesRecord(greta, MATEO), 'record'],
      ['Amara (hiring manager) on Mateo\'s', await seesRecord(amara, MATEO), 'record'],
      ['Wen on Mateo\'s', await seesRecord(wen, MATEO), 'not-found'],
      ['Amara on Ravi\'s (iOS)', await seesRecord(amara, SEED.interviews.raviCoding), 'not-found'],
      ['Wen on Jonah\'s (own, no more "none")', await seesRecord(wen, SEED.interviews.jonahLeadership), 'record'],
      ['Greta on a round still to come', await seesRecord(greta, SEED.interviews.mateoDesign), 'not-found'],
    ];
    const jonah = (await recordApi(wen, SEED.interviews.jonahLeadership)).body.record;
    record('I5.1h', rows.every(([, got, want]) => got === want) && jonah.transcript.state === 'available' && jonah.recording.state === 'available',
      `${rows.map(([k, got]) => `${k}: ${got}`).join('; ')}; Jonah's transcript ${jonah.transcript.state}, recording ${jonah.recording.state}`);
  } catch (e) { record('I5.1h', false, `who opens it: ${why(e)}`); }

  // ── I5.1i: the profile's Recordings tab ───────────────────────────────────────────────────────────────────────────────
  try {
    const ENDED = new Set(['ended', 'scored', 'reviewed']);
    const rows = [];
    for (const [who, name] of [[greta, 'recruiter'], [amara, 'hiring manager'], [hugo, 'Hugo'], [wen, 'Wen']]) {
      const profile = (await api(who, 'GET', `/api/interviews/candidates/${SEED.candidates.ingrid}`)).body.candidate;
      const finished = profile.applications.flatMap((a) => a.interviews).filter((r) => ENDED.has(r.state));
      let openable = 0;
      for (const r of finished) if ((await recordApi(who, r.id)).status === 200) openable += 1;
      const p = await who.newPage();
      await p.goto(`${portal}/interviews/candidates/${SEED.candidates.ingrid}`, { waitUntil: 'domcontentloaded' });
      await seen(p, 'interviews-profile-rounds');
      await p.waitForTimeout(400);
      const roundLinks = await p.getByTestId('interviews-profile-round-record').count();
      await p.getByTestId('interviews-profile-tab-recordings').click();
      await seen(p, 'interviews-profile-recordings');
      const links = await p.getByTestId('interviews-profile-recording-open').count();
      const badge = squash(await p.getByTestId('interviews-profile-tab-recordings').innerText());
      let opened = false;
      if (links > 0) {
        await p.getByTestId('interviews-profile-recording-open').first().click();
        opened = await p.waitForURL(/\/interviews\/rounds\/iv-[a-z0-9]+\/record$/, { timeout: 20_000 }).then(() => true).catch(() => false) && await seen(p, 'interviews-record').then(() => true).catch(() => false);
      }
      rows.push({ name, finished: finished.length, openable, links, roundLinks, badge, opened });
      await p.close();
    }
    record('I5.1i', rows.every((r) => r.links === r.finished && r.roundLinks === r.finished && r.finished === r.openable && r.finished >= 1 && r.opened) && rows[0].finished === 2 && rows[1].finished === 2,
      rows.map((r) => `${r.name}: ${r.finished} finished rounds, ${r.openable} open as records, the tab lists ${r.links}, the Rounds tab links ${r.roundLinks}${r.opened ? ', opens the record' : ', did not open'}`).join('; '));
  } catch (e) { record('I5.1i', false, `the Recordings tab: ${why(e)}`); }

  for (const c of everyone) await c.close().catch(() => undefined);
}
