// The harness's own check (not a ledger row; run with `npm run journey:interviews -- --harness-check`): one pass
// over every helper in lib.mjs on the seeded world, so a lane that gets a FAIL in its piece can tell its piece
// from the harness. Steps are named H0.<letter>.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, api, guestApi, mintInvite, revokeInvite, openGuest, guestSession, guestConsents, toWaiting,
    waiting, admit, startInterview, endInterview, setTime, readInterview, clock, bells, refusals, shootPage, portal } = ctx;
  const step = async (name, what, fn) => {
    try { const detail = await fn(); record(name, true, `${what}: ${detail}`); } catch (e) { record(name, false, `${what}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
  };
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const iv = SEED.guestInterview;
  let invite = null;
  let guest = null;

  await step('H0.a', 'every seeded id is in the world the server serves', async () => {
    const [interviews, candidates, openings] = await Promise.all([
      api(greta, 'GET', '/api/interviews/interviews'), api(greta, 'GET', '/api/interviews/candidates'), api(greta, 'GET', '/api/interviews/openings'),
    ]);
    const text = JSON.stringify([interviews.body, candidates.body, openings.body]);
    const ids = [...Object.values(SEED.interviews), ...Object.values(SEED.candidates), ...Object.values(SEED.openings)];
    const missing = ids.filter((id) => !text.includes(`"${id}"`));
    check(interviews.status === 200 && missing.length === 0, `missing ${missing.join(', ') || `(status ${interviews.status})`}`);
    return `${ids.length} ids`;
  });

  await step('H0.b', 'the recruiter mints a link and a person with no account lands on it', async () => {
    invite = await mintInvite(greta, iv);
    check(invite.status === 201 && /^\/join#.+/.test(invite.linkPath ?? ''), `mint answered ${invite.status} ${invite.error ?? ''}`);
    guest = await openGuest(invite.linkPath);
    check(guest.landed === 'interview', `landed on ${guest.landed}`);
    const address = new URL(guest.page.url());
    const staff = await api(guest.context, 'GET', '/api/interviews/candidates');
    check(staff.status === 403, `the guest at a staff route got ${staff.status}`);
    return `landed on the interview card; the address is ${address.pathname}${address.hash ? ' with a fragment left' : ''}; a staff route answers 403`;
  });

  await step('H0.c', 'the three consents, the device check and the knock', async () => {
    let at = null;
    try { at = await toWaiting(guest.page); } catch (e) {
      const html = await guest.page.getByTestId('join-consent-recording').evaluate((el) => el.outerHTML).catch(() => '(no consent block)');
      throw new Error(`${e.message.split('\n')[0]} :: ${html.replace(/\s+/g, ' ').slice(0, 1500)}`);
    }
    check(at === 'waiting', `ended on ${at}`);
    const shots = await shootPage(guest.page, 'harness-waiting');
    let seen = null;
    for (let i = 0; i < 20 && seen?.state !== 'waiting'; i += 1) { seen = await waiting(hugo, iv); if (seen?.state !== 'waiting') await guest.page.waitForTimeout(500); }
    check(seen?.state === 'waiting', `the lead reads ${seen?.state}`);
    return `the candidate waits, the lead reads "waiting"; screenshots ${shots.map((s) => `${s.width}${s.ok ? '' : ' scrolls sideways'}`).join(', ')}`;
  });

  await step('H0.d', 'the lead answers not yet, then admits', async () => {
    const no = await admit(hugo, iv, false);
    check(no.status === 200 && no.body?.admission?.state === 'turned-away', `not yet answered ${no.status} ${no.body?.admission?.state}`);
    await guest.page.getByTestId('join-turned-away').waitFor({ timeout: 30_000 });
    await guest.page.getByTestId('join-knock-again').click();
    let seen = null;
    for (let i = 0; i < 20 && seen?.state !== 'waiting'; i += 1) { seen = await waiting(hugo, iv); if (seen?.state !== 'waiting') await guest.page.waitForTimeout(500); }
    const yes = await admit(hugo, iv, true);
    check(yes.status === 200 && yes.body?.admission?.state === 'admitted', `admit answered ${yes.status} ${yes.body?.admission?.state}`);
    const mine = await guestApi(guest.context, 'GET', '/admission');
    check(mine.body?.admission?.state === 'admitted', `the candidate reads ${mine.body?.admission?.state}`);
    return 'turned away, knocked again, admitted; both sides agree';
  });

  await step('H0.e', 'the lead starts and ends the interview; a panel member reads their own', async () => {
    const started = await startInterview(hugo, iv);
    check(started.status === 200, `start answered ${started.status} ${started.body?.error ?? ''}`);
    const ended = await endInterview(hugo, iv);
    check(ended.status === 200, `end answered ${ended.status} ${ended.body?.error ?? ''}`);
    const after = await readInterview(hugo, iv);
    check(after?.state === 'ended', `the interview is ${after?.state}`);
    const panel = await readInterview(hugo, SEED.panelInterview);
    const notMine = await api(hugo, 'GET', `/api/interviews/interviews/${SEED.interviews.aikoCoding}`);
    check(panel && notMine.status === 404, `panel read ${panel ? 'ok' : 'missing'}, another's interview ${notMine.status}`);
    return 'ready → live → ended; Hugo reads the round he sits on as panel and gets 404 for another interviewer\'s';
  });

  await step('H0.f', 'an API-only candidate: exchange and the three answers', async () => {
    await resetMock();
    const again = await mintInvite(greta, iv);
    const session = await guestSession(again.token);
    check(session.status === 200, `exchange answered ${session.status}`);
    const saved = await guestConsents(session.context, { recording: true, transcription: false, milo: false });
    check(saved.status === 200, `consents answered ${saved.status}`);
    const revoked = await revokeInvite(greta, iv);
    const dead = await guestApi(session.context, 'GET', '/interview');
    check(revoked.status === 200 && [401, 404].includes(dead.status), `after revoke the guest got ${dead.status}`);
    await session.context.close();
    return `answers saved; after the recruiter revokes, the guest's read answers ${dead.status}`;
  });

  await step('H0.g', 'the clock: a link dies when the time passes its ceiling, and reset brings it back', async () => {
    await resetMock();
    const fresh = await mintInvite(greta, iv);
    const before = await guestSession(fresh.token);
    check(before.status === 200, `exchange before answered ${before.status}`);
    const t0 = await clock.now();
    await clock.set(30 * clock.DAY_MS);
    const t1 = await clock.now();
    check(Math.abs((t1 - t0) - 30 * clock.DAY_MS) < 60_000, `the clock moved ${Math.round((t1 - t0) / clock.DAY_MS)} days`);
    const late = await guestSession(fresh.token);
    check(late.status === 404, `exchange 30 days on answered ${late.status}`);
    await resetMock();
    const back = await clock.now();
    check(Math.abs(back - Date.now()) < 60_000, 'reset did not put the clock back');
    await before.context.close(); await late.context.close();
    return 'the exchange answers 200 now and 404 thirty days on; reset puts the clock back';
  });

  await step('H0.h', 'starting soon: a time 13 to 14 minutes out, one sweep, one bell for the lead', async () => {
    await resetMock();
    const page = await hugo.newPage();
    await page.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('activity-bell').first().waitFor({ timeout: 30_000 });
    const moved = await setTime(greta, iv, await clock.minutesFromNow(13));
    check(moved.status === 200, `the time write answered ${moved.status} ${moved.body?.error ?? ''}`);
    const swept = await clock.sweep('soon');
    const got = await bells(page, /start/i);
    await page.close();
    check(got.lines.length > 0, `no bell (the sweep said ${JSON.stringify(swept.sweep)})`);
    return `the sweep rang ${JSON.stringify(swept.sweep)}; the bell reads "${got.lines[0].slice(0, 80)}"`;
  });

  await step('H0.i', 'a 404 table runs: refused and allowed principals, a guest included', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iv-table-')), 'check.404');
    fs.writeFileSync(file, [
      '# the harness check\'s own table',
      'GET /api/interviews/interviews/{interviews.aikoCoding} | interviewer hiringManager guest=403 anon=403 workOnly=403 | recruiter interviewer2',
      'GET /api/interviews/openings/{openings.ios}/spend | interviewer interviewer2 hiringManager | recruiter',
    ].join('\n'));
    const r = await refusals(file);
    check(r.ok, r.failures.join('; '));
    return `${r.checked} answers as the table says`;
  });

  for (const c of [greta, hugo, wen, guest?.context]) await c?.close().catch(() => undefined);
  await resetMock();
}
