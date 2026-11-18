// Piece I5.1-recording: a real interview call's recording plays on the record page (docs/interviews-tenant-plan.md rows I5.1
// and I2.6). Only when the walk's environment points the middleware it starts at a media stack: REALTIME_PLATFORM_PUBLIC_URL
// (a platform-api with the interview recording rules, its LOBBY_AUTHORITY_URL at this walk's middleware
// /api/realtime/lobby-access, and its LVS webhook subscription reachable from the media server) and REALTIME_VIDEO_PUBLIC_URL
// (that media server). Without them the step is not recorded: the mock world has no media server, so I5.1 judges the
// seeded stand-in instead.
//   I5.1r  the candidate answers yes to recording; the lead starts the call and admits them; the call runs ~20 s and the
//          lead ends the interview. platform-api lists the recording for the lead (asking this middleware each time), the
//          record read says a real recording may be there (no stand-in), and the record page asks platform-api, draws
//          the player and the video plays. The recording is deleted afterwards (as its owner, the lead).
// The candidate answers before the lead starts the call: platform-api decides whether a call records once, when the call
// is made, so a call the lead starts before the candidate's answers exist is not recorded (the plan's open list).
import { joinCall, until, why } from './h8-room.mjs';
import { PREJOIN_KEYS } from './lib.mjs';

const PLATFORM = (process.env.REALTIME_PLATFORM_PUBLIC_URL ?? '').trim().replace(/\/$/, '');
const VIDEO = (process.env.REALTIME_VIDEO_PUBLIC_URL ?? '').trim();
const HOLD_MS = 20_000;

export default async function run(ctx) {
  if (!PLATFORM || !VIDEO) return;
  const { SEED, portal, record, signIn, api, resetMock, mintInvite, openGuest, toWaiting, admit, endInterview, readInterview } = ctx;
  const iv = SEED.guestInterview;
  const lobby = `interviews:interview:${iv}`;
  const open = [];
  let recordingId = null; let bearer = null;
  const media = async (method, path) => {
    const r = await fetch(`${PLATFORM}${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await resetMock();
  try {
    // The candidate's answers come first (see the header).
    const greta = await signIn(SEED.cast.recruiter); open.push(greta);
    const inv = await mintInvite(greta, iv);
    if (inv.status !== 201) throw new Error(`the link was not made (${inv.status})`);
    const G = await openGuest(inv.linkPath); open.push(G.context);
    const door = await toWaiting(G.page);
    if (door !== 'waiting' && door !== 'room') throw new Error(`the candidate stopped at ${door}`);

    const lead = await signIn(SEED.cast.interviewer); open.push(lead);
    await lead.grantPermissions(['camera', 'microphone']);
    await lead.addInitScript(([k]) => { try { localStorage.setItem(k, JSON.stringify({ micOn: true, cameraOn: true, remember: true })); } catch { /* none */ } }, [PREJOIN_KEYS.panel]);
    const room = await lead.newPage();
    await room.goto(`${portal}/interviews/rounds/${iv}/room`, { waitUntil: 'domcontentloaded' });
    await room.getByTestId('interview-room').first().waitFor({ timeout: 60_000 });
    await joinCall(room);
    if (!(await until(async () => ((await readInterview(lead, iv))?.state === 'live' ? true : null), 30_000))) throw new Error('the interview did not go live');
    const a = await admit(lead, iv, true);
    if (a.status !== 200) throw new Error(`admit answered ${a.status}`);
    // The candidate's own join is best effort here: what this step judges is the lead's call being recorded and played.
    const join = G.page.getByTestId('join-room-bar-start').or(G.page.getByTestId('join-room-bar-join')).first();
    if (await join.waitFor({ timeout: 30_000 }).then(() => true, () => false)) await join.click({ timeout: 8000 }).catch(() => undefined);
    const lit = await until(async () => (await room.evaluate(() => [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0)).catch(() => false)) || null, 30_000);
    if (!lit) throw new Error('the lead\'s own camera never showed in the call');
    await room.waitForTimeout(HOLD_MS);
    const end = await endInterview(lead, iv);
    if (end.status !== 200) throw new Error(`end answered ${end.status}`);
    await room.close();
    await G.context.close(); open.splice(open.indexOf(G.context), 1);

    // platform-api's own answer, as the lead: the lobby's recording, and its video once saved.
    bearer = (await api(lead, 'GET', '/api/session/realtime-token')).body?.token;
    if (!bearer) throw new Error('no realtime token for the lead');
    let listed = null; let playback = null;
    await until(async () => {
      listed = await media('GET', `/api/recordings?${new URLSearchParams({ lobbyName: lobby, limit: '10' })}`);
      const row = (listed.body?.items ?? []).find((r) => r.lobbyName === lobby);
      if (!row) return null;
      recordingId = row.recordingId;
      playback = await media('POST', `/api/recordings/${encodeURIComponent(row.recordingId)}/playback-token`);
      return playback.body?.mediaState === 'playable' ? true : null;
    }, 180_000, 3000);
    const view = (await api(lead, 'GET', `/api/interviews/interviews/${iv}/record`)).body?.record?.recording ?? null;

    // The record page: it asks platform-api, draws the player, and the video plays.
    const page = await lead.newPage();
    const asked = [];
    page.on('response', (r) => { if (r.url().startsWith(PLATFORM)) asked.push(`${r.request().method()} ${new URL(r.url()).pathname.replace(/\/recordings\/[^/]+/, '/recordings/:id')} ${r.status()}`); });
    await page.goto(`${portal}/interviews/rounds/${iv}/record`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-record-recording').first().waitFor({ timeout: 45_000 });
    const video = page.getByTestId('interviews-record-recording').locator('video').first();
    const drawn = await video.waitFor({ timeout: 45_000 }).then(() => true, () => false);
    const played = drawn ? await video.evaluate(async (v) => {
      v.muted = true;
      await v.play().catch(() => undefined);
      const t0 = Date.now();
      while (Date.now() - t0 < 8000 && !(v.readyState >= 2 && v.currentTime > 0.5)) await new Promise((r) => setTimeout(r, 250));
      return { readyState: v.readyState, at: Math.round(v.currentTime * 10) / 10, duration: Math.round(v.duration) };
    }).catch(() => null) : null;
    const line = drawn ? '' : (await page.getByTestId('interviews-record-recording-line').first().innerText().catch(() => '')).trim();
    const ok = playback?.body?.mediaState === 'playable' && view?.state === 'available' && view?.standIn === false
      && asked.some((s) => /^GET \/api\/recordings 200$/.test(s)) && asked.some((s) => /playback-token 200$/.test(s))
      && !!played && played.readyState >= 2 && played.at > 0;
    record('I5.1r', ok, `platform-api lists ${(listed?.body?.items ?? []).length} recording(s) for the lead (${listed?.status}), video ${playback?.body?.mediaState ?? 'never'}; `
      + `the record read: ${JSON.stringify(view)}; the page asked ${JSON.stringify(asked)}; `
      + (drawn ? `the player played to ${played?.at}s of ${played?.duration}s (readyState ${played?.readyState})` : `no player; the page says "${line}"`));
  } catch (e) {
    record('I5.1r', false, why(e));
  } finally {
    if (recordingId && bearer) {
      const d = await media('DELETE', `/api/recordings/${encodeURIComponent(recordingId)}`).catch((e) => ({ status: why(e) }));
      if (d.status !== 200 && d.status !== 204) console.log(`I5.1r: the walk's recording ${recordingId} was not deleted (${d.status}); delete it by hand`);
    }
    for (const c of open) await c.close().catch(() => undefined);
  }
}
