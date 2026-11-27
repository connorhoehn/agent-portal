// Piece E3-door: the candidate's pages and both live rooms, measured in every state at 1440 and 1280 (rows E3, O-279), and each
// candidate's state again at 768 and 390 as its own `.narrow` step (gap audit 2026-11-20 §11).
// It was a scratch script in UI round 4 (audit-door); this is the same measure on the harness. One step per state, E3.a, E3.b, ...:
// it passes when the state has no sideways scroll, nothing cut by its container or the window, and every bar on one line.
// The other measures (overlap, sizes off the type scale, heading skips, controls with no name, staff words on a candidate's page) are
// printed in the step's detail as notes; they do not fail a step. It joins a technical round (lead Hugo) and a behavioural one
// (lead Wen, Hugo on the panel) with fake devices and a stubbed media service, so it runs under the walk lock like any walk.
import { measureAll } from './e3-measure.mjs';

const SFU = 'http://interviews-ui.test';
const GUEST = { guest: true, bars: ['join-room-footer', 'join-room-bar', 'join-steps'], boxes: ['join-room-pane', 'join-room-stage', 'join-room-footer', 'join-room-bar'] };
const STAFF = { bars: ['shell-footer'], barExclude: '[data-testid="interview-room-ask"]', boxes: ['interview-room', 'shell-footer', 'interview-room-ask'] };
const letters = (n) => (n < 26 ? String.fromCharCode(97 + n) : String.fromCharCode(97 + Math.floor(n / 26) - 1) + String.fromCharCode(97 + (n % 26)));

export default async function run(ctx) {
  const { SEED, record, signIn, resetMock, mintInvite, openGuest, api, portal } = ctx;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let n = 0;
  const contexts = [];

  /** The widths every state is measured at, and the narrower ones a candidate's page is measured at too (gap audit 2026-11-20 §11). */
  const DESKTOP = [[1440, 900], [1280, 800]];
  const NARROW = [[768, 1024], [390, 844]];

  /** The same three assertions at each width; the notes are printed, never failed on. */
  async function measureAt(page, widths, opts, bad, notes) {
    for (const [w, h] of widths) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(900);
      const res = await page.evaluate(measureAll, { bars: [], boxes: [], ...opts });
      if (res.sideways > 0) bad.push(`${w}: sideways scroll ${res.sideways}px`);
      if (res.cut?.length) bad.push(`${w}: cut ${res.cut.join('; ')}`);
      for (const [k, v] of Object.entries(res.bars ?? {})) if (v.spreadCentre > 2) bad.push(`${w}: ${k} is not one line (${v.spreadCentre}px)`);
      if (res.overlap?.length) notes.push(`${w} overlap ${res.overlap.length}`);
      if (res.offScale?.length) notes.push(`${w} off-scale ${res.offScale.join(', ')}`);
      if (res.headingSkips?.length) notes.push(`${w} heading skip ${res.headingSkips.join(', ')}`);
      if (res.noName?.length) notes.push(`${w} unnamed ${res.noName.join(', ')}`);
      if (res.staffWords?.length) notes.push(`${w} staff words ${res.staffWords.length}`);
    }
  }

  /**
   * Measure one state at the desktop widths and record it as the next step. A candidate's state (GUEST) is measured again at
   * 768 and 390 and recorded as its own step, `<id>.narrow`, with the same assertions, so a phone-width failure is named on
   * its own and never hidden in, or excused by, the desktop step.
   */
  async function state(page, label, opts) {
    const id = `E3.${letters(n++)}`;
    const widths = [[DESKTOP, id, '']].concat(opts?.guest ? [[NARROW, `${id}.narrow`, ' at 768 and 390']] : []);
    for (const [list, stepId, suffix] of widths) {
      try {
        const notes = [];
        const bad = [];
        await measureAt(page, list, opts, bad, notes);
        record(stepId, bad.length === 0, `${label}${suffix}: ${bad.length ? bad.join(' | ') : 'no sideways scroll, nothing cut, bars on one line'}${notes.length ? ` (notes: ${notes.join('; ')})` : ''}`);
      } catch (e) { record(stepId, false, `${label}${suffix}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
    }
    await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  }

  /** A context whose media calls are stubbed (the walk stack has no media service) and whose pre-join choice is remembered. */
  async function stub(context, tokenRoute, key, who) {
    await context.addInitScript(([k]) => localStorage.setItem(k, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), [key]);
    await context.route(tokenRoute, async (route) => {
      const response = await route.fetch(); let j = {}; try { j = await response.json(); } catch { /* not json */ }
      await route.fulfill({ response, json: { ...j, platformApiUrl: SFU, videoUrl: null } });
    });
    await context.route(`${SFU}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${who}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'e3-door', recording: { enabled: false, reason: 'default' } } });
    });
    return context;
  }
  async function leadJoin(userId, id) {
    const context = await stub(await signIn(userId), '**/api/session/realtime-token', 'orgiq.call-prejoin.v1', userId);
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`${portal}/interviews/rounds/${id}/room`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interview-room').waitFor({ timeout: 40_000 });
    await page.waitForTimeout(3000);
    await page.getByTestId('shell-footer').getByRole('button', { name: /join the call/i }).first().click({ timeout: 8000 }).catch(() => {});
    await page.getByRole('dialog').getByRole('button', { name: /join|start|continue/i }).last().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(4000);
    return { context, page };
  }
  /** A candidate's browser on the link, with the media stubs added before the room step asks for them. */
  async function openCandidate(linkPath) {
    const g = await openGuest(linkPath);
    contexts.push(g.context);
    await stub(g.context, '**/api/interview-invite/realtime-token', 'interviews.guest-prejoin.v1', 'guest');
    await g.page.evaluate(() => localStorage.setItem('interviews.guest-prejoin.v1', JSON.stringify({ micOn: false, cameraOn: false, remember: true })));
    return g;
  }
  async function answer(g, values) {
    for (const [part, v] of Object.entries(values)) await g.getByTestId(`join-consent-${part}-choice`).locator('label').filter({ hasText: v ? /^Yes$/ : /^No$/ }).click({ timeout: 3000 });
    await g.getByTestId('join-consents-continue').click({ timeout: 8000 });
  }
  async function staffTabs(page, label) {
    const tabs = await page.getByRole('tab').allInnerTexts().catch(() => []);
    for (const t of tabs) {
      const name = t.trim().split('\n')[0];
      await page.getByRole('tab', { name }).first().click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(900);
      await state(page, `${label}, ${name.toLowerCase()} tab`, STAFF);
    }
  }
  async function enterRoom(g, lead, id) {
    await ctx.admit(lead, id, true);
    await g.getByTestId('join-room-bar').getByRole('button', { name: /join/i }).first().click({ timeout: 12_000 }).catch(() => {});
    await g.waitForTimeout(2500);
    await g.getByRole('dialog').getByRole('button', { name: /join|start|continue/i }).last().click({ timeout: 4000 }).catch(() => {});
    await g.waitForTimeout(6000);
  }
  const wrap = async (label, fn) => { try { await fn(); } catch (e) { record(`E3.${letters(n++)}`, false, `${label}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); } };

  try {
    await resetMock();
    const greta = await signIn(SEED.cast.recruiter);
    contexts.push(greta);

    // A technical round: the candidate's steps, then the live room (candidate and lead), Milo, the end.
    await wrap('technical round', async () => {
      const T1 = SEED.guestInterview;
      const { linkPath } = await mintInvite(greta, T1);
      const dead = await openGuest(`${linkPath.slice(0, -4)}zzzz`);
      contexts.push(dead.context);
      await state(dead.page, 'the dead link', GUEST);
      const hugo = await leadJoin(SEED.cast.interviewer, T1);
      const g = await openCandidate(linkPath);
      await g.page.getByTestId('join-continue').waitFor({ timeout: 20_000 });
      await state(g.page, 'candidate 1, the landing', GUEST);
      await g.page.getByTestId('join-continue').click({ timeout: 8000 });
      await g.page.getByTestId('join-consents').waitFor({ timeout: 10_000 });
      await state(g.page, 'candidate 2, the three answers', GUEST);
      await answer(g.page, { recording: true, transcription: true, milo: true });
      await g.page.getByTestId('join-devices').waitFor({ timeout: 10_000 });
      await g.page.getByTestId('join-devices-start').click({ timeout: 4000 }).catch(() => {});
      await g.page.waitForTimeout(1500);
      await state(g.page, 'candidate 3, the device check', GUEST);
      await g.page.getByTestId('join-devices-continue').click({ timeout: 8000 });
      await g.page.getByTestId('join-waiting').waitFor({ timeout: 10_000 });
      await g.page.waitForTimeout(2500);
      await state(g.page, 'candidate 4, the waiting room', GUEST);
      await hugo.page.waitForTimeout(3000);
      await state(hugo.page, 'the lead, the candidate is knocking', STAFF);
      await enterRoom(g.page, hugo.context, T1);
      await g.page.getByTestId('interview-pad').waitFor({ timeout: 20_000 });
      await state(g.page, 'candidate in the technical room, pad', GUEST);
      await g.page.getByTestId('join-room-pane-tab-chat').click({ timeout: 4000 });
      await g.page.waitForTimeout(900);
      await state(g.page, 'candidate in the technical room, chat', GUEST);
      await g.page.getByTestId('join-room-pane-tab-pad').click({ timeout: 4000 });
      await g.page.getByRole('button', { name: /^run/i }).first().click({ timeout: 4000 });
      await g.page.waitForTimeout(5000);
      await state(g.page, 'candidate in the technical room, a run\'s output', GUEST);
      await state(hugo.page, 'the lead, technical room live', STAFF);
      await staffTabs(hugo.page, 'the lead, technical room');
      // Milo: invited, spoken words on, a few lines of transcript, then a suggestion to ask.
      const callId = (await api(hugo.context, 'GET', `/api/interviews/interviews/${T1}`)).body?.interview?.callId ?? null;
      await hugo.page.getByTestId('assistant-invite').click({ timeout: 6000 }).catch(() => {});
      await hugo.page.getByTestId('assistant-budget-ask').getByRole('button', { name: /go ahead/i }).click({ timeout: 3000 }).catch(() => {});
      await hugo.page.waitForTimeout(4000);
      if (callId) {
        const base = `/api/calls/${encodeURIComponent(callId)}/assistant`;
        await api(hugo.context, 'POST', `${base}/voice`, { on: true });
        const gid = (await ctx.guestApi(g.context, 'GET', '/room')).body?.room?.self?.userId;
        const lines = [[SEED.cast.interviewer, 'Let us start with how you would design a rate limiter for a public API.'], [gid, 'I would put a token bucket per API key in front of the service, kept in Redis.'], [SEED.cast.interviewer, 'And what happens when Redis is slow or down?'], [gid, 'I would fail open for reads with a local fallback bucket.']];
        for (const [userId, text] of lines) { await api(hugo.context, 'POST', `/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, { userId, text }); await hugo.page.waitForTimeout(400); }
      }
      const ask = hugo.page.getByTestId('interview-room-ask').getByRole('button', { name: /have milo ask/i });
      let got = false;
      for (let i = 0; i < 20 && !got; i += 1) { await hugo.page.getByTestId('interview-room-ask-open').click({ timeout: 1500 }).catch(() => undefined); if (await ask.isVisible().catch(() => false)) got = true; else await hugo.page.waitForTimeout(2500); }
      if (got) await state(hugo.page, 'the lead, a suggestion from Milo', STAFF);
      else console.log('NOT RUN E3 Milo suggestion state: none arrived within 50 seconds on the scripted model');
      await state(g.page, 'candidate in the technical room, Milo listening', GUEST);
      await ctx.endInterview(hugo.context, T1);
      await g.page.getByTestId('join-ended').waitFor({ timeout: 20_000 });
      await g.page.waitForTimeout(1500);
      await state(g.page, 'candidate 6, the ended page', GUEST);
    });
    for (const c of contexts.splice(1)) await c.close().catch(() => {});

    // A behavioural round: held answers, the panel's views, the candidate's room.
    await wrap('behavioural round', async () => {
      await resetMock();
      const B1 = SEED.panelInterview;
      const { linkPath } = await mintInvite(greta, B1);
      const g2 = await openCandidate(linkPath);
      await g2.page.getByTestId('join-continue').click({ timeout: 20_000 });
      await answer(g2.page, { recording: false, transcription: true, milo: true });
      // The held page needs a required consent part, which only the environment sets (INTERVIEWS_REQUIRED_CONSENTS): without it, not run.
      const held = await g2.page.getByTestId('join-held').waitFor({ timeout: 6000 }).then(() => true, () => false);
      if (held) {
        await state(g2.page, 'candidate 5, the held page', GUEST);
        await g2.page.getByTestId('join-held').getByRole('button', { name: /change my answers/i }).first().click({ timeout: 5000 });
        await g2.page.getByTestId('join-consents').waitFor({ timeout: 10_000 });
        await answer(g2.page, { recording: true });
      } else console.log('NOT RUN E3 held page: this world requires no consent part (set INTERVIEWS_REQUIRED_CONSENTS, e.g. "recording")');
      await g2.page.getByTestId('join-devices').waitFor({ timeout: 10_000 });
      await g2.page.getByTestId('join-devices-continue').click({ timeout: 8000 });
      await g2.page.getByTestId('join-waiting').waitFor({ timeout: 10_000 });
      const wen = await leadJoin(SEED.cast.interviewer2, B1);
      const hugo = await leadJoin(SEED.cast.interviewer, B1);
      await state(hugo.page, 'a panel member, before the candidate is in', STAFF);
      await enterRoom(g2.page, wen.context, B1);
      await g2.page.waitForTimeout(2000);
      await state(g2.page, 'candidate in the behavioural room', GUEST);
      // A behavioural round's candidate has one pane (Chat), so there may be no tab to click.
      if (await g2.page.getByTestId('join-room-pane-tab-chat').count()) {
        await g2.page.getByTestId('join-room-pane-tab-chat').click({ timeout: 4000 });
        await g2.page.waitForTimeout(900);
        await state(g2.page, 'candidate in the behavioural room, chat', GUEST);
      } else console.log('NOT RUN E3 behavioural chat tab: the candidate has only the chat pane in this round');
      await state(wen.page, 'the lead, behavioural room live', STAFF);
      await staffTabs(wen.page, 'the lead, behavioural room');
      await state(hugo.page, 'a panel member, behavioural room live', STAFF);
      await staffTabs(hugo.page, 'a panel member, behavioural room');
      await ctx.endInterview(wen.context, B1);
    });
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
  }
}
