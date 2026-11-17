// Piece I2.6 (this repository's half): who may list or play an interview's recording, D3, per role, asked as
// platform-api asks it: POST /api/realtime/recording-access with the caller's OWN realtime token as a bearer. The
// judge's .404 tables carry cookies only, so this per-role table is a walk step (scripts/validate-interviews.d/I2.6.404
// holds the cookie half: no bearer, no answer).
//   I2.6a  Mateo's design round (Hugo leads, the Backend opening): the lead, the recruiter and the opening's hiring
//          manager are allowed, before the call and after it ends; an interviewer with no seat, a Work-only person, the
//          candidate (let in) and a guest of another interview are refused, before and after; no token is a 401
export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, mintInvite, guestSession, guestConsents, guestApi, admit, api, startInterview, endInterview, portal } = ctx;
  const iv = SEED.guestInterview;
  const lobbyName = `interviews:interview:${iv}`;
  const d3 = async (token) => {
    const r = await fetch(`${portal}/api/realtime/recording-access`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ lobbyName }) });
    return r.status;
  };
  await resetMock();
  const people = {};
  for (const who of ['recruiter', 'interviewer', 'interviewer2', 'hiringManager', 'workOnly']) people[who] = await signIn(SEED.cast[who]);
  try {
    const tokens = {};
    for (const [who, context] of Object.entries(people)) tokens[who] = (await api(context, 'GET', '/api/session/realtime-token')).body?.token ?? null;
    const own = await mintInvite(people.recruiter, iv);
    const guest = await guestSession(own.token);
    await guestConsents(guest.context);
    await guestApi(guest.context, 'POST', '/knock');
    await admit(people.interviewer, iv, true);
    tokens.guest = (await guestApi(guest.context, 'GET', '/realtime-token')).body?.token ?? null;
    const other = await mintInvite(people.recruiter, SEED.interviews.aikoCoding);
    const otherGuest = await guestSession(other.token);
    tokens['guest:aikoCoding'] = (await guestApi(otherGuest.context, 'GET', '/realtime-token')).body?.token ?? null;
    const want = { recruiter: 200, interviewer: 200, hiringManager: 200, interviewer2: 403, workOnly: 403, guest: 403, 'guest:aikoCoding': 403 };
    const ask = async () => { const got = {}; for (const who of Object.keys(want)) got[who] = tokens[who] ? await d3(tokens[who]) : 'no token'; return got; };
    const before = await ask();
    await startInterview(people.interviewer, iv);
    await endInterview(people.interviewer, iv);
    const after = await ask();
    const none = await d3(null);
    const ok = Object.entries(want).every(([who, s]) => before[who] === s && after[who] === s) && none === 401;
    record('I2.6a', ok, `before ${JSON.stringify(before)}; after the end ${JSON.stringify(after)}; no token ${none}`);
    await guest.context.close(); await otherGuest.context.close();
  } catch (e) {
    record('I2.6a', false, `D3 per role: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  for (const c of Object.values(people)) await c.close().catch(() => undefined);
  await resetMock();
}
