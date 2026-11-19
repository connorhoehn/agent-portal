// Piece I2.7: panel seats (docs/interviews-tenant-plan.md row I2.7; UI round 3's three-person room). Three contexts:
// the lead, a panel member and the candidate (mintInvite(recruiter) → openGuest(linkPath), no account).
//   I2.7a  Nadia's leadership round (Wen leads, Hugo on the panel, behavioural): the candidate's waiting page names the
//          lead and counts the other ("You are meeting Wen Zhao and one other interviewer."), and never names Hugo
//   I2.7b  the panel member before the lead joins: "Waiting for the lead", the panel line names both seats, the waiting
//          candidate reads "Waiting for the lead to let them in", and the footer holds no Admit, no Not yet and no End
//          interview; shots at both widths
//   I2.7c  the lead's footer holds the knock: Admit from the deck lets the candidate in; the panel member still has no
//          admit and no End
//   I2.7d  Kwame's live coding round (Hugo leads, Wen on the panel, technical): the panel member reads the technical
//          pane's tabs (Pad, Questions, Milo, Chat) and holds no admit and no End; the candidate arriving after the start
//          (their three answers are seeded, so the link opens on the device check) knocks and is let in; the waiting
//          page names Hugo and counts one other
// Written, not run (the mock world has no platform-api, so no call starts): "3 joined" on all three bars; the panel
// member has no Invite, End, admit, Have Milo ask or Dismiss in the call; the candidate sees both staff tiles: the lead's
// with the lead's name, the panel member's as "Interviewer" (E4 #32: the lead's name only, everywhere); the candidate
// leaves → "You left the call" with Join → joins again → 3 joined.
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
  const { SEED, record, signIn, resetMock, mintInvite, openGuest, toWaiting, waiting, admit, shootPage, portal } = ctx;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);
  const until = async (fn, ms = 15_000) => { const end = Date.now() + ms; let v = await fn(); while (!v && Date.now() < end) { await new Promise((r) => setTimeout(r, 500)); v = await fn(); } return v; };
  const roomUrl = (id) => `${portal}/interviews/rounds/${id}/room`;
  const leadControls = async (page) => ({
    admit: await page.getByTestId('interview-room-ask-option-admit').count(),
    notYet: await page.getByTestId('interview-room-ask-option-not-yet').count(),
    end: await page.getByTestId('interview-end').count(),
  });
  const none = (c) => c.admit === 0 && c.notYet === 0 && c.end === 0;
  const iv = SEED.panelInterview;
  const opened = [];

  await resetMock();
  const greta = await signIn(SEED.cast.recruiter);
  const hugo = await signIn(SEED.cast.interviewer);
  const wen = await signIn(SEED.cast.interviewer2);
  let guest = null;
  const panel = await hugo.newPage();
  const lead = await wen.newPage();

  await step('I2.7a', async () => {
    const invite = await mintInvite(greta, iv);
    guest = await openGuest(invite.linkPath);
    opened.push(guest.context);
    const at = await toWaiting(guest.page);
    const meeting = (await guest.page.getByTestId('join-waiting-meeting').innerText().catch(() => '')).trim();
    const text = await guest.page.locator('body').innerText();
    return { ok: at === 'waiting' && meeting === 'You are meeting Wen Zhao and one other interviewer.' && !/Hugo/.test(text),
      detail: `the candidate ${at}; "${meeting}"; the panel member's name ${/Hugo/.test(text) ? 'IS on the page' : 'is not on the page'}` };
  });

  await step('I2.7b', async () => {
    await until(async () => (await waiting(wen, iv))?.state === 'waiting');
    await panel.goto(roomUrl(iv), { waitUntil: 'domcontentloaded' });
    await seen(panel, 'interview-room-idle');
    await panel.waitForTimeout(5000); // the room's knock read runs every few seconds
    const { state: title } = await roomHeader(panel);
    const facts = await roomFacts(panel);
    const controls = await leadControls(panel);
    const shots = await shootPage(panel, 'room-panel-before');
    const ok = title.startsWith('Waiting for the lead') && /Wen Zhao \(lead\)/.test(facts) && /Hugo Marchetti/.test(facts) && /The candidate Waiting for the lead to let them in/.test(facts) && none(controls) && shots.every((s) => s.ok);
    return { ok, detail: `"${title}"; facts "${facts.slice(0, 160)}"; lead's controls ${JSON.stringify(controls)}` };
  });

  await step('I2.7c', async () => {
    await lead.goto(roomUrl(iv), { waitUntil: 'domcontentloaded' });
    const knock = await seen(lead, 'interview-room-ask-option-admit');
    if (knock) await lead.getByTestId('interview-room-ask-option-admit').click();
    const inRoom = await seen(guest.page, 'join-room');
    await panel.waitForTimeout(1000);
    const controls = await leadControls(panel);
    return { ok: knock && inRoom && none(controls), detail: `the lead's deck ${knock ? 'holds Admit' : 'has NO Admit'}; the candidate ${inRoom ? 'is in the room' : 'is NOT in the room'}; the panel member's controls ${JSON.stringify(controls)}` };
  });

  await step('I2.7d', async () => {
    const live = SEED.interviews.kwameLive;
    const wp = await wen.newPage();
    await wp.goto(roomUrl(live), { waitUntil: 'domcontentloaded' });
    await seen(wp, 'interview-room-pane');
    const tabs = (await wp.getByTestId('interview-room-pane').getByRole('tab').allInnerTexts()).map((t) => t.trim().split('\n')[0]);
    const title = (await roomHeader(wp).catch(() => ({ state: '' }))).state;
    const invite = await mintInvite(greta, live);
    const g = await openGuest(invite.linkPath);
    opened.push(g.context);
    // The seed already holds Kwame's three answers, so the link opens on the device check, not the questions.
    await seen(g.page, 'join-devices');
    await g.page.getByTestId('join-devices-continue').click();
    const at = (await seen(g.page, 'join-waiting')) ? 'waiting' : 'not waiting';
    const meeting = (await g.page.getByTestId('join-waiting-meeting').innerText().catch(() => '')).trim();
    await wp.waitForTimeout(5000);
    const controls = await leadControls(wp);
    await until(async () => (await waiting(hugo, live))?.state === 'waiting');
    const yes = await admit(hugo, live, true);
    const inRoom = await seen(g.page, 'join-room');
    await wp.close();
    const ok = JSON.stringify(tabs) === '["Pad","Questions","Milo","Chat","Details"]' && none(controls) && at === 'waiting'
      && meeting === 'You are meeting Hugo Marchetti and one other interviewer.' && yes.status === 200 && inRoom;
    return { ok, detail: `Wen on the panel reads "${title}", tabs ${tabs.join('/')}, lead's controls ${JSON.stringify(controls)}; the candidate arriving after the start: ${at}, "${meeting}", admitted ${yes.status} → ${inRoom ? 'the room' : 'NOT the room'}` };
  });

  console.log('NOT RUN I2.7e: three in the call: "3 joined" on all three bars, the panel member without Invite, End, admit, Have Milo ask or Dismiss, the candidate\'s lead tile reads the lead\'s name and the panel member\'s "Interviewer" (E4 #32), leave → "You left the call" → Join → 3 joined: the mock world has no platform-api, so no call starts (social profile only)');

  for (const c of opened) await c.close().catch(() => undefined);
  for (const c of [greta, hugo, wen]) await c.close().catch(() => undefined);
  await resetMock();
}
