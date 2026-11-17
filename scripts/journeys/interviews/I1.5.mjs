// Piece I1.5: the time on a round, and Upcoming (row I1.5). It writes, so it puts the mock world back to its seeds first and again
// at the end. The round whose time moves is Aiko's coding round (ready, Wen leads); the live round is Kwame's (Hugo leads).
//   I1.5a  Upcoming at 1440 and 1280: every column, no sideways scroll, the table above the fold; the live row has Join and nothing to edit
//   I1.5b  the Set time strip: Cancel closes it; a time chosen and then Cancelled at the prompt changes nothing
//   I1.5c  a time chosen and confirmed is Saved, the round keeps its state, the lead is told; Clear the time clears it
//   I1.5d  a candidate who answered "no transcript" shows "No transcript, no Milo" in the State and consent column
const COLUMNS = ['Candidate', 'Opening and round', 'Lead and panel', 'State and consent', 'Time and invite link'];
const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default async function run({ portal, SEED, record, signIn, shoot, resetMock, api, mintInvite, guestSession, guestConsents, bells, readInterview }) {
  await resetMock();
  const aiko = SEED.interviews.aikoCoding;
  const greta = await signIn(SEED.cast.recruiter);
  const page = await greta.newPage();
  const row = (name) => page.getByTestId('interviews-upcoming-table').locator('tr', { hasText: name }).first();
  const open = async () => {
    await page.goto(`${portal}/interviews/upcoming`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-upcoming-table').getByText('Aiko Tanaka', { exact: true }).first().waitFor({ timeout: 30_000 });
  };
  const actions = async (name, item) => { await row(name).getByTestId('interviews-upcoming-actions').click(); await page.getByRole('menuitem', { name: item }).click(); };
  const future = (days, h, m) => { const d = new Date(Date.now() + days * 86_400_000); d.setHours(h, m, 0, 0); return d; };

  // ── I1.5a ──
  try {
    await open();
    const heads = (await page.getByTestId('interviews-upcoming-table').locator('thead th').allInnerTexts()).map((s) => s.trim()).filter(Boolean);
    const shots = await shoot(page, 'upcoming', 'interviews-upcoming-table');
    const clipped = await page.evaluate(() => {
      const t = document.querySelector('[data-testid="interviews-upcoming-table"]');
      return [t, ...t.querySelectorAll('*')].some((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowX) && e.scrollWidth > e.clientWidth + 1);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    const kwame = row('Kwame');
    const join = await kwame.getByTestId('interviews-upcoming-join').count();
    const menu = await kwame.getByTestId('interviews-upcoming-actions').count();
    const live = await kwame.getByTestId('interviews-upcoming-live').count();
    const inFive = new Date(Math.ceil((Date.now() + 5 * 86_400_000) / 60_000) * 60_000).toISOString();
    const refused = await api(greta, 'PUT', `/api/interviews/interviews/${SEED.interviews.kwameLive}/time`, { revision: (await readInterview(greta, SEED.interviews.kwameLive)).revision, scheduledAt: inFive });
    const ok = COLUMNS.every((c) => heads.some((h) => h.startsWith(c))) && !clipped && shots.every((s) => s.ok) && join === 1 && menu === 0 && live === 1 && refused.status === 400;
    record('I1.5a', ok, `columns ${JSON.stringify(heads)}; ${shots.map((s) => `@${s.width}: first row at ${s.firstRowTop}px${s.horizontalScroll ? ', scrolls sideways' : ''}`).join('; ')}${clipped ? '; the table scrolls inside itself at 1280' : '; every column fits at 1280'}; the live row has Join ${join}, an Actions menu ${menu}; a time written to it answers ${refused.status} "${(refused.body?.error ?? '').slice(0, 80)}"`);
  } catch (e) { record('I1.5a', false, `Upcoming: ${e.message.split('\n')[0]}`); }

  // ── I1.5b ──
  try {
    await open();
    const before = (await readInterview(greta, aiko)).scheduledAt;
    await actions('Aiko', /Change the time/);
    await page.getByTestId('interviews-upcoming-editor').waitFor({ timeout: 15_000 });
    await page.getByTestId('interviews-upcoming-editor').getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('interviews-upcoming-editor').waitFor({ state: 'detached', timeout: 15_000 });
    await actions('Aiko', /Change the time/);
    await page.getByTestId('interviews-upcoming-time-field-input').fill(localInput(future(4, 11, 15)));
    const deck = page.getByTestId('collection-command-composer-prompts');
    await deck.getByText(/Set the time to/).waitFor({ timeout: 15_000 });
    const asked = (await deck.innerText()).replace(/\s+/g, ' ');
    await deck.getByRole('button', { name: /Cancel/ }).click();
    await page.getByText('Kept. The time did not change.').first().waitFor({ timeout: 15_000 });
    const after = (await readInterview(greta, aiko)).scheduledAt;
    record('I1.5b', before === after && /The lead and the panel are told/.test(asked), `the strip's Cancel closed it; a chosen time was asked "${asked.slice(0, 110)}" and Cancel kept it (${before === after ? 'unchanged' : 'CHANGED'})`);
  } catch (e) { record('I1.5b', false, `strip: ${e.message.split('\n')[0]}`); }

  // ── I1.5c ──
  try {
    await open();
    const before = await readInterview(greta, aiko);
    const target = future(4, 11, 15);
    await actions('Aiko', /Change the time/);
    await page.getByTestId('interviews-upcoming-time-field-input').fill(localInput(target));
    const deck = page.getByTestId('collection-command-composer-prompts');
    await deck.getByText(/Set the time to/).waitFor({ timeout: 15_000 });
    await deck.getByRole('button', { name: /Confirm/ }).click();
    await row('Aiko').getByTestId('interviews-upcoming-saved').waitFor({ timeout: 30_000 });
    const saved = (await row('Aiko').getByTestId('interviews-upcoming-saved').innerText()).trim();
    const moved = await readInterview(greta, aiko);
    const wen = await signIn(SEED.cast.interviewer2);
    const wp = await wen.newPage();
    await wp.goto(`${portal}/interviews/my-interviews`, { waitUntil: 'domcontentloaded' });
    await wp.getByTestId('interviews-my-interviews').waitFor({ timeout: 30_000 });
    const got = await bells(wp, /new time/i);
    await wen.close();
    await actions('Aiko', /Clear the time/);
    await deck.getByText(/Clear the time\?/).waitFor({ timeout: 15_000 });
    await deck.getByRole('button', { name: /Confirm/ }).click();
    await page.getByText('The time was cleared.').first().waitFor({ timeout: 30_000 });
    const cleared = await readInterview(greta, aiko);
    const ok = /^Saved:/.test(saved) && Math.abs(Date.parse(moved.scheduledAt) - target.getTime()) < 60_000 && moved.state === before.state && got.lines.length > 0 && !/Aiko|Tanaka/.test(got.lines.join(' '))
      && cleared.scheduledAt === null;
    record('I1.5c', ok, `confirmed: "${saved}", the round stays ${moved.state}, the lead's bell ${JSON.stringify(got.lines.slice(0, 1))}; cleared: time ${cleared.scheduledAt}`);
  } catch (e) { record('I1.5c', false, `set and clear: ${e.message.split('\n')[0]}`); }

  // ── I1.5d ──
  try {
    await resetMock();
    const invite = await mintInvite(greta, aiko);
    const guest = await guestSession(invite.token);
    const c = await guestConsents(guest.context, { recording: true, transcription: false, milo: false });
    await guest.context.close();
    await open();
    const cell = (await row('Aiko').getByTestId('interviews-upcoming-consent').innerText()).trim();
    record('I1.5d', c.status === 200 && cell === 'No transcript, no Milo', `the candidate answered (${c.status}); the State and consent cell reads "${cell}"`);
  } catch (e) { record('I1.5d', false, `consent cell: ${e.message.split('\n')[0]}`); }

  await greta.close();
  await resetMock();
}
