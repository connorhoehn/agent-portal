// Piece I3.2: Milo's policy in an interview call (docs/interviews-tenant-plan.md row I3.2, decisions 4, 9, 20; lib/interviews/
// milo-policy.ts). The calls run on the stand-in media of h3-call.mjs; the lines come from the mock injector.
//   I3.2a  the lead (Hugo, Mateo's design round) invites Milo from the call bar: Milo listens in the interview's lobby
//   I3.2b  a panel member's invite (Hugo on Nadia's leadership round, which Wen leads) gets the lead-only sentence
//   I3.2c  after the end, the recruiter and the hiring manager read the call's transcript (the meeting record's)
//   I3.2d  another round's interviewer (Wen, no seat on Mateo's round) gets not-found on that call's record
//   I3.2e  a Work session (Theo) on the interview's call record gets not-found; the reverse, an interviews session (Greta) on a
//          Work call's record, gets not-found
//   I3.2f  the candidate's guest cookie on that call's assistant routes is refused (the statuses today: not-found)
//   I3.2g  the candidate's browser on the meetings list gets the anonymous caller's answer and nothing of the interview
import { liveRoom, inject, sleep, stubCallMedia, joinRoomCall, seen } from './h3-call.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, api, portal, signIn, endInterview } = ctx;
  const HUGO = SEED.cast.interviewer; const WEN = SEED.cast.interviewer2;
  const LEAD_ONLY = 'Only the lead interviewer of this interview can invite Milo, turn its voice on or add time.';
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const assistant = (callId, p) => `/api/calls/${encodeURIComponent(callId)}/assistant/${p}`;

  await resetMock();
  const iv = SEED.interviews.mateoDesign;
  let room = null;
  try {
    room = await liveRoom(ctx, { interviewId: iv, leadId: HUGO });
  } catch (e) {
    for (const s of ['a', 'c', 'd', 'e', 'f', 'g']) record(`I3.2${s}`, false, `the live room did not open: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
  if (room) {
    const LINE = 'Walk me through how you would shard the payments ledger.';
    await step('I3.2a', async () => {
      const st = await api(room.lead, 'GET', assistant(room.callId, 'state'));
      const inj = await inject(ctx, room.callId, [{ userId: HUGO, text: LINE }]);
      const mark = await room.leadPage.getByTestId('assistant-status-mark').first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      const ok = st.status === 200 && st.body?.state === 'listening' && st.body?.lobby === `interviews:interview:${iv}` && st.body?.invitedBy === HUGO && inj.listeners >= 1 && mark;
      return { ok, detail: `state ${st.status} ${st.body?.state} in ${st.body?.lobby}, invited by ${st.body?.invitedBy}; Milo's mark on the bar ${mark}; listeners ${inj.listeners}` };
    });

    await step('I3.2f', async () => {
      const got = [];
      for (const p of ['state', 'transcript', 'minutes']) got.push(`${p} ${(await api(room.guest.context, 'GET', assistant(room.callId, p))).status}`);
      got.push(`invite ${(await api(room.guest.context, 'POST', assistant(room.callId, 'invite'), {})).status}`);
      got.push(`extend ${(await api(room.guest.context, 'POST', assistant(room.callId, 'extend'), {})).status}`);
      const refused = got.every((g) => /\b(401|403|404)$/.test(g));
      return { ok: refused, detail: `the candidate's cookie on the call's assistant routes: ${got.join(', ')} (the build notes said 401; the call's tenant check answers not-found first)` };
    });

    // The meetings list. The guest cookie is scoped to /api/interview-invite, so the candidate's browser sends nothing here and is the
    // same caller as any anonymous browser: in production a 401 (meeting-assistant-interviews.test.ts pins it), in the mock world the
    // demo identity (a Work person), which lists only that identity's meetings. Decision (W2P): not a guest leak, nothing to refuse
    // by the guest; the step holds that the candidate's browser gets exactly the anonymous answer and nothing of the interview.
    await step('I3.2g', async () => {
      const meetings = await api(room.guest.context, 'GET', '/api/meetings');
      const anonCtx = await ctx.browser.newContext();
      try {
        const anon = await api(anonCtx, 'GET', '/api/meetings');
        const body = JSON.stringify(meetings.body ?? null);
        const same = meetings.status === anon.status && body === JSON.stringify(anon.body ?? null);
        const leaks = body.includes(room.callId) || body.includes(iv) || /interviews:interview:/.test(body);
        return { ok: same && !leaks, detail: `the candidate's browser on GET /api/meetings: ${meetings.status} ${body.slice(0, 80)}; an anonymous browser: ${anon.status}; the same answer ${same}; the interview in it ${leaks}` };
      } finally { await anonCtx.close(); }
    });

    await step('I3.2d', async () => {
      const wen = await signIn(WEN);
      try {
        const got = []; let why = '';
        for (const p of ['state', 'transcript', 'minutes']) { const r = await api(wen, 'GET', assistant(room.callId, p)); got.push(r.status); if (r.status !== 404 && !why) why = `${p}: "${r.body?.error ?? ''}"`; }
        return { ok: got.every((s) => s === 404), detail: `Wen (no seat) on the call's state, transcript, minutes: ${got.join(', ')}${why ? ` (${why}; the tenant's rule is not-found)` : ''}` };
      } finally { await wen.close(); }
    });

    await step('I3.2c', async () => {
      const e = await endInterview(room.lead, iv);
      await sleep(3000);
      const amara = await signIn(SEED.cast.hiringManager);
      try {
        const r = await api(room.recruiter, 'GET', assistant(room.callId, 'transcript'));
        const h = await api(amara, 'GET', assistant(room.callId, 'transcript'));
        const has = (x) => JSON.stringify(x.body ?? '').includes(LINE);
        const ok = e.status === 200 && r.status === 200 && has(r) && h.status === 200 && has(h);
        return { ok, detail: `end ${e.status}; recruiter ${r.status} (the line ${has(r)}), hiring manager ${h.status} (the line ${has(h)})` };
      } finally { await amara.close(); }
    });

    await step('I3.2e', async () => {
      const theo = await signIn(SEED.cast.workOnly);
      try {
        await api(theo, 'POST', '/api/session/role', { tenant: 'orgiq', role: 'member' });
        const onInterview = (await api(theo, 'GET', assistant(room.callId, 'state'))).status;
        const onInterviewT = (await api(theo, 'GET', assistant(room.callId, 'transcript'))).status;
        // The reverse: Theo starts a Work call on an initiative; Greta (the interviews tenant) asks for its record.
        await stubCallMedia(theo, 'work');
        const page = await theo.newPage();
        let workCall = null;
        page.on('request', (rq) => { const m = /\/api\/calls\/([^/?]+)\//.exec(new URL(rq.url()).pathname); if (m && !workCall) workCall = decodeURIComponent(m[1]); });
        await page.goto(`${portal}/iq/projects/p-observability`, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('initiative-start-call').click({ timeout: 30_000 });
        await seen(page, 'shell-call-dock');
        const end = Date.now() + 15_000;
        while (!workCall && Date.now() < end) await sleep(250);
        if (!workCall) return { ok: false, detail: `Theo on the interview's record ${onInterview}/${onInterviewT}; the Work call did not start` };
        const mine = (await api(theo, 'GET', assistant(workCall, 'state'))).status;
        const greta = (await api(room.recruiter, 'GET', assistant(workCall, 'state'))).status;
        const ok = onInterview === 404 && onInterviewT === 404 && greta === 404;
        return { ok, detail: `Theo (Work) on the interview's call: state ${onInterview}, transcript ${onInterviewT}; Greta (interviews) on Theo's Work call: ${greta} (Theo's own read ${mine})` };
      } finally { await theo.close(); }
    });
    await room.close();
  }

  // A panel member asks to invite Milo: the lead-only sentence.
  await resetMock();
  await step('I3.2b', async () => {
    const nadia = SEED.panelInterview;
    const panelSeat = { userId: HUGO, label: 'panel' };
    const r = await liveRoom(ctx, { interviewId: nadia, leadId: WEN, answers: null, invite: false, extra: [panelSeat] });
    try {
      const a = await api(panelSeat.context, 'POST', assistant(r.callId, 'invite'), {});
      let ui = 'no Invite on the panel bar';
      const btn = panelSeat.page.getByTestId('assistant-invite');
      if (await btn.count()) {
        await btn.first().click();
        ui = (await panelSeat.page.getByTestId('assistant-error-text').first().innerText({ timeout: 10_000 }).catch(() => '')).trim() || 'no line';
      }
      const st = await api(r.lead, 'GET', assistant(r.callId, 'state'));
      const ok = a.status === 403 && a.body?.error === LEAD_ONLY && (ui === 'no Invite on the panel bar' || ui.includes(LEAD_ONLY)) && st.body?.state !== 'listening';
      return { ok, detail: `the panel's invite ${a.status} "${a.body?.error ?? ''}"; on the bar: "${ui.slice(0, 90)}"; Milo ${st.body?.state ?? st.status}` };
    } finally { await r.close(); }
  });
}
