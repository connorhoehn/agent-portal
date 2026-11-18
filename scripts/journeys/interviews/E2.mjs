// Piece E2: isolation (docs/interviews-tenant-plan.md row E2; hardening lane H6). Start from "refused everywhere" and show
// each opening is the only one, with the right principal succeeding in the same world.
//   E2.404  (run by scripts/journeys/interviews.mjs after the pieces) the table scripts/validate-interviews.d/E2.404: every other tenant's list and one write, every other interview
//           (an interviewer with no seat, a hiring manager on another's opening, a guest of another interview), the export,
//           the runs stream, the reverse (the Work-only persona, anon and a guest at the interviews gate)
//   E2a     channels on the middleware's gateway (/ws): each role, the Work-only persona and a guest of another interview,
//           on another tenant's lobby, another interview's lobby and another interview's pad, are refused with no byte of
//           it; the seats (Hugo and Wen on Kwame's live pad and lobby) and the Work-only persona on Work's lobby succeed
//   E2b     two live rounds, each with its candidate let in: each guest reads and cancels only its own round's runs, is
//           seated on its own pad and refused on the other's
//   E2c     a running interview call with Milo in it: the lead reads Milo's state; the Work-only persona, a guest of another
//           interview and the candidate's own browser read nothing of it; the candidate's media binding refuses another
//           person's media id and a guest of another interview
//   E2d     the gate's answer to a guest and to a caller with no session (open item 3): the guest's cookie is scoped to
//           /api/interview-invite (so a candidate's browser is anonymous on every other path, the dev mode's 403); carried
//           by hand onto a staff route it is the gate's 401
// The sockets are opened from Node to MIDDLEWARE_URL/ws (the pattern of scripts/journeys/gateway-refusal.mjs, which runs in a
// page); a local copy because the harness has no socket helper ("Harness gap" in lane H6's report).
import { liveRoom, sleep } from './h3-call.mjs';

const TICK = 1500;

/** Open a socket with `token`, send `frames` once the session frame arrives, and collect what comes back for `channel`. */
async function onChannel(middleware, token, channel, frames) {
  const url = `${middleware.replace(/^http/, 'ws')}/ws`;
  const got = [];
  return new Promise((resolve) => {
    let ws;
    const done = (why) => { clearTimeout(deadline); try { ws.onclose = null; ws.close(); } catch { /* gone */ } resolve({ got, why }); };
    const deadline = setTimeout(() => done('timeout'), 6000);
    try { ws = new WebSocket(url, ['bearer-token-v1', token]); } catch (e) { done(`no socket: ${e.message}`); return; }
    ws.onerror = () => done('socket error');
    ws.onclose = (e) => done(`closed ${e.code}`);
    ws.onmessage = ({ data }) => {
      let f; try { f = JSON.parse(String(data)); } catch { return; }
      if (f.type === 'session') { for (const fr of frames) ws.send(JSON.stringify(fr)); setTimeout(() => done(null), TICK); return; }
      if (f.channel === channel) got.push(f);
    };
  });
}
const PAD = (id) => `doc:ivpad:${id}`;
const LOBBY = (id) => `interviews:interview:${id}`;
const padFrames = (ch) => [{ service: 'crdt', action: 'subscribe', channel: ch }];
const lobbyFrames = (ch) => [{ service: 'presence', action: 'subscribe', channel: ch }, { service: 'chat', action: 'join', channel: ch }, { service: 'chat', action: 'history', channel: ch, limit: 20 }];
/** Refused: a channel denial and nothing of the channel (no snapshot, update, presence or chat history). */
const verdict = ({ got, why }) => {
  const denied = got.some((f) => f.type === 'error' || f.type === 'crdt:error');
  const leaked = got.filter((f) => f.type === 'crdt:snapshot' || f.type === 'crdt:update' || f.type === 'crdt:awareness' || (f.type === 'crdt' && f.action === 'subscribed')
    || (f.type === 'presence' && f.action !== 'set') || (f.type === 'chat' && ['history', 'message', 'joined'].includes(f.action))).length;
  return { denied, leaked, why };
};
const seated = ({ got }) => got.some((f) => (f.type === 'crdt' && f.action === 'subscribed') || (f.type === 'presence' && f.action === 'subscribed'));

export default async function run(ctx) {
  const { SEED, record, resetMock, api, guestApi, signIn, refusals, mintInvite, guestSession, guestConsents, admit, startInterview, middleware, portal } = ctx;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const KL = SEED.interviews.kwameLive; const AIKO = SEED.interviews.aikoCoding; const MATEO = SEED.interviews.mateoDesign;
  const staffToken = async (context) => (await api(context, 'GET', '/api/session/realtime-token')).body?.token;
  const guestToken = async (context) => (await guestApi(context, 'GET', '/realtime-token')).body?.token;
  /** A candidate of `interviewId` by the API, let in by its lead when `letIn`. → the guest's context. */
  const candidate = async (recruiter, lead, interviewId, letIn) => {
    const inv = await mintInvite(recruiter, interviewId);
    if (inv.status !== 201) throw new Error(`the link for ${interviewId} was not made (${inv.status})`);
    const g = await guestSession(inv.token);
    if (g.status !== 200) throw new Error(`the link for ${interviewId} did not open (${g.status})`);
    if (letIn) {
      await guestConsents(g.context); // Kwame's answers are seeded: a 409 that changes nothing
      const k = await guestApi(g.context, 'POST', '/knock', {});
      if (k.status !== 200) throw new Error(`the knock for ${interviewId} answered ${k.status}`);
      const a = await admit(lead, interviewId, true);
      if (a.status !== 200) throw new Error(`Admit for ${interviewId} answered ${a.status}`);
    }
    return g.context;
  };

  // ── E2a: channels ───────────────────────────────────────────────────────────────────────────────────────────────────
  await resetMock();
  {
    const opened = [];
    try {
      const people = {};
      for (const who of ['recruiter', 'interviewer', 'interviewer2', 'hiringManager', 'workOnly']) { people[who] = await signIn(SEED.cast[who]); opened.push(people[who]); }
      const guestOther = await candidate(people.recruiter, people.interviewer, AIKO, false); opened.push(guestOther);
      // Each principal against what is not theirs: another tenant's lobby, another interview's lobby and pad.
      const cases = [
        ['recruiter', 'orgiq:lobby', 'lobby'], ['recruiter', LOBBY(KL), 'lobby'], ['recruiter', PAD(KL), 'pad'],
        ['interviewer', 'orgiq:lobby', 'lobby'], ['interviewer', LOBBY(AIKO), 'lobby'], ['interviewer', PAD(AIKO), 'pad'],
        ['interviewer2', 'assessment:lobby', 'lobby'], ['interviewer2', LOBBY(MATEO), 'lobby'], ['interviewer2', PAD(MATEO), 'pad'],
        ['hiringManager', 'orgiq:lobby', 'lobby'], ['hiringManager', LOBBY(KL), 'lobby'], ['hiringManager', PAD(KL), 'pad'],
        ['workOnly', LOBBY(KL), 'lobby'], ['workOnly', PAD(KL), 'pad'], ['workOnly', 'assessment:lobby', 'lobby'],
        ['guestOther', 'orgiq:lobby', 'lobby'], ['guestOther', LOBBY(KL), 'lobby'], ['guestOther', PAD(KL), 'pad'], ['guestOther', PAD(AIKO), 'pad'],
      ];
      const tokens = {};
      for (const who of Object.keys(people)) tokens[who] = await staffToken(people[who]);
      tokens.guestOther = await guestToken(guestOther);
      const wrong = [];
      for (const [who, ch, kind] of cases) {
        if (!tokens[who]) { wrong.push(`${who}: no realtime token`); continue; }
        const v = verdict(await onChannel(middleware, tokens[who], ch, kind === 'pad' ? padFrames(ch) : lobbyFrames(ch)));
        if (!v.denied || v.leaked) wrong.push(`${who} on ${ch}: denied ${v.denied}, frames of it ${v.leaked}${v.why ? ` (${v.why})` : ''}`);
      }
      // The right principals in the same world.
      const right = [
        ['interviewer', PAD(KL), 'pad'], ['interviewer2', PAD(KL), 'pad'], ['interviewer', LOBBY(KL), 'lobby'], ['workOnly', 'orgiq:lobby', 'lobby'],
      ];
      for (const [who, ch, kind] of right) {
        if (!seated(await onChannel(middleware, tokens[who], ch, kind === 'pad' ? padFrames(ch) : lobbyFrames(ch)))) wrong.push(`${who} was not seated on ${ch}`);
      }
      record('E2a', wrong.length === 0, wrong.length ? wrong.slice(0, 4).join('; ') : `${cases.length} refusals with no byte of the channel; ${right.length} seats succeed`);
    } catch (e) {
      record('E2a', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally { for (const c of opened) await c.close().catch(() => undefined); }
  }

  // ── E2b: two live rounds, a candidate let into each ─────────────────────────────────────────────────────────────────
  await resetMock();
  {
    const opened = [];
    try {
      const recruiter = await signIn(SEED.cast.recruiter); opened.push(recruiter);
      const hugo = await signIn(SEED.cast.interviewer); opened.push(hugo);
      const s = await startInterview(hugo, MATEO);
      if (s.status !== 200) throw new Error(`Hugo could not start Mateo's design round (${s.status})`);
      const gK = await candidate(recruiter, hugo, KL, true); opened.push(gK);
      const gM = await candidate(recruiter, hugo, MATEO, true); opened.push(gM);
      const made = await api(hugo, 'POST', `/api/interviews/interviews/${MATEO}/runs`, { runId: 'h6-walk-run-0001', language: 'python', entrypoint: 'main.py', files: [{ path: 'main.py', content: 'print(1)' }] });
      if (made.status !== 202) throw new Error(`Hugo's run on Mateo's round answered ${made.status}`);
      const ids = async (g) => ((await guestApi(g, 'GET', '/runs')).body?.runs ?? []).map((r) => r.runId);
      const kIds = await ids(gK); const mIds = await ids(gM);
      const wrong = [];
      if (!kIds.includes('run-kwame-01') || kIds.includes('h6-walk-run-0001')) wrong.push(`Kwame's candidate lists ${kIds.join(',')}`);
      if (!mIds.includes('h6-walk-run-0001') || mIds.some((i) => i.startsWith('run-kwame'))) wrong.push(`Mateo's candidate lists ${mIds.join(',')}`);
      for (const [g, foreign, who] of [[gK, 'h6-walk-run-0001', 'Kwame\'s'], [gM, 'run-kwame-01', 'Mateo\'s']]) {
        const read = await guestApi(g, 'GET', `/runs/${foreign}`); const cancel = await guestApi(g, 'POST', `/runs/${foreign}/cancel`, {});
        if (read.status !== 404 || cancel.status !== 404) wrong.push(`${who} candidate on the other round's run: read ${read.status}, cancel ${cancel.status}`);
      }
      const tK = await guestToken(gK); const tM = await guestToken(gM);
      if (!seated(await onChannel(middleware, tK, PAD(KL), padFrames(PAD(KL))))) wrong.push('Kwame\'s candidate was not seated on his own pad');
      if (!seated(await onChannel(middleware, tM, PAD(MATEO), padFrames(PAD(MATEO))))) wrong.push('Mateo\'s candidate was not seated on his own pad');
      for (const [t, ch, who] of [[tK, PAD(MATEO), 'Kwame\'s'], [tM, PAD(KL), 'Mateo\'s'], [tM, LOBBY(KL), 'Mateo\'s']]) {
        const v = verdict(await onChannel(middleware, t, ch, ch.startsWith('doc:') ? padFrames(ch) : lobbyFrames(ch)));
        if (!v.denied || v.leaked) wrong.push(`${who} candidate on ${ch}: denied ${v.denied}, frames ${v.leaked}`);
      }
      record('E2b', wrong.length === 0, wrong.length ? wrong.join('; ') : `each candidate lists only its round's runs (${kIds.length} and ${mIds.length}), reads and cancels nothing of the other's, and is seated on its own pad only`);
    } catch (e) {
      record('E2b', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally { for (const c of opened) await c.close().catch(() => undefined); }
  }

  // ── E2c: a running interview call with Milo in it ───────────────────────────────────────────────────────────────────
  await resetMock();
  {
    let room = null; const opened = [];
    try {
      // Mateo's design round (Hugo leads): the candidate walks the consents, as liveRoom expects (Kwame's are seeded, so his page
      // skips them).
      room = await liveRoom(ctx, { interviewId: MATEO, leadId: SEED.cast.interviewer });
      const theo = await signIn(SEED.cast.workOnly); opened.push(theo);
      const guestOther = await candidate(room.recruiter, room.lead, AIKO, false); opened.push(guestOther);
      const call = (p) => `/api/calls/${encodeURIComponent(room.callId)}/${p}`;
      const wrong = [];
      const lead = await api(room.lead, 'GET', call('assistant/state'));
      if (lead.status !== 200) wrong.push(`the lead read Milo's state ${lead.status}`);
      for (const [who, c] of [['the Work-only persona', theo], ['a guest of another interview', guestOther], ['the candidate\'s own browser', room.guest.context]]) {
        for (const p of ['assistant/state', 'assistant/transcript', 'assistant/minutes', 'chat']) {
          const r = await api(c, 'GET', call(p));
          if (r.status < 400) wrong.push(`${who} read ${p}: ${r.status}`);
        }
      }
      // The candidate's media binding: only its own subject's media id, only in its own interview's call.
      const own = room.guest.guestId;
      for (const [who, c, pid] of [['the candidate with Hugo\'s media id', room.guest.context, `${SEED.cast.interviewer}-k3j2`], ['the candidate with another guest\'s', room.guest.context, 'guest:inv-00000000-0000-4000-8000-000000000000-k3j2'], ['a guest of another interview', guestOther, `${own}-k3j2`]]) {
        const r = await guestApi(c, 'POST', '/media/participant', { callId: room.callId, participantId: pid });
        if (r.status !== 404) wrong.push(`${who}: ${r.status}`);
      }
      record('E2c', wrong.length === 0, wrong.length ? wrong.join('; ') : `the lead reads Milo's state; 12 reads by three outsiders refused; three foreign media bindings refused`);
    } catch (e) {
      record('E2c', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally {
      for (const c of opened) await c.close().catch(() => undefined);
      if (room) await room.close();
    }
  }

  // ── E2d: the gate's answer to a guest and to no session ────────────────────────────────────────────────────────────
  await resetMock();
  {
    const opened = [];
    try {
      const recruiter = await signIn(SEED.cast.recruiter); opened.push(recruiter);
      const inv = await mintInvite(recruiter, MATEO);
      const g = await guestSession(inv.token); opened.push(g.context);
      const cookie = (await g.context.cookies()).find((c) => c.name === 'interviews.guest');
      const anon = await ctx.browser.newContext(); opened.push(anon);
      const inBrowser = await api(g.context, 'GET', '/api/interviews/interviews');
      const asAnon = await api(anon, 'GET', '/api/interviews/interviews');
      const byHand = await fetch(`${portal}/api/interviews/interviews`, { headers: { cookie: `interviews.guest=${cookie?.value ?? ''}` } });
      const work = await api(anon, 'GET', '/api/work/jobs');
      const ok = cookie?.path === '/api/interview-invite' && cookie.httpOnly === true && inBrowser.status === 403 && asAnon.status === 403 && byHand.status === 401;
      record('E2d', ok, `the guest cookie's path ${cookie?.path}, httpOnly ${cookie?.httpOnly}; a candidate's browser on the interviews list ${inBrowser.status} and no session ${asAnon.status} (the development mode's demo identity; the product says 401); the cookie by hand ${byHand.status}; no session on Work's list ${work.status} (dev mode only)`);
    } catch (e) {
      record('E2d', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
    } finally { for (const c of opened) await c.close().catch(() => undefined); }
  }
  await sleep(0);
}
