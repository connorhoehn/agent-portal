// Piece I2.5: declined consent (docs/interviews-tenant-plan.md row I2.5, decision 5; the held page of row I6.4). The
// candidate starts from mintInvite(recruiter) → openGuest(linkPath) (or the API's guestSession for the eight combinations).
//   I2.5a  the candidate declines the transcript on the page → the recruiter's bell says the round runs with no
//          transcript, no Milo, and names no candidate → Upcoming's consent column reads "No transcript, no Milo" → the
//          lead's read of the answers says what is off (and nothing else)
//   I2.5c  the eight combinations against D2: a candidate who answered and was let in asks D2 with their own realtime
//          token: record follows the recording answer alone, transcribe the transcript answer alone; before Admit, D2
//          refuses (no seat)
//   I2.5b  a required part declined (row I6.4): the held page with its four lines, Change my answers → yes → the
//          waiting room. The mock world requires no part (INTERVIEWS_REQUIRED_CONSENTS is an environment setting with
//          no mock route), so this step runs only when the walk's environment sets it (e.g. "transcription"); otherwise
//          it prints NOT RUN.
// Written, not run (no call starts without platform-api): the lead's bar reading "Milo is off" in place of Invite Milo.
export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, mintInvite, openGuest, toWaiting, answerConsents, waiting, admit, bells, api, guestApi,
    guestSession, guestConsents, portal } = ctx;
  const iv = SEED.guestInterview;
  const lobbyName = `interviews:interview:${iv}`;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };
  const d2 = async (token) => {
    const r = await fetch(`${portal}/api/realtime/recording-decision`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ lobbyName }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);

  await step('I2.5a', async () => {
    const desk = await greta.newPage();
    await desk.goto(`${portal}/interviews/upcoming`, { waitUntil: 'domcontentloaded' });
    await desk.getByTestId('activity-bell').first().waitFor({ timeout: 30_000 });
    const invite = await mintInvite(greta, iv);
    const g = await openGuest(invite.linkPath);
    const at = await toWaiting(g.page, { recording: true, transcription: false, milo: false });
    const bell = await bells(desk, /Coding for Senior Backend Engineer runs with/);
    const line = bell.lines[0] ?? '';
    await desk.keyboard.press('Escape');
    await desk.reload({ waitUntil: 'domcontentloaded' });
    const row = desk.getByTestId('interviews-upcoming').locator('tr', { hasText: 'Mateo' }).first();
    await row.waitFor({ timeout: 30_000 });
    const column = (await row.getByTestId('interviews-upcoming-consent').innerText().catch(() => '')).trim();
    const read = await api(hugo, 'GET', `/api/interviews/interviews/${iv}/consents`);
    const leadKeys = Object.keys(read.body ?? {}).sort().join(',');
    await g.context.close();
    await desk.close();
    const ok = at === 'waiting' && /runs with no transcript, no Milo/.test(line) && !/Mateo/.test(line) && column === 'No transcript, no Milo'
      && read.status === 200 && JSON.stringify([...(read.body?.off ?? [])].sort()) === '["milo","transcription"]';
    return { ok, detail: `the candidate ${at}; the recruiter's bell "${line.slice(0, 90)}"; Upcoming reads "${column}"; the lead's read ${read.status} (${leadKeys}) off ${JSON.stringify(read.body?.off)}` };
  });

  await step('I2.5c', async () => {
    const bad = [];
    const seenCombos = [];
    for (const recording of [true, false]) for (const transcription of [true, false]) for (const milo of [true, false]) {
      await resetMock();
      const invite = await mintInvite(greta, iv);
      const g = await guestSession(invite.token);
      const saved = await guestConsents(g.context, { recording, transcription, milo });
      await guestApi(g.context, 'POST', '/knock');
      const token = (await guestApi(g.context, 'GET', '/realtime-token')).body?.token;
      const before = await d2(token);
      await admit(hugo, iv, true);
      const after = await d2(token);
      const name = `r${+recording}t${+transcription}m${+milo}`;
      if (saved.status !== 200) bad.push(`${name}: answers ${saved.status}`);
      if (before.status !== 403) bad.push(`${name}: before Admit D2 ${before.status}`);
      if (after.status !== 200 || after.body?.record !== recording || after.body?.transcribe !== transcription) bad.push(`${name}: D2 ${after.status} ${JSON.stringify(after.body)}`);
      seenCombos.push(`${name}→${after.body?.record ? 'R' : '-'}${after.body?.transcribe ? 'T' : '-'}`);
      await g.context.close();
    }
    return { ok: bad.length === 0, detail: bad.length ? bad.slice(0, 4).join('; ') : `before Admit D2 refuses (403); after: ${seenCombos.join(' ')}` };
  });

  // The held page needs a required part, which only the environment can set (no mock route): see the header.
  {
    await resetMock();
    const invite = await mintInvite(greta, iv);
    const g = await openGuest(invite.linkPath);
    const required = (await guestApi(g.context, 'GET', '/consents')).body?.required ?? [];
    if (!required.length) {
      console.log('NOT RUN I2.5b: the held page: this world requires no consent part (set INTERVIEWS_REQUIRED_CONSENTS in the walk\'s environment, e.g. "transcription")');
    } else {
      await step('I2.5b', async () => {
        const part = required[0];
        const answers = { recording: true, transcription: true, milo: true, [part]: false };
        const at = await toWaiting(g.page, answers);
        const held = at === 'held' ? (await g.page.getByTestId('join-held').innerText()).split('\n').map((l) => l.trim()).filter(Boolean) : [];
        const lead = await waiting(hugo, iv);
        const four = held.length >= 4 && held[0] === 'Your answers are saved.' && /so it cannot start as it is set up now\./.test(held[1])
          && held[2] === 'The recruiter has been told and will be in touch with you.' && held[3] === 'You can change your answers on this page until the interview starts.';
        await g.page.getByTestId('join-held-change-answers').click();
        await answerConsents(g.page, { recording: true, transcription: true, milo: true });
        const through = await Promise.any([seen(g.page, 'join-waiting').then((v) => v || Promise.reject()), seen(g.page, 'join-devices').then((v) => v || Promise.reject())]).catch(() => false);
        if (await g.page.getByTestId('join-devices').count()) await g.page.getByTestId('join-devices-continue').click();
        const waitingNow = await seen(g.page, 'join-waiting');
        const knocked = await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
        return { ok: at === 'held' && four && lead?.state !== 'waiting' && through && waitingNow && knocked,
          detail: `required ${required.join(', ')}; declined → ${at}; lines ${JSON.stringify(held.slice(0, 4))}; nothing knocked while held (${lead?.state ?? 'none'}); changed to yes → waiting ${waitingNow}, the lead reads ${knocked ? 'waiting' : 'NOT waiting'}` };
      });
    }
    await g.context.close();
  }

  console.log('NOT RUN I2.5d: the lead\'s bar reading "Milo is off" in place of Invite Milo: the bar shows only in a call, and the mock world has no platform-api (social profile only)');

  for (const c of [greta, hugo]) await c.close().catch(() => undefined);
  await resetMock();
}
