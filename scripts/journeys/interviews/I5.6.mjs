// Piece I5.6 (the "assigned" half is I1.4's walk and "starting soon" is here; the result bells are H4's I5.6-results piece):
// the bell a round rings shortly before it starts. It writes, so it puts the mock world back to its seeds first and last.
// The round is the seeded panel round (Wen leads, Hugo sits on the panel). The sweep is run by hand at the mock clock's time
// (clock.sweep('soon')); the server's own timer is every minute and does the same thing.
// INTERVIEWS_SOON_MINUTES cannot change on a running server, so the window is covered by a unit test on the rule
// (middleware/src/lib/interviews/__tests__/soon.test.ts, "the tick rings at the deployment's lead and says that number"), not here.
//   I5.6a  a time 14 minutes out, a sweep: the lead and the panel member get ONE bell each, naming the round and the opening, no candidate, no id
//   I5.6b  the bell opens My interviews
//   I5.6c  the same time swept again: no second bell
//   I5.6d  the time moved (13 minutes), swept: a second bell each; swept again: no third
//   I5.6e  a time outside the window, or a round that is not accepted or ready, rings nothing
const SOON = /starts in \d+ minutes/;

export default async function run({ portal, SEED, record, signIn, resetMock, setTime, clock, bells }) {
  await resetMock();
  const id = SEED.panelInterview;
  const greta = await signIn(SEED.cast.recruiter);
  const wen = await signIn(SEED.cast.interviewer2);
  const hugo = await signIn(SEED.cast.interviewer);
  const desk = async (ctx) => {
    const p = await ctx.newPage();
    await p.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('interviews-my-interviews').waitFor({ timeout: 30_000 });
    return p;
  };
  // The bell fills over the socket after the page opens: wait until `expected` lines show (up to 25 s), then look once more after
  // a pause so a line that should not be there has had its chance. expected 0 only waits and looks.
  const soonLines = async (ctx, expected = 0) => {
    const p = await desk(ctx);
    let lines = [];
    const end = Date.now() + 25_000;
    while (expected > 0 && lines.length < expected && Date.now() < end) {
      lines = (await bells(p, SOON, { ms: 2000 })).lines;
      if (lines.length < expected) await p.waitForTimeout(500);
    }
    lines = (await bells(p, SOON, { ms: 2500, absent: true })).lines;
    await p.close();
    return lines;
  };
  const clean = (lines) => lines.every((l) => !/Nadia|Rahman|cand-|nadia|iv-/.test(l));

  // ── I5.6a ──
  let first = null;
  try {
    const t = await clock.minutesFromNow(14);
    const set = await setTime(greta, id, t);
    const swept = await clock.sweep('soon');
    const w = await desk(wen); const h = await desk(hugo);
    const wl = (await bells(w, SOON, { ms: 20_000 })).lines;
    const hl = (await bells(h, SOON, { ms: 20_000 })).lines;
    first = { w, h, wl, hl };
    const ok = set.status === 200 && wl.length === 1 && hl.length === 1 && /for Engineering Manager/.test(wl[0]) && clean([...wl, ...hl]);
    record('I5.6a', ok, `time set (${set.status}), sweep ${JSON.stringify(swept)}; the lead's bell ${JSON.stringify(wl)}; the panel member's ${JSON.stringify(hl)}`);
  } catch (e) { record('I5.6a', false, `soon bells: ${e.message.split('\n')[0]}`); }

  // ── I5.6b ──
  try {
    const p = first.w;
    await p.goto(`${portal}/interviews/candidates`, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await p.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('interviews-my-interviews').waitFor({ timeout: 30_000 });
    const got = await bells(p, SOON, { ms: 20_000 });
    await got.panel.getByText(SOON).first().click();
    await p.waitForURL(/\/interviews\/my-interviews/, { timeout: 15_000 });
    const landed = new URL(p.url()).pathname;
    record('I5.6b', landed === '/interviews/my-interviews', `the bell opened ${landed}`);
  } catch (e) { record('I5.6b', false, `bell link: ${e.message.split('\n')[0]}`); }
  for (const p of [first?.w, first?.h]) await p?.close().catch(() => undefined);

  // ── I5.6c ──
  // The server's own counts are the proof of "once": the sweep says how many bells it rang. (Which old bells a page still lists
  // depends on what was read, so the pages are only asked for what must be there.)
  try {
    const s2 = await clock.sweep('soon');
    record('I5.6c', (s2?.sweep?.rang ?? -1) === 0, `swept again at the same time: ${JSON.stringify(s2?.sweep)} (no second ring for the lead or the panel member)`);
  } catch (e) { record('I5.6c', false, `second sweep: ${e.message.split('\n')[0]}`); }

  // ── I5.6d ──
  // A moved time is a new instant: it rings both again once; a repeat sweep rings nothing. The new time is ten minutes out so it
  // can never land on the minute the first one had (the clock keeps running while the walk reads bells).
  try {
    const set = await setTime(greta, id, await clock.minutesFromNow(10));
    const s3 = await clock.sweep('soon');
    const w = await soonLines(wen, 1); const h = await soonLines(hugo, 1);
    const s4 = await clock.sweep('soon');
    record('I5.6d', set.status === 200 && s3?.sweep?.rang === 2 && s4?.sweep?.rang === 0 && w.length >= 1 && h.length >= 1,
      `time moved (${set.status}): the sweep rang ${JSON.stringify(s3?.sweep)}; the lead's bells ${w.length}, the panel member's ${h.length}; swept again ${JSON.stringify(s4?.sweep)}`);
  } catch (e) { record('I5.6d', false, `moved time: ${e.message.split('\n')[0]}`); }

  // ── I5.6e ──
  try {
    await resetMock();
    await setTime(greta, id, await clock.minutesFromNow(60));
    await clock.sweep('soon');
    const far = [...await soonLines(wen), ...await soonLines(hugo)];
    await setTime(greta, id, null);
    await clock.sweep('soon');
    const cleared = [...await soonLines(wen), ...await soonLines(hugo)];
    record('I5.6e', far.length === 0 && cleared.length === 0, `a time 60 minutes out rang ${far.length}; a cleared time rang ${cleared.length}`);
  } catch (e) { record('I5.6e', false, `outside the window: ${e.message.split('\n')[0]}`); }

  for (const c of [greta, wen, hugo]) await c.close().catch(() => undefined);
  await resetMock();
}
