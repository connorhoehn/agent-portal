// Piece I6.1: consent records on the profile (rows I6.1; decision 5). Consents sit on the profile's Activity tab.
//   I6.1a  the recruiter reads Kwame's Consents: the live round's three answers (Yes) and the assigned round's dashes
//   I6.1b  the opening's hiring manager reads that a notice was given, never an answer (page and API)
//   I6.1c  an interviewer on the same profile finds no Activity tab and no Consents section, and the API answers not-found
// Reads only.
export default async function run({ portal, record, signIn, api, SEED, shootPage }) {
  const kwame = SEED.candidates.kwame;
  const profile = `${portal}/interviews/candidates/${kwame}`;
  const openActivity = async (page) => {
    await page.goto(profile, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
    await page.getByTestId('interviews-profile-tab-activity').click();
    await page.getByTestId('interviews-profile-activity').waitFor({ timeout: 30_000 });
  };

  // ── I6.1a: the recruiter ───────────────────────────────────────────────
  try {
    const context = await signIn(SEED.cast.recruiter);
    const page = await context.newPage();
    await openActivity(page);
    const table = page.getByTestId('interviews-profile-consents');
    await table.getByTestId('interviews-consent-round').first().waitFor({ timeout: 30_000 });
    const headers = (await table.locator('thead th').allInnerTexts()).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const rows = await table.locator('tbody tr').allInnerTexts();
    const live = rows.find((r) => /Coding/.test(r)) ?? '';
    const assigned = rows.find((r) => /design/i.test(r)) ?? '';
    const apiAnswer = await api(context, 'GET', `/api/interviews/candidates/${kwame}/consents`);
    const liveItem = apiAnswer.body?.items?.find((i) => i.interviewId === SEED.interviews.kwameLive);
    const body = await page.getByTestId('interviews-profile-consents-section').innerText();
    const shots = await shootPage(page, 'profile-consents');
    const ok = ['round', 'notice', 'answered', 'recording', 'transcript', 'milo'].every((h) => headers.includes(h))
      && (live.match(/\bYes\b/g) ?? []).length === 3 && /Notice of/.test(live)
      && !/\bYes\b|\bNo\b/.test(assigned) && (assigned.match(/—/g) ?? []).length >= 4
      && apiAnswer.status === 200 && apiAnswer.body.reads === 'answers' && apiAnswer.headers['cache-control'] === 'no-store'
      && liveItem?.answers?.recording?.answer === true && liveItem?.answers?.milo?.answer === true
      && !/\b(cand|app|iv|op)-[a-z0-9]/.test(body) && shots.every((s) => s.ok);
    record('I6.1a', ok, `recruiter: headers [${headers.join(', ')}]; live round "${live.replace(/\s+/g, ' ').slice(0, 90)}"; assigned round "${assigned.replace(/\s+/g, ' ').slice(0, 90)}"; API ${apiAnswer.status} ${apiAnswer.body?.reads}, ${apiAnswer.headers['cache-control']}; ${shots.map((s) => `${s.width}${s.horizontalScroll ? ' scrolls sideways' : ''}`).join(', ')}`);
    await context.close();
  } catch (e) { record('I6.1a', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }

  // ── I6.1b: the opening's hiring manager ────────────────────────────────
  try {
    const context = await signIn(SEED.cast.hiringManager);
    const page = await context.newPage();
    await openActivity(page);
    const table = page.getByTestId('interviews-profile-consents');
    await table.getByTestId('interviews-consent-round').first().waitFor({ timeout: 30_000 });
    const headers = (await table.locator('thead th').allInnerTexts()).map((s) => s.trim().toLowerCase()).filter(Boolean);
    const text = await table.innerText();
    const exportButtons = await page.getByTestId('interviews-milo-export').count();
    const r = await api(context, 'GET', `/api/interviews/candidates/${kwame}/consents`);
    const raw = JSON.stringify(r.body ?? {});
    const ok = headers.includes('notice') && !headers.some((h) => /recording|transcript|milo/.test(h)) && !/\bYes\b|\bNo\b/.test(text)
      && exportButtons === 0 && r.status === 200 && r.body.reads === 'notice'
      && r.body.items.every((i) => i.answers === undefined && i.exportable === undefined) && !/"recording"|"transcription"|"milo"/.test(raw)
      && r.body.items.some((i) => i.interviewId === SEED.interviews.kwameLive && i.answered === true && i.noticeVersion);
    record('I6.1b', ok, `hiring manager: headers [${headers.join(', ')}], ${exportButtons} export buttons; API ${r.status} reads ${r.body?.reads}, answers ${/"recording"/.test(raw) ? 'PRESENT' : 'absent'}`);
    await context.close();
  } catch (e) { record('I6.1b', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }

  // ── I6.1c: an interviewer ──────────────────────────────────────────────
  try {
    const context = await signIn(SEED.cast.interviewer);
    const page = await context.newPage();
    // An interviewer reads nothing on Activity (no stage history since E4 #29, no consents, no deletions), so the tab is
    // not offered at all.
    await page.goto(profile, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
    await page.getByTestId('interviews-profile-tab-rounds').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1000);
    const tabs = await page.getByTestId('interviews-profile-tab-activity').count();
    const sections = await page.getByTestId('interviews-profile-consents-section').count();
    const body = await page.getByTestId('interviews-candidate-profile').innerText();
    const r = await api(context, 'GET', `/api/interviews/candidates/${kwame}/consents`);
    const ok = tabs === 0 && sections === 0 && !/Consents/.test(body) && r.status === 404;
    record('I6.1c', ok, `interviewer: ${tabs} Activity tabs, ${sections} Consents sections on the profile; API ${r.status}`);
    await context.close();
  } catch (e) { record('I6.1c', false, `stopped: ${String(e?.message ?? e).split('\n')[0]}`); }
}
