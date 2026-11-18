// Piece I4.7: the call lost under a live interview (audit of the slept take). Both sides are IN the call (h8-room.mjs); then both
// browsers lose the network at once, as a machine that sleeps does. The call service ends a call whose last participant dropped, so
// when the browsers come back their call is gone while the interview is still live. Every socket of both browsers runs through a
// pass-through route (Playwright's routeWebSocket), so the piece can hang them all up at once, as the sleep did; the browsers then
// reconnect on their own, through the same route.
//   I4.7a  the lead's room says the call dropped (interview-room-call-lost) and offers the restart; the candidate's page says the
//          call dropped (join-room-call-lost); neither keeps the dead call's clock
//   I4.7b  the lead restarts the call: the same interview record is live, and the candidate is back in the call without acting
import { staffRoom, joinCall, guestRoom, synced, until, why } from './h8-room.mjs';

// While `asleep`, a socket the browsers open again is refused at once: the machine is not on the network yet.
const sockets = [];
let asleep = false;
const passThrough = (context) => context.routeWebSocket(/.*/, (ws) => {
  if (asleep) { void ws.close({ code: 1006 }).catch(() => undefined); return; }
  sockets.push({ ws, server: ws.connectToServer(), url: new URL(ws.url()).pathname });
});
const SLEEP_MS = 20_000;
const sleepAll = async () => {
  asleep = true;
  const cut = sockets.splice(0);
  for (const { ws, server } of cut) { await server.close().catch(() => undefined); await ws.close().catch(() => undefined); }
  await new Promise((r) => setTimeout(r, SLEEP_MS));
  asleep = false;
  return cut.map((s) => s.url);
};
const shown = (page, id) => page.getByTestId(id).first().isVisible().catch(() => false);
const inCall = (page) => page.getByTestId('shell-call-dock').first().isVisible().catch(() => false);

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, api } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const iv = SEED.guestInterview;

  await resetMock();
  let L = null; let G = null;
  try {
    L = await staffRoom(ctx, 'interviewer', iv); open.push(L.context);
    const s = await startInterview(L.context, iv);
    if (s.status !== 200) throw new Error(`start answered ${s.status}`);
    await passThrough(L.context);
    await L.page.reload({ waitUntil: 'domcontentloaded' });
    await L.page.getByTestId('interview-room').first().waitFor({ timeout: 30_000 });
    await joinCall(L.page);
    G = await guestRoom(ctx, iv, L.context, { prepare: passThrough }); open.push(G.context);
    if (!((await synced(L.page)) && (await synced(G.page)))) throw new Error('the pads did not come into sync');
  } catch (e) {
    for (const n of ['I4.7a', 'I4.7b']) record(n, false, `the two could not meet in the call: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }

  await step('I4.7a', async () => {
    const cut = await sleepAll();
    const lead = await until(async () => ((await shown(L.page, 'interview-room-call-lost')) ? true : null), 45_000, 500);
    const restart = lead ? await shown(L.page, 'interview-room-restart-call') : false;
    const cand = await until(async () => ((await shown(G.page, 'join-room-call-lost')) ? true : null), 30_000, 500);
    const leadInCall = await inCall(L.page);
    if (process.env.I47_DEBUG_DIR) { await L.page.screenshot({ path: `${process.env.I47_DEBUG_DIR}/lead.png` }); await G.page.screenshot({ path: `${process.env.I47_DEBUG_DIR}/cand.png` }); }
    const row = (await api(L.context, 'GET', `/api/interviews/interviews/${iv}`)).body?.interview;
    return { ok: !!lead && restart && !!cand && !leadInCall && row?.state === 'live',
      detail: `sockets hung up ${JSON.stringify(cut)} for ${SLEEP_MS / 1000} s; the lead reads the call lost=${!!lead} with Restart=${restart}; the candidate reads it=${!!cand}; the lead still holds the call=${leadInCall}; the interview ${row?.state}` };
  });

  await step('I4.7b', async () => {
    await L.page.getByTestId('interview-room-restart-call').click({ timeout: 8000 });
    const lead = await until(async () => ((await inCall(L.page)) ? true : null), 30_000, 500);
    const cand = await until(async () => ((await shown(G.page, 'join-room-call-lost')) ? null : true), 45_000, 500);
    const candIn = cand ? await until(async () => ((await synced(G.page)) ? true : null), 20_000, 500) : null;
    const row = (await api(L.context, 'GET', `/api/interviews/interviews/${iv}`)).body?.interview;
    return { ok: !!lead && !!cand && !!candIn && row?.state === 'live',
      detail: `the lead is back in the call=${!!lead}; the candidate's lost notice gone=${!!cand}, back in the room=${!!candIn}; the interview ${row?.state} (same record ${iv})` };
  });

  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
