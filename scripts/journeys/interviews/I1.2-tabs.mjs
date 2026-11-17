// Piece I1.2-tabs: the candidate profile's four tabs and the frame's rail, per role. Reads only.
//   I1.2j  the recruiter: four tabs; Recordings is counted and a finished round opens its record; a candidate with none reads one sentence
//   I1.2k  the recruiter's rail is everyone grouped by stage with a find box that narrows it
//   I1.2l  the hiring manager's rail holds no iOS candidate; an interviewer's frame has no rail
//   I1.2m  a not-found inside the frame shows no raw id in its trail
const TABS = ['rounds', 'resume', 'recordings', 'activity'];

export default async function run({ portal, SEED, record, signIn, api }) {
  const greta = await signIn(SEED.cast.recruiter);
  const amara = await signIn(SEED.cast.hiringManager);
  const hugo = await signIn(SEED.cast.interviewer);
  const profile = async (ctx, id) => {
    const p = await ctx.newPage();
    await p.goto(`${portal}/interviews/candidates/${id}`, { waitUntil: 'domcontentloaded' });
    await p.getByTestId('interviews-candidate-frame').waitFor({ timeout: 30_000 });
    return p;
  };
  const frameText = async (p) => (await p.getByTestId('interviews-candidate-frame').innerText()).replace(/\s+/g, ' ');
  const rows = (await api(greta, 'GET', '/api/interviews/candidates')).body?.items ?? [];
  const ios = rows.filter((r) => r.opening?.id === SEED.openings.ios).map((r) => r.candidate.name);
  const backend = rows.filter((r) => r.opening?.id === SEED.openings.backend).map((r) => r.candidate.name);

  try {
    const p = await profile(greta, SEED.candidates.ingrid);
    await p.getByTestId('interviews-candidate-profile').waitFor({ timeout: 30_000 });
    const present = [];
    for (const t of TABS) present.push(await p.getByTestId(`interviews-profile-tab-${t}`).count());
    const tabLabel = (await p.getByTestId('interviews-profile-tab-recordings').innerText()).replace(/\s+/g, ' ');
    await p.getByTestId('interviews-profile-tab-recordings').click();
    const shown = await p.getByTestId('interviews-profile-recordings').getByTestId('interviews-profile-recording-open').count();
    const counted = Number((tabLabel.match(/(\d+)/) || [])[1] ?? 0);
    let opened = '';
    if (shown) {
      await p.getByTestId('interviews-profile-recording-open').first().click();
      await p.waitForURL((u) => !/\/interviews\/candidates\/[^/]+$/.test(u.pathname), { timeout: 20_000 });
      opened = new URL(p.url()).pathname;
    }
    await p.close();
    const q = await profile(greta, SEED.candidates.lucia);
    await q.getByTestId('interviews-profile-tab-recordings').click();
    const none = (await q.getByTestId('interviews-profile-recordings-section').innerText()).replace(/\s+/g, ' ');
    await q.close();
    record('I1.2j', present.every((n) => n === 1) && shown > 0 && counted === shown && /record/i.test(opened) && none.length > 0 && !/\d{2,}\s*(rows|recordings)/.test(none),
      `tabs present ${JSON.stringify(present)}; Recordings reads ${JSON.stringify(tabLabel)} and lists ${shown}; a record opened ${opened}; a candidate with none reads ${JSON.stringify(none.slice(0, 140))}`);
  } catch (e) { record('I1.2j', false, `tabs: ${e.message.split('\n')[0]}`); }

  try {
    const p = await profile(greta, SEED.candidates.ingrid);
    const text = await frameText(p);
    const find = p.getByTestId('interviews-candidate-frame').getByRole('searchbox').or(p.getByTestId('interviews-candidate-frame').getByPlaceholder(/Find a candidate/i)).first();
    await find.fill('Ingrid');
    await p.waitForTimeout(500);
    const narrowed = await frameText(p);
    const everyone = [...backend, ...ios].every((n) => text.includes(n.split(' ')[0]));
    const stages = ['Applied', 'Screening', 'Interviewing'].filter((s) => text.includes(s)).length;
    await p.close();
    record('I1.2k', everyone && stages >= 2 && narrowed.includes('Ingrid') && !narrowed.includes(ios[0]?.split(' ')[0] ?? 'zzz'),
      `the recruiter's rail names everyone: ${everyone}; stage groups seen: ${stages}; after "Ingrid" the iOS candidate ${ios[0]} is ${narrowed.includes(ios[0]?.split(' ')[0] ?? 'zzz') ? 'still there' : 'gone'}`);
  } catch (e) { record('I1.2k', false, `recruiter rail: ${e.message.split('\n')[0]}`); }

  try {
    const p = await profile(amara, SEED.candidates.ingrid);
    const hm = await frameText(p);
    const seesIos = ios.some((n) => hm.includes(n));
    const seesBackend = backend.some((n) => hm.includes(n));
    await p.close();
    const q = await profile(hugo, SEED.candidates.mateo);
    const iv = await frameText(q);
    const find = await q.getByTestId('interviews-candidate-frame').getByPlaceholder(/Find a candidate/i).count();
    const others = [...backend, ...ios].filter((n) => !/Mateo/.test(n) && iv.includes(n));
    await q.close();
    record('I1.2l', !seesIos && seesBackend && find === 0 && others.length === 0, `the hiring manager's rail has an iOS candidate: ${seesIos} (and a backend one: ${seesBackend}); the interviewer's frame has a find box: ${find}, other candidates named: ${JSON.stringify(others)}`);
  } catch (e) { record('I1.2l', false, `other roles' rails: ${e.message.split('\n')[0]}`); }

  try {
    const out = [];
    for (const [who, ctx, id] of [['recruiter', greta, 'cand-nowhere'], ['hiring manager', amara, SEED.candidates.aiko], ['interviewer', hugo, SEED.candidates.aiko]]) {
      const p = await ctx.newPage();
      await p.goto(`${portal}/interviews/candidates/${id}`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(2500);
      const nav = (await p.locator('nav[aria-label*="readcrumb" i]').first().innerText().catch(() => '')).replace(/\s+/g, ' ');
      const body = (await p.locator('body').innerText()).replace(/\s+/g, ' ');
      out.push({ who, trail: nav.slice(-80), rawId: nav.includes(id) || /\bcand-[a-z]+\b/.test(nav), idOnPage: body.includes(id) });
      await p.close();
    }
    record('I1.2m', out.every((o) => !o.rawId && !o.idOnPage), JSON.stringify(out));
  } catch (e) { record('I1.2m', false, `not-found trail: ${e.message.split('\n')[0]}`); }

  for (const c of [greta, amara, hugo]) await c.close().catch(() => undefined);
}
