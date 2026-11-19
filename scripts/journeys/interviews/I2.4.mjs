// Piece I2.4: the interview room for both sides (docs/interviews-tenant-plan.md row I2.4, decision 21). The lead and the
// candidate in two contexts; the candidate starts from mintInvite(recruiter) → openGuest(linkPath).
//
// The mock world has no platform-api, so neither side can start a call: the bar's "Join the call" is disabled with the
// reason "Calls need platform-api". What the mock shows is walked; every step that needs a call (tiles, "N joined",
// the chat, Leave and rejoin, End through the deck, the chrome while live) is written below behind `callable` and
// prints "NOT RUN <step>: …" when the call cannot start. Those steps run only on the social profile.
//   I2.4a  the lead's room before the call: one title, then who, when, how long and the panel; the pane's tabs by round
//          type (Pad, Questions, Milo, Chat; Plan, Milo, Chat), the questions in their tab; the trail is there before the call; one right pane and no shell chat pane; shots at both widths
//   I2.4b  the knock in the lead's footer: "<Name> is waiting" with Admit and Not yet, the footer row one line at
//          1280; Not yet from the deck → the candidate's turned-away line; knock again; Admit from the deck → the
//          candidate's room
//   I2.4c  the candidate let in: "Your interviewer has let you in", the bar's Join the call (enabled, or disabled for
//          the platform-api reason and nothing else), no panel-side words; shots at both widths
//   I2.4d  the recruiter, the hiring manager and an interviewer with no seat read "Interview not found" at the room
//   I2.4e  the lead ends: the candidate's page moves to the ended page with the deletion line; a reload keeps it; the
//          lead's room reads "This interview has ended"
//   I2.4f  turned away after being let in: the candidate's page moves to the ended page
//   I2.4g  two tabs of one link in one window: the second opening is the window's session, and both tabs stay in
//   I2.4h  guest realtime off (INTERVIEWS_GUEST_REALTIME=false in the environment): the room's cannot-open line
//   I2.4o  the technical pane's column is 560 to 760 px wide at 1440 and at 1280
//   I2.4i…  (a call only) both in the call, "2 joined" on both bars, tiles carry names, the chat both ways, Leave →
//          "You left the call" → Join, the chrome folded while live and back after End, End through the deck with
//          Keep going and Esc, Join while the gateway is still connecting
// The room's header (the full-width room): the h1 is the round's essentials; what the call is doing is the header's
// description card (About …); the round's facts are under the Details tab.
async function roomHeader(page) {
  const h = page.getByTestId('interview-room-idle').first();
  const title = (await h.locator('[data-page-header-title]').first().innerText()).trim();
  await h.getByRole('button', { name: /^About / }).first().click();
  const state = (await page.getByTestId('interview-room-idle-description-text').first().innerText().catch(() => '')).trim();
  await page.keyboard.press('Escape');
  return { title, state };
}
async function roomFacts(page) {
  await page.getByTestId('interview-room-pane').getByRole('tab', { name: /^Details/ }).click();
  return (await page.getByTestId('interview-room-details').getByTestId('key-value').innerText()).replace(/\s+/g, ' ');
}
const roomTab = (page, name) => page.getByTestId('interview-room-pane').getByRole('tab', { name: new RegExp(`^${name}`) });

export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, mintInvite, openGuest, toWaiting, waiting, admit, startInterview, endInterview,
    api, guestApi, shootPage, portal } = ctx;
  const iv = SEED.guestInterview;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const notRun = (name, why) => console.log(`NOT RUN ${name}: ${why}`);
  const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };
  const roomUrl = (id) => `${portal}/interviews/rounds/${id}/room`;
  const opened = [];
  const open = async (linkPath) => { const g = await openGuest(linkPath); opened.push(g.context); return g; };
  const NO_PLATFORM = /Calls need platform-api/;

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  const amara = await signIn(SEED.cast.hiringManager);
  const prompts = ((await api(hugo, 'GET', `/api/interviews/interviews/${iv}/room`)).body?.room?.questions ?? []).map((q) => q.prompt);
  const panelSide = (text) => {
    const hits = prompts.filter((p) => text.includes(p.slice(0, 40))).map(() => 'a question');
    if (/scorecard/i.test(text)) hits.push('"scorecard"');
    if (/suggest/i.test(text)) hits.push('"suggest"');
    if (/transcript/i.test(text)) hits.push('"transcript"');
    return hits;
  };
  const lead = await hugo.newPage();
  let callable = false;
  let guest = null;
  let widthSeen = null;

  await step('I2.4a', async () => {
    await lead.goto(roomUrl(iv), { waitUntil: 'domcontentloaded' });
    await seen(lead, 'interview-room-idle');
    const { title, state } = await roomHeader(lead);
    const facts = await roomFacts(lead);
    const tabs = (await lead.getByTestId('interview-room-pane').getByRole('tab').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
    // The room is full width: its workspace takes the page beside the rail (no right column before the call).
    const width = Math.round((await lead.getByTestId('interview-room-pane').boundingBox())?.width ?? 0);
    const card = Math.round(lead.viewportSize()?.width ?? 0);
    const trail = await lead.getByText('My interviews', { exact: true }).count();
    const panes = await lead.getByTestId('page-conversation-pane').count();
    const shellChat = await lead.locator('[data-testid^="shell-huddle"], [data-testid="huddle-chat-pane"]').count();
    await roomTab(lead, 'Questions').click();
    const qText = await lead.getByTestId('interview-room-tab-questions').innerText().catch(() => '');
    const hasQuestion = prompts.length > 0 && prompts.some((p) => qText.includes(p.slice(0, 40)));
    await roomTab(lead, 'Pad').click();
    const start = lead.getByTestId('shell-footer-context-start');
    callable = (await start.count()) > 0 && !(await start.isDisabled());
    const reason = callable ? '' : (await start.getAttribute('title')) ?? '';
    const shots = await shootPage(lead, 'room-lead-before');
    // A behavioural round: Wen leads Nadia's leadership round.
    const wp = await wen.newPage();
    await wp.goto(roomUrl(SEED.panelInterview), { waitUntil: 'domcontentloaded' });
    await seen(wp, 'interview-room-pane');
    const bTabs = (await wp.getByTestId('interview-room-pane').getByRole('tab').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
    await wp.close();
    const ok = /^Mateo/.test(title) && state.startsWith('The call has not started') && /Candidate\s*Mateo/.test(facts) && /Panel\s*Hugo Marchetti \(lead\)/.test(facts)
      && JSON.stringify(tabs) === '["Pad","Questions","Milo","Chat","Details"]' && JSON.stringify(bTabs) === '["Plan","Milo","Chat","Details"]'
      && hasQuestion && trail > 0 && panes === 0 && shellChat === 0 && shots.every((s) => s.ok)
      && (callable || NO_PLATFORM.test(reason));
    widthSeen = { width, card };
    return { ok, detail: `"${title}" (${state.slice(0, 40)}); tabs ${tabs.join('/')} (technical, room ${width} px of ${card}), ${bTabs.join('/')} (behavioural); questions in their tab ${hasQuestion}; trail ${trail > 0}; right panes ${panes}, shell chat ${shellChat}; Join the call ${callable ? 'enabled' : `disabled: "${reason.slice(0, 60)}"`}` };
  });

  // The room's width (the owner's full-width room, which replaced decision 21's 560 to 760 px pane): the workspace takes
  // the page beside the rail, at 1440 (from I2.4a) and again at 1280.
  await step('I2.4o', async () => {
    await lead.setViewportSize({ width: 1280, height: 900 });
    await lead.waitForTimeout(300);
    const at1280 = Math.round((await lead.getByTestId('interview-room-pane').boundingBox())?.width ?? 0);
    await lead.setViewportSize({ width: 1440, height: 900 });
    const wide = (w, of) => w >= of * 0.85;
    return { ok: !!widthSeen && wide(widthSeen.width, 1440) && wide(at1280, 1280),
      detail: `the room's workspace: ${widthSeen ? `${widthSeen.width} px at 1440` : 'not measured at 1440'}, ${at1280} px at 1280; want at least 85% of the window` };
  });

  await step('I2.4b', async () => {
    const invite = await mintInvite(greta, iv);
    guest = await open(invite.linkPath);
    await toWaiting(guest.page);
    const ask = lead.getByTestId('interview-room-ask');
    const arrived = await seen(lead, 'interview-room-ask-option-admit', 30_000);
    const askText = arrived ? (await ask.innerText()).replace(/\s+/g, ' ') : '';
    await lead.setViewportSize({ width: 1280, height: 900 });
    await lead.waitForTimeout(300);
    const row = await lead.getByTestId('shell-footer-row').boundingBox();
    const footerOneLine = !!row && row.height <= 56;
    await lead.setViewportSize({ width: 1440, height: 900 });
    await lead.getByTestId('interview-room-ask-option-not-yet').click();
    const away = await seen(guest.page, 'join-turned-away');
    await guest.page.getByTestId('join-knock-again').click();
    const again = await seen(lead, 'interview-room-ask-option-admit', 30_000);
    await lead.getByTestId('interview-room-ask-option-admit').click();
    const inRoom = await seen(guest.page, 'join-room-idle');
    const state = (await guestApi(guest.context, 'GET', '/admission')).body?.admission?.state;
    return { ok: arrived && / is waiting/.test(askText) && footerOneLine && away && again && inRoom && state === 'admitted',
      detail: `the deck "${askText.slice(0, 80)}"; the footer row ${row ? Math.round(row.height) : '?'} px at 1280; Not yet → the candidate ${away ? 'reads the turned-away line' : 'did NOT read it'}; Admit → ${inRoom ? 'the candidate is in the room' : 'NOT in the room'} (${state})` };
  });

  await step('I2.4c', async () => {
    const text = await guest.page.locator('body').innerText();
    // A technical round's full-width room: the header line, with what to do next in its description card (About …).
    const idleHeader = guest.page.getByTestId('join-room-idle').first();
    await idleHeader.getByRole('button', { name: /^About / }).first().click().catch(() => undefined);
    const idle = `${await idleHeader.innerText()} ${await guest.page.getByTestId('join-room-idle-description-text').first().innerText().catch(() => '')}`.replace(/\s+/g, ' ');
    await guest.page.keyboard.press('Escape');
    const join = guest.page.getByTestId('join-room-bar-start');
    const disabled = (await join.count()) ? await join.isDisabled() : null;
    const why = disabled ? ((await join.getAttribute('title')) ?? '') : '';
    const shots = await shootPage(guest.page, 'room-guest-before');
    const leaks = panelSide(text);
    const ok = /Your interviewer has let you in/.test(idle) && disabled !== null && (!disabled || NO_PLATFORM.test(why) || !callable) && leaks.length === 0 && shots.every((s) => s.ok);
    return { ok, detail: `"${idle.slice(0, 70)}"; the bar's Join the call ${disabled === null ? 'MISSING' : disabled ? `disabled ("${why.slice(0, 50)}")` : 'enabled'}; panel-side ${leaks.join(', ') || 'none'}; shots ${shots.map((s) => s.width).join(', ')}` };
  });

  if (callable) {
    await step('I2.4i', async () => {
      // Both join: the lead from the footer (its device check, then Join), the candidate from the bar.
      const joinFrom = async (page, start) => {
        await start.click();
        for (const name of [/^Join$/, /^Join the call$/, /^Join now$/, /^Continue$/]) {
          const b = page.getByRole('dialog').getByRole('button', { name });
          if (await b.count()) { await b.first().click(); break; }
        }
      };
      await joinFrom(lead, lead.getByTestId('shell-footer-context-start'));
      await joinFrom(guest.page, guest.page.getByTestId('join-room-bar-start'));
      const two = async (page) => until(async () => /2 joined/.test(await page.locator('footer').innerText()), 30_000);
      const both = (await two(lead)) && (await two(guest.page));
      const live = await lead.getByTestId('interview-room').getAttribute('data-room-live');
      const trail = await lead.getByText('My interviews', { exact: true }).count();
      const tiles = await guest.page.getByTestId('join-room-stage').innerText();
      const idsOnTiles = /u-hugo|iv-|cand-|guest-/.test(tiles);
      const leadShots = await shootPage(lead, 'room-lead-live');
      const guestShots = await shootPage(guest.page, 'room-guest-live');
      return { ok: both && live === 'true' && trail === 0 && /Hugo Marchetti/.test(tiles) && !idsOnTiles && [...leadShots, ...guestShots].every((s) => s.ok),
        detail: `2 joined on both bars ${both}; the room live ${live}, trail gone ${trail === 0}; the candidate's tiles "${tiles.replace(/\s+/g, ' ').slice(0, 60)}"` };
    });
    await step('I2.4j', async () => {
      await roomTab(lead, 'Chat').click();
      await lead.getByTestId('interview-room-chat').getByRole('textbox').fill('Welcome, can you hear me?');
      await lead.keyboard.press('Enter');
      const got = await until(async () => /Welcome, can you hear me\?/.test(await guest.page.getByTestId('join-room-chat').innerText().catch(() => '')), 20_000);
      await guest.page.getByTestId('join-room-chat').getByRole('textbox').fill('Yes, I can.');
      await guest.page.keyboard.press('Enter');
      const back = await until(async () => /Yes, I can\./.test(await lead.getByTestId('interview-room-chat').innerText()), 20_000);
      return { ok: got && back, detail: `lead → candidate ${got}; candidate → lead ${back}` };
    });
    await step('I2.4k', async () => {
      await guest.page.getByRole('button', { name: /^Leave$/ }).click();
      const left = await seen(guest.page, 'join-room-left');
      await guest.page.getByRole('button', { name: /^Join the call$/ }).click();
      const back = await until(async () => /2 joined/.test(await guest.page.locator('footer').innerText()), 30_000);
      return { ok: left && back, detail: `Leave → "You left the call" ${left}; Join → 2 joined ${back}` };
    });
    await step('I2.4l', async () => {
      await lead.getByTestId('interview-end').click();
      const confirm = await seen(lead, 'interview-room-ask');
      await lead.keyboard.press('Escape');
      const stillLive = (await readState(api, hugo, iv)) === 'live';
      await lead.getByTestId('interview-end').click();
      await lead.getByRole('button', { name: /^Keep going$/ }).click();
      const stillLive2 = (await readState(api, hugo, iv)) === 'live';
      await lead.getByTestId('interview-end').click();
      await lead.getByTestId('interview-room').getByRole('button', { name: /^End interview$/ }).last().click().catch(() => lead.getByRole('button', { name: /^End interview$/ }).last().click());
      const ended = await until(async () => (await readState(api, hugo, iv)) === 'ended', 20_000);
      const onDesk = await until(async () => /\/scorecard/.test(lead.url()), 20_000);
      const noJoin = !/Join the call/.test(await lead.locator('footer').innerText());
      const guestEnded = await seen(guest.page, 'join-ended');
      return { ok: confirm && stillLive && stillLive2 && ended && onDesk && noJoin && guestEnded,
        detail: `the confirm ${confirm}; Esc keeps it live ${stillLive}; Keep going keeps it live ${stillLive2}; End → ended ${ended}, the scorecard ${onDesk}, no "Join the call" left in the footer ${noJoin}; the candidate's ended page ${guestEnded}` };
    });
  } else {
    for (const s of ['I2.4i both in the call, 2 joined, tiles named, the chrome folded', 'I2.4j the chat both ways', 'I2.4k Leave → "You left the call" → Join',
      'I2.4l End through the deck, Esc and Keep going, the chrome back after End', 'I2.4m Join while the gateway is still connecting', 'I2.4n a reload mid-call']) {
      notRun(s.split(' ')[0], `${s.slice(s.indexOf(' ') + 1)}: the mock world has no platform-api, so no call starts (social profile only)`);
    }
  }

  await step('I2.4d', async () => {
    const lines = [];
    for (const [who, context] of [['recruiter', greta], ['hiring manager', amara], ['Wen (no seat)', wen]]) {
      const p = await context.newPage();
      await p.goto(roomUrl(iv), { waitUntil: 'domcontentloaded' });
      const nf = await p.getByText('Interview not found').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
      const room = await p.getByTestId('interview-room').count();
      lines.push({ who, ok: nf && room === 0 });
      await p.close();
    }
    return { ok: lines.every((l) => l.ok), detail: lines.map((l) => `${l.who} ${l.ok ? 'reads "Interview not found"' : 'DID NOT read not-found'}`).join('; ') };
  });

  await step('I2.4e', async () => {
    if (!callable) {
      const started = await startInterview(hugo, iv);
      const ended = await endInterview(hugo, iv);
      if (started.status !== 200 || ended.status !== 200) return { ok: false, detail: `start ${started.status}, end ${ended.status}` };
    }
    const endedPage = await seen(guest.page, 'join-ended', 30_000);
    const deletion = endedPage ? (await guest.page.getByTestId('join-ended-deletion').innerText()).trim() : '';
    const shots = endedPage ? await shootPage(guest.page, 'guest-ended') : [];
    await guest.page.reload({ waitUntil: 'domcontentloaded' });
    const kept = await seen(guest.page, 'join-ended');
    const deadAfter = await guest.page.getByTestId('join-dead').count();
    const text = await guest.page.locator('body').innerText();
    await lead.reload({ waitUntil: 'domcontentloaded' });
    const closed = await seen(lead, 'interview-room-closed');
    const closedText = closed ? (await roomHeader(lead)).state.replace(/\s+/g, ' ') : '';
    const ok = endedPage && /To have your recording and transcript deleted, ask the person who sent you your interview link\. They are removed within 30 days\./.test(deletion)
      && kept && deadAfter === 0 && !/score|result|decision|next stage/i.test(text) && /This interview has ended/.test(closedText);
    return { ok, detail: `ended page ${endedPage}, the deletion line "${deletion.slice(0, 60)}…"; a reload ${kept ? 'keeps the ended page' : deadAfter ? 'reads the DEAD page' : 'lost it'}; the lead reads "${closedText.slice(0, 40)}"; shots ${shots.map((s) => s.width).join(', ')}` };
  });

  await step('I2.4f', async () => {
    await resetMock();
    const invite = await mintInvite(greta, iv);
    const g = await open(invite.linkPath);
    await toWaiting(g.page);
    await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    await admit(hugo, iv, true);
    const inRoom = await seen(g.page, 'join-room');
    const away = await admit(hugo, iv, false);
    const ended = await seen(g.page, 'join-ended', 30_000);
    const room = await guestApi(g.context, 'GET', '/room');
    return { ok: inRoom && away.status === 200 && ended && room.status === 404, detail: `in the room ${inRoom}; turned away after (${away.status} ${away.body?.admission?.state ?? away.body?.error ?? ''}) → ${ended ? 'the ended page' : 'NOT the ended page'}; the room read ${room.status}` };
  });

  await step('I2.4g', async () => {
    await resetMock();
    const invite = await mintInvite(greta, iv);
    const g = await open(invite.linkPath);
    const second = await g.context.newPage();
    await second.goto(`${portal}${invite.linkPath}`, { waitUntil: 'domcontentloaded' });
    const secondIn = await seen(second, 'join-interview');
    await g.page.reload({ waitUntil: 'domcontentloaded' });
    const firstIn = await seen(g.page, 'join-interview');
    return { ok: g.landed === 'interview' && secondIn && firstIn, detail: `first tab ${g.landed}; the second tab on the same link ${secondIn ? 'lands' : 'did NOT land'}; the first tab's reload ${firstIn ? 'stays in (one window, one cookie: the newest session)' : 'is DEAD'}` };
  });

  await step('I2.4h', async () => {
    await resetMock();
    const invite = await mintInvite(greta, iv);
    const g = await open(invite.linkPath);
    await toWaiting(g.page);
    await until(async () => (await waiting(hugo, iv))?.state === 'waiting');
    await admit(hugo, iv, true);
    const token = await guestApi(g.context, 'GET', '/realtime-token');
    if (token.status !== 404) {
      notRun('I2.4h', `guest realtime is on in this world (the token answered ${token.status}); run with INTERVIEWS_GUEST_REALTIME=false to walk the cannot-open line`);
      return { ok: token.status === 200, detail: `guest realtime is on: the admitted candidate's token answers ${token.status} (the cannot-open line is walked with INTERVIEWS_GUEST_REALTIME=false)` };
    }
    const off = await seen(g.page, 'join-room-unavailable');
    const line = off ? (await g.page.getByTestId('join-room-unavailable').innerText()).replace(/\s+/g, ' ') : '';
    return { ok: off && /The call cannot open from this page yet\. Your interviewer has been told you are here\./.test(line), detail: `guest realtime off: "${line.slice(0, 100)}"` };
  });

  for (const c of opened) await c.close().catch(() => undefined);
  for (const c of [greta, hugo, wen, amara]) await c.close().catch(() => undefined);
  await resetMock();
}

async function readState(api, context, id) {
  return (await api(context, 'GET', `/api/interviews/interviews/${id}`)).body?.interview?.state ?? null;
}
