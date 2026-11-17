// Piece I6.3: retention sweeps and deletion on request (row I6.3; decision 17). Deletions and Consents are on the profile's
// Activity tab; the delete prompt is in the page's dock.
//   I6.3a  the recruiter deletes Mateo's media through the prompt: the résumé reads no file, the place reads Removed, the
//          Deletions table reads Done, the stage reasons are replaced, his finished round's code log and runs are gone; a
//          second request changes nothing
//   I6.3b  the opening's hiring manager reads the log, with no way to ask
//   I6.3c  an interviewer finds no log (page and API)
//   I6.3d  four years on: decision records stay just under the period and go just over it; the log keeps the media row;
//          an open round and the live round are untouched
//   I6.3e  the media period on a finished technical round (Kwame's live round, ended here): the pad log and the runs stay
//          a day before the period ends and are gone a day after, in one log row
//   I6.3f  the record page of that round then says in one plain line that its code (the pad log and runs) was removed
//   I6.3g  the seeded record whose period has passed no longer shows its transcript
//   I6.3h  the deletion's receipt and log row name the code log and the runs in words
// The seed's dates are stamped from the wall clock at reset and the offset moves only the interviews clock: every "N days
// after" is computed from what the API returns (endedAt), never from a constant.
const DAY = 86_400_000;
const addYears = (ms, years) => { const d = new Date(ms); d.setUTCFullYear(d.getUTCFullYear() + years); return d.getTime(); };
const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 110);

export default async function run({ portal, out, record, signIn, api, SEED, clock, resetMock, endInterview, shootPage }) {
  const { mateo, kwame } = SEED.candidates;
  const iv = SEED.interviews;
  const profile = (id) => `${portal}/interviews/candidates/${id}`;
  const log = async (ctx, cand) => (await api(ctx, 'GET', `/api/interviews/candidates/${cand}/deletions`)).body;
  const recordOf = async (ctx, id) => (await api(ctx, 'GET', `/api/interviews/interviews/${id}/record`)).body?.record ?? null;
  const padEvents = async (ctx, id) => { const r = await api(ctx, 'GET', `/api/interviews/interviews/${id}/pad/log?after=0`); return r.status === 200 ? r.body.events.length : `status ${r.status}`; };
  const consentOf = async (ctx, cand, id) => (await api(ctx, 'GET', `/api/interviews/candidates/${cand}/consents`)).body?.items?.find((i) => i.interviewId === id) ?? null;
  /** Move the interviews clock to an absolute instant and run one retention sweep there. */
  const sweepAt = async (ms) => { await clock.set(Math.round(ms - Date.now())); return (await clock.sweep('retention')).sweep; };
  const openActivity = async (page, cand) => {
    await page.goto(profile(cand), { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
    await page.getByTestId('interviews-profile-tab-activity').click();
    await page.getByTestId('interviews-profile-activity').waitFor({ timeout: 30_000 });
  };

  // ── I6.3a: the recruiter deletes through the prompt ────────────────────
  await resetMock();
  let stage = 'start';
  let failPage = null;
  try {
    const greta = await signIn(SEED.cast.recruiter);
    const page = await greta.newPage();
    failPage = page;
    const beforeRuns = (await recordOf(greta, iv.mateoCoding))?.runs?.length ?? 0;
    const beforePad = await padEvents(greta, iv.mateoCoding);
    await openActivity(page, mateo);
    stage = 'the Deletions table';
    await page.getByTestId('interviews-profile-deletions').waitFor({ timeout: 30_000 });
    stage = 'the ask button';
    await page.getByTestId('interviews-deletion-ask').click();
    stage = 'the prompt';
    const question = page.getByText(/This removes the recordings/).first();
    await question.waitFor({ timeout: 15_000 });
    const asked = await question.innerText();
    stage = 'the prompt\'s Delete';
    // The deck numbers its options ("1 Delete", "2 Keep everything").
    await page.getByRole('button', { name: /^\s*\d?\s*Delete\s*$/ }).first().click();
    stage = 'the receipt';
    const receiptLine = page.getByText(/^Removed .*résumé/).first();
    await receiptLine.waitFor({ timeout: 15_000 });
    const receipt = (await receiptLine.innerText()).replace(/\s+/g, ' ').trim();
    stage = 'after the receipt';
    // The table and the header follow the request.
    const deletions = page.getByTestId('interviews-profile-deletions');
    await deletions.getByText('Done', { exact: true }).first().waitFor({ timeout: 30_000 });
    const tableText = (await deletions.innerText()).replace(/\s+/g, ' ');
    await page.getByTestId('interviews-profile-redacted').waitFor({ timeout: 30_000 });
    const place = (await page.getByTestId('interviews-profile-location').innerText()).trim();
    const shots = await shootPage(page, 'profile-deletions');
    await page.getByTestId('interviews-profile-tab-resume').click();
    const resume = (await page.getByTestId('interviews-resume-none').innerText({ timeout: 30_000 })).trim();
    const profileApi = await api(greta, 'GET', `/api/interviews/candidates/${mateo}`);
    const reasons = JSON.stringify(profileApi.body ?? {}).match(/Reason removed\./g)?.length ?? 0;
    const afterRuns = (await recordOf(greta, iv.mateoCoding))?.runs?.length ?? -1;
    const afterPad = await padEvents(greta, iv.mateoCoding);
    const first = (await log(greta, mateo)).items;
    const again = await api(greta, 'POST', `/api/interviews/candidates/${mateo}/deletion`, { confirm: true });
    const second = (await log(greta, mateo)).items;
    const ok = /scorecards and the record of their consent answers stay for four years/.test(asked) && /résumé/.test(receipt)
      && /Done/.test(tableText) && /résumé/.test(tableText) && /contact details/.test(tableText)
      && place === 'Removed' && resume === 'No résumé has been added yet.' && reasons >= 1
      && beforeRuns > 0 && typeof beforePad === 'number' && beforePad > 0 && afterRuns === 0 && afterPad === 0
      && first.length === 1 && first[0].reason === 'request' && first[0].doneAt
      && again.status === 200 && again.body.created === false && again.body.deletion.id === first[0].id && second.length === 1
      && shots.every((s) => s.ok);
    record('I6.3a', ok, `receipt "${receipt}"; table "${tableText.slice(-160)}"; prompt ${/stay for four years/.test(asked) ? 'states the record period' : 'MISSING the period'}; place "${place}"; résumé "${resume}"; ${reasons} reasons replaced; Mateo's coding round: runs ${beforeRuns}→${afterRuns}, pad events ${beforePad}→${afterPad}; second ask created=${again.body?.created}, ${second.length} log row`);
    // I6.3h: the log names what went in plain words (portal lib/interviewsRetention.ts KIND_LABELS).
    const named = !/other records/i.test(receipt + tableText) && /code/i.test(receipt) && /run/i.test(receipt);
    record('I6.3h', named, `the receipt and the Deletions table name the pad log and the runs: ${named ? 'yes' : `NO, they read "${receipt}" (finding for the lead: the page has no words for the kinds pad-log, runs, said-log, recaps, coach-log)`}`);
    await greta.close();
  } catch (e) {
    if (failPage) await failPage.screenshot({ path: `${out}/interviews-I6.3a-failed.png` }).catch(() => undefined);
    record('I6.3a', false, `stopped at ${stage}: ${String(e?.message ?? e).split('\n')[0]}`);
  }

  // ── I6.3b: the hiring manager reads the log ────────────────────────────
  try {
    const amara = await signIn(SEED.cast.hiringManager);
    const page = await amara.newPage();
    await openActivity(page, mateo);
    const deletions = page.getByTestId('interviews-profile-deletions');
    await deletions.getByText('Done', { exact: true }).first().waitFor({ timeout: 30_000 });
    const asks = await page.getByTestId('interviews-deletion-ask').count();
    const r = await api(amara, 'GET', `/api/interviews/candidates/${mateo}/deletions`);
    const ok = asks === 0 && r.status === 200 && r.body.items.length === 1 && r.headers['cache-control'] === 'no-store'
      && !/iv-|mail\.example/.test(JSON.stringify(r.body));
    record('I6.3b', ok, `hiring manager: the Deletions table reads "${short(await deletions.innerText())}", ${asks} ask buttons; API ${r.status}, ${r.body?.items?.length} rows`);
    await amara.close();
  } catch (e) { record('I6.3b', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }

  // ── I6.3c: an interviewer finds nothing ────────────────────────────────
  try {
    const hugo = await signIn(SEED.cast.interviewer);
    const page = await hugo.newPage();
    await openActivity(page, mateo);
    await page.getByTestId('interviews-profile-history').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    const sections = await page.getByTestId('interviews-profile-deletions-section').count();
    const r = await api(hugo, 'GET', `/api/interviews/candidates/${mateo}/deletions`);
    const ask = await api(hugo, 'POST', `/api/interviews/candidates/${mateo}/deletion`, { confirm: true });
    record('I6.3c', sections === 0 && r.status === 404 && ask.status === 403, `interviewer: ${sections} Deletions sections; the log ${r.status}; asking ${ask.status}`);
    await hugo.close();
  } catch (e) { record('I6.3c', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }

  // ── I6.3d: four years on ───────────────────────────────────────────────
  await resetMock();
  try {
    const greta = await signIn(SEED.cast.recruiter);
    const { periods } = await log(greta, mateo);
    const ended = Date.parse((await recordOf(greta, iv.mateoCoding)).interview.endedAt);
    const due = addYears(ended, periods.recordYears);
    const designBefore = JSON.stringify(await consentOf(greta, mateo, iv.mateoDesign));
    const under = await sweepAt(due - DAY);
    const rowsUnder = (await log(greta, mateo)).items;
    const consentUnder = await consentOf(greta, mateo, iv.mateoCoding);
    const over = await sweepAt(due + DAY);
    const rowsOver = (await log(greta, mateo)).items;
    const consentOver = await consentOf(greta, mateo, iv.mateoCoding);
    const again = await sweepAt(due + 2 * DAY);
    const rowsAgain = (await log(greta, mateo)).items;
    const kwameRows = (await log(greta, kwame)).items;
    const name = (await api(greta, 'GET', `/api/interviews/candidates/${mateo}`)).body?.candidate?.candidate?.name;
    const live = (await api(greta, 'GET', `/api/interviews/interviews/${iv.kwameLive}`)).body?.interview?.state;
    const designAfter = JSON.stringify(await consentOf(greta, mateo, iv.mateoDesign));
    const kinds = (rows, reason) => rows.filter((r) => r.reason === reason);
    const rec = kinds(rowsOver, 'record-period');
    const ok = kinds(rowsUnder, 'record-period').length === 0 && consentUnder?.answered === true
      && rec.length === 1 && rec[0].interviews === 1 && rec[0].removed.some((x) => x.kind === 'consents') && rec[0].removed.some((x) => x.kind === 'scorecards')
      && consentOver?.answered === false
      && kinds(rowsOver, 'media-period').length === 1 && rowsAgain.length === rowsOver.length
      && kwameRows.length === 0 && live === 'live' && name === 'Mateo Álvarez' && designAfter === designBefore && designBefore !== 'null';
    record('I6.3d', ok, `record period ${periods.recordYears} years after ${new Date(ended).toISOString().slice(0, 10)}: a day under swept ${JSON.stringify(under)} → ${kinds(rowsUnder, 'record-period').length} record rows, consent answered ${consentUnder?.answered}; a day over ${JSON.stringify(over)} → record rows ${rec.length} (${rec[0]?.removed?.map((x) => `${x.kind} ${x.count}`).join(', ')}), consent answered ${consentOver?.answered}; media row kept ${kinds(rowsOver, 'media-period').length}; again ${JSON.stringify(again)} → ${rowsAgain.length} rows; Kwame ${kwameRows.length} rows, live round ${live}; Mateo's name "${name}" (his design round is still open)`);
    await greta.close();
  } catch (e) { record('I6.3d', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }

  // ── I6.3e / I6.3f / I6.3g: the media period on a finished technical round ─
  await resetMock();
  try {
    const hugo = await signIn(SEED.cast.interviewer);
    const greta = await signIn(SEED.cast.recruiter);
    const end = await endInterview(hugo, iv.kwameLive);
    const rec0 = await recordOf(greta, iv.kwameLive);
    const ended = Date.parse(rec0.interview.endedAt);
    const { periods } = await log(greta, kwame);
    const runs0 = rec0.runs.length;
    const pad0 = await padEvents(greta, iv.kwameLive);
    await sweepAt(ended + (periods.mediaDays - 1) * DAY);
    const runsUnder = (await recordOf(greta, iv.kwameLive)).runs.length;
    const padUnder = await padEvents(greta, iv.kwameLive);
    const rowsUnder = (await log(greta, kwame)).items;
    await sweepAt(ended + (periods.mediaDays + 1) * DAY);
    const runsOver = (await recordOf(greta, iv.kwameLive)).runs.length;
    const padOver = await padEvents(greta, iv.kwameLive);
    const rowsOver = (await log(greta, kwame)).items;
    const media = rowsOver.filter((r) => r.reason === 'media-period');
    const removed = Object.fromEntries((media[0]?.removed ?? []).map((x) => [x.kind, x.count]));
    const ok = end.status === 200 && runs0 > 0 && typeof pad0 === 'number' && pad0 > 0
      && runsUnder === runs0 && padUnder === pad0 && rowsUnder.length === 0
      && runsOver === 0 && padOver === 0 && media.length === 1 && media[0].doneAt && removed['pad-log'] === pad0 && removed.runs === runs0;
    record('I6.3e', ok, `ended ${end.status}; media period ${periods.mediaDays} days: a day under runs ${runsUnder}/${runs0}, pad events ${padUnder}/${pad0}, ${rowsUnder.length} log rows; a day over runs ${runsOver}, pad events ${padOver}, log ${media.length} media row removing ${JSON.stringify(removed)}`);

    // I6.3f: the record page says so.
    try {
      const page = await greta.newPage();
      await page.goto(`${portal}/interviews/rounds/${iv.kwameLive}/record`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('interviews-record-body').waitFor({ timeout: 30_000 });
      await page.getByTestId('interviews-record-code-playback').waitFor({ timeout: 30_000 }).catch(() => undefined);
      const code = short(await page.getByTestId('interviews-record-code-section').innerText().catch(() => ''));
      const body = await page.getByTestId('interviews-record-body').innerText();
      const shots = await shootPage(page, 'record-after-media-period');
      // The owner's line (H5 fix): one plain sentence covers the pad log and its runs; the runs' output pane is gone with them.
      const saysCode = body.includes('The code from this interview was removed at the end of its keeping period.');
      const noWritten = !/No code was written/i.test(body);
      const runsGone = (await page.getByTestId('interviews-record-run-output').count()) === 0;
      record('I6.3f', saysCode && noWritten && runsGone && shots.every((s) => s.ok),
        `record page after the period: the code section reads "${code}"; the line that the code was removed at the end of its keeping period: ${saysCode ? 'yes' : 'NO'}; "No code was written" absent: ${noWritten ? 'yes' : 'NO'}; no runs shown: ${runsGone ? 'yes' : 'NO'}`);
      await page.close();
    } catch (e) { record('I6.3f', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }

    // I6.3g: Mateo's coding round ended days before Kwame's, so its period has passed too.
    try {
      const mateoRec = await recordOf(greta, iv.mateoCoding);
      const mateoRows = (await log(greta, mateo)).items.filter((r) => r.reason === 'media-period');
      const removedKinds = (mateoRows[0]?.removed ?? []).map((x) => x.kind);
      const ok = mateoRows.length === 1 && mateoRec.transcript.state !== 'available' && mateoRec.transcript.lines.length === 0;
      record('I6.3g', ok, `Mateo's coding round past its media period: log row removed [${removedKinds.join(', ')}], left [${(mateoRows[0]?.left ?? []).map((x) => `${x.kind} ${x.why}`).join(', ')}]; the record's transcript is "${mateoRec.transcript.state}" with ${mateoRec.transcript.lines.length} lines, the recording "${mateoRec.recording.state}"${mateoRec.transcript.state === 'available' ? ' (finding for the lead: the mock world\'s stand-in transcript outlives its period)' : ''}`);
    } catch (e) { record('I6.3g', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }
    await hugo.close();
    await greta.close();
  } catch (e) { record('I6.3e', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }
  await resetMock();
}
