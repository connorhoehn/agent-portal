// Helpers the Milo pieces share (I3.2, I3.3, I3.4, I3.6, I3.7; hardening lane H3). Not a piece: the runner loads only files
// that start with a capital letter or a digit, and lib.mjs (which this lane does not edit) stays as H0 left it.
//
// The mock world has no platform-api, so a call's media session is stubbed the way scripts/journeys/meeting-assistant.mjs
// does (its header, "Two people share one call without media"): the realtime token advertises a stand-in platform API that
// answers join and end; mic and camera stay off. Seats, the call chat, the gateway and Milo's record are real. Transcript
// lines come from the mock-only injector (POST /api/dev/calls/:callId/transcript-lines), as that walk's do. Nothing here
// speaks, records or calls a model: the coach, Milo's notes and the plan run on their scripted stand-ins.

export const STAND_IN_SFU = 'http://interviews-h3.test';
const PRE_JOIN_KEY = 'orgiq.call-prejoin.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stub a context's call media (before its first page): mic and camera off, the SFU a stand-in that answers join/end. */
export async function stubCallMedia(context, label) {
  await context.addInitScript(([key]) => localStorage.setItem(key, JSON.stringify({ micOn: false, cameraOn: false, remember: true })), [PRE_JOIN_KEY]);
  await context.route('**/realtime-token', async (route) => {
    const response = await route.fetch();
    let json = {};
    try { json = await response.json(); } catch { /* not JSON: pass it through */ return route.fulfill({ response }); }
    await route.fulfill({ response, json: { ...json, platformApiUrl: STAND_IN_SFU, videoUrl: null } });
  });
  await context.route(`${STAND_IN_SFU}/**`, (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.fulfill({ json: p.endsWith('/join') ? { participantId: `participant-${label}`, token: null } : p.endsWith('/end') ? { ok: true } : { sessionId: 'interviews-h3-signalling-only', recording: { enabled: false, reason: 'default' } } });
  });
}

/** Watch a page for the call id it talks to (its /api/calls/<id>/… requests). → () => the id seen, or null. */
export function watchCallId(page) {
  let callId = null;
  page.on('request', (rq) => {
    if (callId) return;
    const m = /\/api\/calls\/([^/?]+)\//.exec(new URL(rq.url()).pathname);
    if (m) callId = decodeURIComponent(m[1]);
  });
  return () => callId;
}

export const roomUrl = (portal, id) => `${portal}/interviews/rounds/${id}/room`;
export const seen = (page, id, ms = 30_000) => page.getByTestId(id).first().waitFor({ timeout: ms }).then(() => true, () => false);

/**
 * A staff person opens the interview's room and starts (or joins) its call from the footer. The context must have had
 * stubCallMedia. → { page, callId } (callId null when the call did not start: the reason is thrown).
 */
export async function joinRoomCall(ctx, context, interviewId) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 160)));
  const callIdOf = watchCallId(page);
  await page.goto(roomUrl(ctx.portal, interviewId), { waitUntil: 'domcontentloaded' });
  if (!(await seen(page, 'interview-room-pane'))) throw new Error('the room did not open');
  // The first person starts the call (the footer's start); anyone after joins the running one (the footer's Join).
  const startBtn = page.getByTestId('shell-footer-context-start');
  const joinBtn = page.getByTestId('shell-footer-context-join');
  const which = await Promise.any([
    startBtn.first().waitFor({ timeout: 30_000 }).then(() => 'start'),
    joinBtn.first().waitFor({ timeout: 30_000 }).then(() => 'join'),
  ]).catch(() => null);
  if (!which) {
    await page.screenshot({ path: `${ctx.out}/h3-no-start-${interviewId}.png` }).catch(() => undefined);
    const footer = (await page.locator('footer').last().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`no Join the call in the footer ("${footer}"); page errors: ${errors.join(' | ') || 'none'}`);
  }
  const start = which === 'start' ? startBtn.first() : joinBtn.first();
  for (let i = 0; i < 40 && await start.isDisabled(); i++) await sleep(250);
  if (await start.isDisabled()) throw new Error(`Join the call is disabled: "${(await start.getAttribute('title')) ?? ''}"`);
  await start.click();
  if (!(await seen(page, 'shell-call-dock'))) throw new Error('the call dock never showed');
  const end = Date.now() + 15_000;
  while (!callIdOf() && Date.now() < end) await sleep(250);
  if (!callIdOf()) throw new Error('no call id was seen on the wire');
  return { page, callId: callIdOf() };
}

/** The lead invites Milo from the call bar; resolves once Invite has gone (Milo is in the call). */
export async function inviteMilo(page) {
  const invite = page.getByTestId('assistant-invite');
  await invite.waitFor({ timeout: 30_000 });
  await invite.click();
  await invite.waitFor({ state: 'detached', timeout: 30_000 });
}

/** Hand transcript lines to whoever listens to the call (the mock injector). lines: [{ userId, text }]. → { status, listeners }. */
export async function inject(ctx, callId, lines) {
  const r = await fetch(`${ctx.middleware}/api/dev/calls/${encodeURIComponent(callId)}/transcript-lines`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(lines),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, listeners: body.listeners ?? null, accepted: body.accepted ?? null };
}

/**
 * The candidate by the API only: the recruiter's link for the interview, exchanged in a context with no account, and the
 * three answers given. → { context, guestId, inviteId }. guestId is the call identity `guest:<inviteId>`.
 */
export async function candidateAnswers(ctx, recruiter, interviewId, answers) {
  const invite = await ctx.mintInvite(recruiter, interviewId);
  if (invite.status !== 201) throw new Error(`the link was not made (${invite.status} ${invite.error ?? ''})`);
  const session = await ctx.guestSession(invite.token);
  if (session.status !== 200) throw new Error(`the link did not open (${session.status})`);
  const put = await ctx.guestConsents(session.context, answers ?? ctx.ALL_YES);
  if (put.status !== 200) throw new Error(`the answers were not taken (${put.status})`);
  const inviteId = invite.invite?.id ?? null;
  return { context: session.context, token: invite.token, linkPath: invite.linkPath, inviteId, guestId: inviteId ? `guest:${inviteId}` : null };
}

/** Poll an API read until `pred(body)` holds, at most `ms`. → the last { status, body } read. */
export async function until(ctx, context, path, pred, ms, every = 2000) {
  const end = Date.now() + ms;
  let r = await ctx.api(context, 'GET', path);
  while (!pred(r) && Date.now() < end) { await sleep(every); r = await ctx.api(context, 'GET', path); }
  return r;
}

/** The candidate (from candidateAnswers) knocks by the API and the lead lets them in. → the guest's call identity (`guest:<inviteId>`). */
export async function letIn(ctx, lead, guest, interviewId) {
  const knock = await ctx.guestApi(guest.context, 'POST', '/knock', {});
  if (knock.status >= 300) throw new Error(`the knock answered ${knock.status}`);
  const a = await ctx.admit(lead, interviewId, true);
  if (a.status !== 200) throw new Error(`Admit answered ${a.status}`);
  const room = await ctx.guestApi(guest.context, 'GET', '/room');
  if (room.status !== 200) throw new Error(`the candidate's room read answered ${room.status}`);
  guest.guestId = room.body?.self?.userId ?? room.body?.room?.self?.userId ?? null;
  if (!guest.guestId) throw new Error(`the candidate's room read named no call identity: ${JSON.stringify(room.body).slice(0, 120)}`);
  return guest.guestId;
}

/** The recruiter sets an opening's two caps (dollars; 0 pauses Milo for it). Reads the record first for its other details. → status. */
export async function setCaps(ctx, recruiter, openingId, { budgetCapUsd, interviewCapUsd }) {
  const r = await ctx.api(recruiter, 'GET', `/api/interviews/openings/${openingId}`);
  const o = r.body?.opening;
  if (!o) throw new Error(`the opening read answered ${r.status}`);
  const body = {
    revision: o.revision, title: o.title, level: o.level, team: o.team, location: o.location,
    hiringManagerId: o.hiringManagerId ?? o.hiringManager?.id ?? null, state: o.state, budgetCapUsd, interviewCapUsd,
  };
  const w = await ctx.api(recruiter, 'PUT', `/api/interviews/openings/${openingId}/details`, body);
  if (w.status !== 200) throw new Error(`the caps were not saved (${w.status} ${JSON.stringify(w.body).slice(0, 120)})`);
  return w.status;
}

/** Every Milo-ish text a candidate's reads hold: the guest's own routes as JSON, joined. For "absent from the guest's reads". */
export async function guestReads(ctx, guestContext) {
  const parts = [];
  for (const p of ['/interview', '/admission', '/room']) {
    const r = await ctx.guestApi(guestContext, 'GET', p);
    parts.push(`${p} ${r.status} ${JSON.stringify(r.body ?? null)}`);
  }
  return parts.join('\n');
}

/**
 * A live interview with its call running: the lead (stubbed media) starts the round when it is not live, the candidate opens
 * the link in a page of their own, answers (`answers`; ALL_YES by default) and knocks, the lead admits, the lead starts the
 * call, the candidate joins it (when `guestJoins`), and the lead invites Milo (when `invite`). With `answers: null` the
 * candidate never opens the link. → { lead, leadPage, recruiter, guest: { context, page, guestId } | null, callId, close() }.
 */
export async function liveRoom(ctx, { interviewId, leadId, answers, admitGuest = true, guestJoins = true, invite = true, extra = [] }) {
  const opened = [];
  const lead = await ctx.signIn(leadId); opened.push(lead); await stubCallMedia(lead, 'lead');
  const recruiter = await ctx.signIn(ctx.SEED.cast.recruiter); opened.push(recruiter);
  const close = async () => { for (const c of opened) await c.close().catch(() => undefined); };
  try {
    const iv = await ctx.readInterview(lead, interviewId);
    if (!iv) throw new Error(`the lead cannot read ${interviewId}`);
    if (iv.state !== 'live') {
      const s = await ctx.startInterview(lead, interviewId);
      if (s.status !== 200) throw new Error(`start answered ${s.status}`);
    }
    let guest = null;
    if (answers !== null) {
      const inv = await ctx.mintInvite(recruiter, interviewId);
      if (inv.status !== 201) throw new Error(`the link was not made (${inv.status})`);
      const g = await ctx.openGuest(inv.linkPath);
      opened.push(g.context);
      await stubCallMedia(g.context, 'candidate');
      let at = null;
      try { at = await ctx.toWaiting(g.page, answers ?? ctx.ALL_YES); } catch (e) {
        await g.page.screenshot({ path: `${ctx.out}/h3-guest-${interviewId}.png` }).catch(() => undefined);
        const ids = await g.page.evaluate(() => [...document.querySelectorAll('[data-testid^="join-"]')].map((x) => x.getAttribute('data-testid')).slice(0, 12)).catch(() => []);
        throw new Error(`the candidate's steps stopped (landed ${g.landed}; on the page ${ids.join(', ')}): ${String(e.message).split('\n')[0]}`);
      }
      if (at !== 'waiting' && at !== 'room') throw new Error(`the candidate stopped at ${at}`);
      guest = { context: g.context, page: g.page, guestId: null, linkPath: inv.linkPath };
      if (admitGuest) {
        const a = await ctx.admit(lead, interviewId, true);
        if (a.status !== 200) throw new Error(`Admit answered ${a.status}`);
        await guestIdentity(ctx, guest);
      }
    }
    const { page: leadPage, callId } = await joinRoomCall(ctx, lead, interviewId);
    if (guest && admitGuest && guestJoins) await guestJoinCall(guest);
    for (const who of extra) { const c = await ctx.signIn(who.userId); opened.push(c); await stubCallMedia(c, who.label); who.context = c; who.page = (await joinRoomCall(ctx, c, interviewId)).page; }
    if (invite) await inviteMilo(leadPage);
    return { lead, leadPage, recruiter, guest, callId, close, opened };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The call chat as one context reads it (the panel's history, or the candidate's guest-filtered one). → messages [] */
export async function chatOf(ctx, context, callId) {
  const r = await ctx.api(context, 'GET', `/api/calls/${encodeURIComponent(callId)}/chat?limit=100`);
  return { status: r.status, messages: r.body?.messages ?? [] };
}

export { sleep };

/** The candidate's call identity (`guest:<inviteId>`), from their room read once they are let in. */
export async function guestIdentity(ctx, guest) {
  const room = await ctx.guestApi(guest.context, 'GET', '/room');
  guest.guestId = room.body?.room?.self?.userId ?? null;
  return guest.guestId;
}

/** The let-in candidate joins the running call from their own bar. */
export async function guestJoinCall(guest) {
  // The bar's start when nobody is in the call yet; its Join when the panel already is.
  const join = guest.page.getByTestId('join-room-bar-start').or(guest.page.getByTestId('join-room-bar-join')).first();
  await join.waitFor({ timeout: 30_000 });
  for (let i = 0; i < 40 && await join.isDisabled(); i++) await sleep(250);
  await join.click();
  // The pre-join check comes first (camera, microphone, speakers): its "Join now", then the call.
  const now = guest.page.getByRole('button', { name: 'Join now', exact: true });
  if (await now.first().waitFor({ timeout: 10_000 }).then(() => true, () => false)) await now.first().click();
  if (!(await seen(guest.page, 'join-room-time-left', 30_000))) {
    await guest.page.screenshot({ path: `${process.argv[process.argv.indexOf('--out') + 1]}/h3-guest-join.png` }).catch(() => undefined);
    const ids = await guest.page.evaluate(() => [...document.querySelectorAll('[data-testid^="join-room"]')].map((x) => x.getAttribute('data-testid')).slice(0, 15)).catch(() => []);
    const bar = (await guest.page.getByTestId('join-room-footer').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
    throw new Error(`the candidate never joined the call (bar "${bar}"; ${ids.join(', ')})`);
  }
}

/**
 * The candidate's call chat as their page shows it (the gateway's history replay and live messages; a guest has no HTTP read
 * of the call chat: it answers 403). Opens the chat pane from the bar's Message when it is closed. → the pane's text.
 */
export async function guestChatText(guest, settleMs = 1500) {
  const pane = guest.page.getByTestId('join-room-chat');
  if (!(await pane.first().isVisible().catch(() => false))) await guest.page.getByTestId('join-room-bar-chat').first().click().catch(() => undefined);
  await pane.first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  await sleep(settleMs);
  return (await pane.first().innerText().catch(() => '')).replace(/\s+/g, ' ');
}

/** A message's words (the chat's `message` field). */
export const words = (m) => String(m?.message ?? '');
