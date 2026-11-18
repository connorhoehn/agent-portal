// Piece I2.1: the invite link and the guest identity (docs/interviews-tenant-plan.md row I2.1). Every candidate here
// starts from mintInvite(recruiter) → openGuest(linkPath): a browser context that never signed in.
//   I2.1a  the link lands on the interview card; the fragment is gone from the address; screenshots at both widths
//   I2.1b  a reload (no token left) stays on the interview, on the guest cookie alone
//   I2.1c  the guest at a staff page and a staff route is turned away: no candidate's name, the route answers 403
//   I2.1d  the recruiter takes the link back: a reload reads the dead page, and the dead page names no interview
//   I2.1e  expiry: the interviews clock past the link's ceiling, a reload and a fresh opening both read the dead page
//   I2.1f  reuse: the same link opened again, in a new window, still lands on the interview
//   I2.1g  a second opening ends the first session: the first window's reload reads the dead page, the second stays in
//   I2.1h  the page's own lines: a 429 from the exchange says to wait a minute, a network failure says to check the
//          connection; neither is the dead page (O-051, walked here because the page's load is not a module of its own)
//   I2.1i  the lead makes the candidate's link from the room: in Kwame's live round's call bar, "Make candidate link" turns
//          into "Copy candidate link", the status names Hugo, and the link opens on the candidate's page; Wen (on no seat
//          there) and the panel's seat read not-found
//   I2.1j  the way back to a running call: on My interviews the round's row says "Back to the call", and the docked call's
//          "Open the room" lands on the room without a second join
import { joinRoomCall, roomUrl, stubCallMedia } from './h3-call.mjs';

export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, mintInvite, revokeInvite, openGuest, api, clock, shootPage, portal } = ctx;
  const iv = SEED.guestInterview;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const dead = (page) => page.getByTestId('join-dead').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const onInterview = (page) => page.getByTestId('join-interview').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
  const opened = [];
  const open = async (linkPath) => { const g = await openGuest(linkPath); opened.push(g.context); return g; };

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  let guest = null;

  await step('I2.1a', async () => {
    const invite = await mintInvite(greta, iv);
    if (invite.status !== 201) return { ok: false, detail: `the recruiter's mint answered ${invite.status} ${invite.error ?? ''}` };
    guest = await open(invite.linkPath);
    const url = new URL(guest.page.url());
    const text = await guest.page.getByTestId('join-interview').innerText();
    const shots = await shootPage(guest.page, 'guest-landing');
    const ok = guest.landed === 'interview' && url.pathname === '/join' && url.hash === '' && /Senior Backend Engineer/.test(text)
      && /System design/.test(text) && shots.every((s) => s.ok);
    return { ok, detail: `landed on ${guest.landed} at ${url.pathname}${url.hash ? ' WITH the fragment left' : ', no fragment'}; card "${text.replace(/\s+/g, ' ').slice(0, 90)}"; shots ${shots.map((s) => `${s.width}${s.ok ? '' : ' scrolls sideways'}`).join(', ')}` };
  });

  await step('I2.1b', async () => {
    await guest.page.reload({ waitUntil: 'domcontentloaded' });
    const ok = await onInterview(guest.page);
    return { ok, detail: ok ? 'the reload has no token and lands on the interview on the cookie' : `after the reload: ${await guest.page.locator('body').innerText().then((t) => t.slice(0, 120))}` };
  });

  await step('I2.1c', async () => {
    const p = await guest.context.newPage();
    await p.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(5000);
    const text = await p.locator('body').innerText();
    const named = ['Ingrid', 'Mateo', 'Kwame', 'Lucia'].filter((n) => text.includes(n));
    const staff = await api(guest.context, 'GET', '/api/interviews/candidates');
    const one = await api(guest.context, 'GET', `/api/interviews/interviews/${iv}`);
    await p.close();
    const ok = named.length === 0 && staff.status === 403 && one.status === 403;
    return { ok, detail: `the staff page shows no candidate (${named.join(', ') || 'none named'}; it reads "${text.replace(/\s+/g, ' ').slice(0, 70)}"); the candidates route ${staff.status}, the guest's own interview by its staff address ${one.status}` };
  });

  await step('I2.1d', async () => {
    const revoked = await revokeInvite(greta, iv);
    await guest.page.reload({ waitUntil: 'domcontentloaded' });
    const isDead = await dead(guest.page);
    const text = isDead ? await guest.page.locator('body').innerText() : '';
    const leaks = ['Senior Backend Engineer', 'System design', 'Hugo'].filter((w) => text.includes(w));
    const shots = isDead ? await shootPage(guest.page, 'guest-dead') : [];
    return { ok: revoked.status === 200 && isDead && leaks.length === 0, detail: `revoke ${revoked.status}; reload ${isDead ? 'reads the dead page' : 'did NOT read the dead page'}${leaks.length ? `, which names ${leaks.join(', ')}` : ', naming no interview'}${shots.length ? `; shots ${shots.map((s) => s.width).join(', ')}` : ''}` };
  });

  await step('I2.1e', async () => {
    await resetMock();
    const invite = await mintInvite(greta, iv);
    const g = await open(invite.linkPath);
    if (g.landed !== 'interview') return { ok: false, detail: `before the clock moved it landed on ${g.landed}` };
    await clock.set(30 * clock.DAY_MS);
    await g.page.reload({ waitUntil: 'domcontentloaded' });
    const reloadDead = await dead(g.page);
    const fresh = await open(invite.linkPath);
    await clock.reset();
    return { ok: reloadDead && fresh.landed === 'dead', detail: `thirty days on: the open window's reload ${reloadDead ? 'reads the dead page' : 'stays in'}, a fresh opening lands on ${fresh.landed}` };
  });

  await step('I2.1f', async () => {
    await resetMock();
    const invite = await mintInvite(greta, iv);
    const first = await open(invite.linkPath);
    await first.context.close();
    const again = await open(invite.linkPath);
    return { ok: first.landed === 'interview' && again.landed === 'interview', detail: `first opening ${first.landed}, the same link in a new window ${again.landed}` };
  });

  await step('I2.1g', async () => {
    await resetMock();
    const invite = await mintInvite(greta, iv);
    const a = await open(invite.linkPath);
    const b = await open(invite.linkPath);
    await a.page.reload({ waitUntil: 'domcontentloaded' });
    const aDead = await dead(a.page);
    await b.page.reload({ waitUntil: 'domcontentloaded' });
    const bIn = await onInterview(b.page);
    return { ok: a.landed === 'interview' && b.landed === 'interview' && aDead && bIn, detail: `A ${a.landed}, B ${b.landed}; A's reload ${aDead ? 'reads the dead page' : 'STAYS IN'}, B's reload ${bIn ? 'stays in' : 'lost the interview'}` };
  });

  await step('I2.1h', async () => {
    await resetMock();
    const lines = {};
    for (const [kind, handler] of [
      ['busy', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Too many requests' }) })],
      ['offline', (route) => route.abort('internetdisconnected')],
    ]) {
      const invite = await mintInvite(greta, iv);
      const context = await ctx.browser.newContext();
      opened.push(context);
      await context.route('**/api/interview-invite/exchange', handler);
      const page = await context.newPage();
      await page.goto(`${portal}${invite.linkPath}`, { waitUntil: 'domcontentloaded' });
      await page.getByTestId('join-retry').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      lines[kind] = (await page.getByTestId('join-retry').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      lines[`${kind}Dead`] = await page.getByTestId('join-dead').count();
    }
    const ok = /could not open your invitation just now/.test(lines.busy) && /Wait a minute, then open your link again\./.test(lines.busy)
      && /Check your connection, then open your link again\./.test(lines.offline) && lines.busyDead === 0 && lines.offlineDead === 0;
    return { ok, detail: `429: "${lines.busy}"; network failure: "${lines.offline}"` };
  });

  let lead = null;
  await step('I2.1i', async () => {
    await resetMock();
    const live = SEED.interviews.kwameLive;
    const hugo = await signIn(SEED.cast.interviewer);
    opened.push(hugo);
    await hugo.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: portal }).catch(() => undefined);
    await stubCallMedia(hugo, 'hugo-i21i');
    const { page } = await joinRoomCall(ctx, hugo, live);
    lead = page;
    const make = page.getByTestId('interview-candidate-link-make').first();
    const madeShown = await make.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const makeLabel = madeShown ? (await make.innerText()).trim() : '';
    if (madeShown) await make.click();
    const copy = page.getByTestId('interview-candidate-link-copy').first();
    const copyShown = await copy.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const shots = await shootPage(page, 'lead-room-candidate-link');
    const status = await api(hugo, 'GET', `/api/interviews/interviews/${live}/invite`);
    const wen = await signIn(SEED.cast.interviewer2);
    opened.push(wen);
    const wenMake = await api(wen, 'POST', `/api/interviews/interviews/${live}/invite`, {});
    const panelMake = await api(hugo, 'POST', `/api/interviews/interviews/${SEED.panelInterview}/invite`, {});
    // Kwame's round is seeded with a live link the recruiter made, so the lead's button offers a new one (it stops the old).
    const ok = ['Make candidate link', 'Make a new candidate link'].includes(makeLabel) && copyShown && status.status === 200 && status.body?.invite?.state === 'live'
      && status.body?.invite?.issuedBy?.id === SEED.cast.interviewer && wenMake.status === 404 && panelMake.status === 404 && shots.every((x) => x.ok);
    return { ok, detail: `call bar "${makeLabel || 'no Make candidate link'}" → copy ${copyShown ? 'shown' : 'MISSING'}; status ${status.status} ${status.body?.invite?.state} by ${status.body?.invite?.issuedBy?.name}; Wen (no seat) ${wenMake.status}, Hugo on the panel's seat ${panelMake.status}; shots ${shots.map((x) => `${x.width}${x.ok ? '' : ' scrolls sideways'}`).join(', ')}` };
  });

  await step('I2.1j', async () => {
    if (!lead) return { ok: false, detail: 'no lead in a call (I2.1i failed)' };
    const live = SEED.interviews.kwameLive;
    let joins = 0;
    lead.on('request', (rq) => { if (rq.method() === 'POST' && /\/join$/.test(new URL(rq.url()).pathname)) joins += 1; });
    // In-app navigation, not a reload: a reload ends the page's call (the dock lives only within the app), and the room folds the rail.
    await lead.evaluate(() => { window.history.pushState({}, '', '/interviews/my-interviews'); window.dispatchEvent(new PopStateEvent('popstate')); });
    await lead.waitForURL((u) => u.pathname === '/interviews/my-interviews', { timeout: 15_000 }).catch(() => undefined);
    const back = lead.getByTestId('interview-open-room').first();
    const dockShown = await back.waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const rowLabels = (await lead.getByTestId('interviews-desk-join').allInnerTexts().catch(() => [])).map((t) => t.trim());
    if (dockShown) await back.click();
    await lead.waitForURL((u) => u.pathname === new URL(roomUrl(portal, live)).pathname, { timeout: 30_000 }).catch(() => undefined);
    const atRoom = new URL(lead.url()).pathname === new URL(roomUrl(portal, live)).pathname;
    const dockStill = await lead.getByTestId('shell-call-dock').first().isVisible().catch(() => false);
    const ok = dockShown && atRoom && dockStill && joins === 0 && !rowLabels.includes('Join');
    return { ok, detail: `docked call's Open the room ${dockShown ? 'shown' : 'MISSING'}; desk row buttons [${rowLabels.join(', ') || 'none on this tab'}]; back at the room ${atRoom}; still in the call ${dockStill}; second joins ${joins}` };
  });
  if (lead) await lead.getByTestId('shell-call-dock-leave').or(lead.getByRole('button', { name: 'Leave', exact: true })).first().click({ timeout: 5_000 }).catch(() => undefined);

  for (const c of opened) await c.close().catch(() => undefined);
  await greta.close();
  await resetMock();
}
