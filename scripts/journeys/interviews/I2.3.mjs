// Piece I2.3: the candidate's steps before the call (docs/interviews-tenant-plan.md row I2.3; UI round 2's frame).
// Every candidate starts from mintInvite(recruiter) → openGuest(linkPath), a context with no account.
//   I2.3a  link → the notice and three answers → the device check → the waiting room; the strip marks each step; the
//          waiting page names the lead and nobody else; shots of each page at both widths; nothing panel-side on them
//   I2.3b  the lead answers "not yet": the turned-away line, "Ask to join again", and the lead reads "waiting" again
//   I2.3c  "Change my answers" from the waiting room: the answers come back as given, and Continue returns straight to
//          the waiting room (the device check runs once a visit)
//   I2.3d  the eight answer combinations: each ends on the waiting step with the strip on Waiting, the stored answers
//          are the given ones (Milo off whenever the transcript is), Milo's question is locked off with its sentence
//          when the transcript is declined, and the recruiter's consent effects name exactly what is off
//   I2.3e  the late candidate (O-206): the lead has started; the candidate lands, gives first answers, knocks and is
//          let in to the room
//   I2.3f  the late candidate changes an answer: refused in words, the stored answer stands, "Back to waiting" goes
//          back on the stored answers, and the lead's Admit reaches the page without a reload
export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, mintInvite, openGuest, answerConsents, toWaiting, waiting, admit, startInterview,
    api, guestApi, shootPage } = ctx;
  const iv = SEED.guestInterview;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const strip = async (page) => (await page.getByTestId('join-steps').locator('[aria-current]').first().innerText().catch(() => '')).trim();
  const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };
  const opened = [];
  const open = async (linkPath) => { const g = await openGuest(linkPath); opened.push(g.context); return g; };

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  // What the panel holds for this round: nothing of it may reach a candidate's page.
  const room = (await api(hugo, 'GET', `/api/interviews/interviews/${iv}/room`)).body?.room;
  const prompts = (room?.questions ?? []).map((q) => q.prompt.slice(0, 40));
  const panelSide = (text, allowedNames) => {
    const hits = prompts.filter((p) => text.includes(p)).map(() => 'a question');
    if (/scorecard/i.test(text)) hits.push('"scorecard"');
    if (/suggest/i.test(text)) hits.push('"suggest"');
    for (const name of Object.values(SEED.names)) if (text.includes(name) && !allowedNames.includes(name)) hits.push(name);
    return hits;
  };
  let guest = null;

  await step('I2.3a', async () => {
    const invite = await mintInvite(greta, iv);
    guest = await open(invite.linkPath);
    const marks = {};
    const leaks = [];
    marks.landing = await strip(guest.page);
    leaks.push(...panelSide(await guest.page.locator('body').innerText(), []));
    await guest.page.getByTestId('join-continue').click();
    await seen(guest.page, 'join-consents');
    marks.consents = await strip(guest.page);
    const consentShots = await shootPage(guest.page, 'guest-consents');
    await answerConsents(guest.page);
    await seen(guest.page, 'join-devices');
    marks.devices = await strip(guest.page);
    leaks.push(...panelSide(await guest.page.locator('body').innerText(), []));
    const deviceShots = await shootPage(guest.page, 'guest-devices');
    await guest.page.getByTestId('join-devices-continue').click();
    await seen(guest.page, 'join-waiting');
    marks.waiting = await strip(guest.page);
    const meeting = (await guest.page.getByTestId('join-waiting-meeting').innerText().catch(() => '')).trim();
    const waitText = await guest.page.locator('body').innerText();
    leaks.push(...panelSide(waitText, [SEED.names[SEED.cast.interviewer]]));
    const waitShots = await shootPage(guest.page, 'guest-waiting');
    // E4 #31: the header names the role's interview, never the staff tenant ("Candidates").
    const brand = (await guest.page.locator('header').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    const lead = await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    const shots = [...consentShots, ...deviceShots, ...waitShots];
    const ok = marks.landing === 'Invitation' && marks.consents === 'Your answers' && marks.devices === 'Camera and microphone' && marks.waiting === 'Waiting'
      && meeting === 'You are meeting Hugo Marchetti.' && leaks.length === 0 && lead && shots.every((s) => s.ok)
      && / interview\b/.test(brand) && !/Candidates/.test(brand);
    return { ok, detail: `strip ${JSON.stringify(marks)}; header "${brand}"; waiting says "${meeting}"; the lead reads ${lead ? 'waiting' : 'NOT waiting'}; panel-side on the pages: ${leaks.join(', ') || 'none'}; shots ${shots.filter((s) => !s.ok).length} scroll sideways` };
  });

  await step('I2.3b', async () => {
    const no = await admit(hugo, iv, false);
    const away = await seen(guest.page, 'join-turned-away');
    const line = away ? (await guest.page.getByTestId('join-turned-away').innerText()).trim() : '';
    const awayText = await guest.page.locator('body').innerText();
    const leaks = panelSide(awayText, [SEED.names[SEED.cast.interviewer]]);
    await guest.page.getByTestId('join-knock-again').click();
    const back = await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    const waitingAgain = !(await guest.page.getByTestId('join-turned-away').count());
    return { ok: no.status === 200 && line === 'Your interviewer could not let you in just now.' && back && waitingAgain && leaks.length === 0,
      detail: `not yet ${no.status}; the candidate reads "${line}"; knock again → the lead reads ${back ? 'waiting' : 'NOT waiting'}; panel-side ${leaks.join(', ') || 'none'}` };
  });

  await step('I2.3c', async () => {
    await guest.page.getByTestId('join-change-answers').click();
    await seen(guest.page, 'join-consents');
    const checked = {};
    for (const part of ['recording', 'transcription', 'milo']) {
      checked[part] = await guest.page.getByTestId(`join-consent-${part}-choice`).locator('input:checked').evaluate((el) => el.closest('label')?.innerText.trim() ?? el.value).catch(() => null);
    }
    await guest.page.getByTestId('join-consents-continue').click();
    const devices = await seen(guest.page, 'join-devices', 3000);
    const back = await seen(guest.page, 'join-waiting');
    return { ok: Object.values(checked).every((v) => /yes|true/i.test(String(v))) && !devices && back,
      detail: `the answers came back ${JSON.stringify(checked)}; Continue went ${devices ? 'to the device check AGAIN' : 'straight'} to ${back ? 'waiting' : 'somewhere else'}` };
  });

  await step('I2.3d', async () => {
    const results = [];
    const bad = [];
    for (const recording of [true, false]) for (const transcription of [true, false]) for (const milo of [true, false]) {
      const answers = { recording, transcription, milo };
      const name = `r${+recording}t${+transcription}m${+milo}`;
      await resetMock();
      const invite = await mintInvite(greta, iv);
      const g = await open(invite.linkPath);
      await g.page.getByTestId('join-continue').click();
      await seen(g.page, 'join-consents');
      // Answer the transcript first: with it declined Milo's question must be locked off, with its sentence.
      await g.page.getByTestId('join-consent-transcription-choice').locator('label').filter({ hasText: transcription ? /^Yes$/ : /^No$/ }).click();
      const miloBlock = g.page.getByTestId('join-consent-milo');
      const locked = await g.page.getByTestId('join-consent-milo-choice').locator('input').first().isDisabled();
      const lockLine = /Milo is off because you said no to the transcript: Milo needs it\./.test(await miloBlock.innerText());
      if (transcription === false && !(locked && lockLine)) bad.push(`${name}: Milo not locked off`);
      if (transcription === true && locked) bad.push(`${name}: Milo locked with the transcript on`);
      const at = await toWaiting(g.page, answers).catch((e) => `error ${e.message.split('\n')[0]}`);
      const mark = await strip(g.page);
      const stored = (await guestApi(g.context, 'GET', '/consents')).body?.answers ?? {};
      const effects = (await api(greta, 'GET', '/api/interviews/consent-effects')).body?.items?.find((i) => i.interviewId === iv);
      const wantStored = { recording, transcription, milo: transcription && milo };
      const wantOff = [!recording && 'recording', !transcription && 'transcription', !(transcription && milo) && 'milo'].filter(Boolean);
      const storedOk = ['recording', 'transcription', 'milo'].every((p) => stored[p] === wantStored[p]);
      const offOk = effects?.answered === true && JSON.stringify([...(effects?.off ?? [])].sort()) === JSON.stringify([...wantOff].sort()) && effects?.blocked === false;
      if (at !== 'waiting' || mark !== 'Waiting') bad.push(`${name}: ended on ${at}, strip ${mark}`);
      if (!storedOk) bad.push(`${name}: stored ${JSON.stringify(stored)}`);
      if (!offOk) bad.push(`${name}: effects ${JSON.stringify(effects)}`);
      results.push(`${name}→${at}`);
      await g.context.close();
    }
    return { ok: bad.length === 0 && results.length === 8, detail: bad.length ? bad.slice(0, 4).join('; ') : `${results.join(' ')}; Milo locked off with its sentence in the four combinations without a transcript; the recruiter's effects match each` };
  });

  await step('I2.3e', async () => {
    await resetMock();
    const started = await startInterview(hugo, iv);
    const invite = await mintInvite(greta, iv);
    if (started.status !== 200 || invite.status !== 201) return { ok: false, detail: `start ${started.status}, mint ${invite.status} ${invite.error ?? ''}` };
    const g = await open(invite.linkPath);
    const at = await toWaiting(g.page);
    const stored = (await guestApi(g.context, 'GET', '/consents')).body?.answers ?? {};
    const lead = await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    const yes = await admit(hugo, iv, true);
    const inRoom = await seen(g.page, 'join-room');
    return { ok: at === 'waiting' && stored.recording === true && lead && yes.status === 200 && inRoom,
      detail: `the lead started first (${started.status}); the candidate's first answers are taken (${JSON.stringify(stored)}) → ${at}; the lead reads ${lead ? 'waiting' : 'NOT waiting'}; admitted ${yes.status}, the page ${inRoom ? 'opens the room' : 'did NOT open the room'}` };
  });

  // After the start a change is refused in words and the stored answer stands. The refusal offers "Back to waiting" on
  // the stored answers, and the lead's Admit then reaches the page without a reload.
  await step('I2.3f', async () => {
    await resetMock();
    await startInterview(hugo, iv);
    const invite = await mintInvite(greta, iv);
    const g = await open(invite.linkPath);
    await toWaiting(g.page);
    await g.page.getByTestId('join-change-answers').click();
    await seen(g.page, 'join-consents');
    await g.page.getByTestId('join-consent-recording-choice').locator('label').filter({ hasText: /^No$/ }).click();
    await g.page.getByTestId('join-consents-continue').click();
    const refused = await seen(g.page, 'join-consents-message', 15_000);
    const message = refused ? (await g.page.getByTestId('join-consents-message').innerText()).trim() : '';
    const stored = (await guestApi(g.context, 'GET', '/consents')).body?.answers ?? {};
    await shootPage(g.page, 'I2.3f-late-refused').catch(() => undefined);
    await g.page.getByTestId('join-consents-back').click({ timeout: 5_000 }).catch(() => undefined);
    const backToWaiting = await seen(g.page, 'join-waiting', 10_000);
    await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    await admit(hugo, iv, true);
    const roomWithoutReload = await seen(g.page, 'join-room', 15_000);
    let afterReload = roomWithoutReload;
    if (!roomWithoutReload) { await g.page.reload({ waitUntil: 'domcontentloaded' }); afterReload = await seen(g.page, 'join-room'); }
    const wordsOk = message === 'Your interview has started, so these answers can no longer be changed.' && stored.recording === true;
    return { ok: wordsOk && backToWaiting && roomWithoutReload,
      detail: `a change reads "${message}", the stored recording answer is ${stored.recording}; Back to waiting ${backToWaiting ? 'returns to waiting' : 'is missing and the page stays on the answers'}; Admit ${roomWithoutReload ? 'reaches the page' : `does NOT reach the page (a reload ${afterReload ? 'opens the room' : 'does not help'})`}` };
  });

  for (const c of opened) await c.close().catch(() => undefined);
  await greta.close(); await hugo.close();
  await resetMock();
}
