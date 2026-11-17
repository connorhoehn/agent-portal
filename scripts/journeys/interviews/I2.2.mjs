// Piece I2.2: the lobby family, admission, a guest seat (docs/interviews-tenant-plan.md row I2.2). The seat is asked as
// platform-api asks it: POST /api/realtime/lobby-access with the caller's OWN realtime token as a bearer (the staff
// bridge's token for a person, the guest's token for the candidate). The candidate starts from mintInvite(recruiter)
// → openGuest(linkPath), a context with no account.
//   I2.2a  the candidate knocks: the lead reads "waiting"; the candidate's token opens no seat; the room read is not-found
//   I2.2b  not yet: still no seat
//   I2.2c  admitted: the candidate holds the seat, and the room read names the interview's lobby; the lead holds it too;
//          the recruiter, the hiring manager, an interviewer with no seat and a guest let into ANOTHER interview do not
//   I2.2d  ended: nobody holds the seat (the interview is no longer in a call state), the room read says ended
// Written, not run (the mock world has no platform-api, so no call starts): both in the call, and the huddle chat in
// a live call: lead and admitted guest send and read, a waiting or turned-away guest is refused.
export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, mintInvite, openGuest, toWaiting, waiting, admit, startInterview, endInterview,
    api, guestApi, guestSession, guestConsents, portal } = ctx;
  const iv = SEED.guestInterview;
  const lobbyName = `interviews:interview:${iv}`;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };
  const tokenOf = async (context, guest) => (await (guest ? guestApi(context, 'GET', '/realtime-token') : api(context, 'GET', '/api/session/realtime-token'))).body?.token ?? null;
  const seat = async (token) => {
    if (!token) return 'no token';
    const r = await fetch(`${portal}/api/realtime/lobby-access`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ lobbyName }) });
    return r.status;
  };

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const amara = await signIn(SEED.cast.hiringManager);
  const invite = await mintInvite(greta, iv);
  const guest = await openGuest(invite.linkPath);
  let guestToken = null;

  await step('I2.2a', async () => {
    const at = await toWaiting(guest.page);
    const lead = await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    guestToken = await tokenOf(guest.context, true);
    const s = await seat(guestToken);
    const room = await guestApi(guest.context, 'GET', '/room');
    return { ok: at === 'waiting' && lead && s === 403 && room.status === 404, detail: `the candidate ${at}, the lead reads ${lead ? 'waiting' : 'NOT waiting'}; the candidate's seat ${s}; the room read ${room.status}` };
  });

  await step('I2.2b', async () => {
    const no = await admit(hugo, iv, false);
    const s = await seat(guestToken);
    const room = await guestApi(guest.context, 'GET', '/room');
    return { ok: no.status === 200 && s === 403 && room.status === 404, detail: `not yet ${no.status}; the candidate's seat ${s}; the room read ${room.status}` };
  });

  await step('I2.2c', async () => {
    await guest.page.getByTestId('join-knock-again').click();
    await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    const yes = await admit(hugo, iv, true);
    const s = await seat(guestToken);
    const room = await guestApi(guest.context, 'GET', '/room');
    // A guest let into another interview holds no seat in this one.
    const other = await mintInvite(greta, SEED.interviews.aikoCoding);
    const otherGuest = await guestSession(other.token);
    await guestConsents(otherGuest.context);
    await guestApi(otherGuest.context, 'POST', '/knock');
    await admit(wen, SEED.interviews.aikoCoding, true);
    const staff = {};
    for (const [who, context] of [['lead', hugo], ['recruiter', greta], ['hiringManager', amara], ['interviewer2 (no seat)', wen]]) staff[who] = await seat(await tokenOf(context, false));
    staff['guest of another interview'] = await seat(await tokenOf(otherGuest.context, true));
    await otherGuest.context.close();
    const ok = yes.status === 200 && s === 200 && room.status === 200 && room.body?.room?.lobbyName === lobbyName && staff.lead === 200
      && staff.recruiter === 403 && staff.hiringManager === 403 && staff['interviewer2 (no seat)'] === 403 && staff['guest of another interview'] === 403;
    return { ok, detail: `admitted ${yes.status}; the candidate's seat ${s}; the room read ${room.status} on ${room.body?.room?.lobbyName === lobbyName ? 'the interview\'s lobby' : room.body?.room?.lobbyName}; others ${JSON.stringify(staff)}` };
  });

  await step('I2.2d', async () => {
    const started = await startInterview(hugo, iv);
    const ended = await endInterview(hugo, iv);
    const s = await seat(guestToken);
    const lead = await seat(await tokenOf(hugo, false));
    const room = await guestApi(guest.context, 'GET', '/room');
    return { ok: started.status === 200 && ended.status === 200 && s === 403 && lead === 403 && room.status === 200 && room.body?.room?.state === 'ended',
      detail: `start ${started.status}, end ${ended.status}; seats after the end: candidate ${s}, lead ${lead}; the candidate's room read ${room.status} "${room.body?.room?.state}"` };
  });

  console.log('NOT RUN I2.2e: both in the call and the huddle chat in a live call (lead and admitted guest send and read; a waiting or turned-away guest refused): the mock world has no platform-api, so no call starts (social profile only)');

  await guest.context.close();
  for (const c of [greta, hugo, wen, amara]) await c.close().catch(() => undefined);
  await resetMock();
}
