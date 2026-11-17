// Piece I4.3: the pad log (docs/interviews-tenant-plan.md row I4.3, decision 11). The candidate pastes into the pad in a
// live round (both IN the call: h8-room.mjs); the page's reporter posts it within a few seconds.
//   I4.3a  the panel's GET …/pad/log holds the candidate's paste with its size (characters and lines) and no text; no event
//          but a snapshot carries text
//   I4.3b  the candidate's page and reads hold no log: no paste line on the page, the guest has no log read (/pad/log is
//          not-found), and the guest's room read names no paste
//   I4.3c  after the end the record's code playback names the paste by its size ("Paste, N lines"), never as an
//          accusation; shots of the record at 1440 and 1280
import { staffRoom, joinCall, guestRoom, synced, typeInPad, pad, padText, until, why } from './h8-room.mjs';

const PASTED = 'def helper(items):\n    return sorted(items)\n';
const ACCUSE = /cheat|suspicious|copied from|plagiar|dishonest|flag(ged)? as/i;

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, endInterview, shootPage, api, guestApi, portal } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const iv = SEED.guestInterview;
  await resetMock();
  let L = null; let G = null;
  try {
    L = await staffRoom(ctx, 'interviewer', iv); open.push(L.context);
    const s = await startInterview(L.context, iv);
    if (s.status !== 200) throw new Error(`start answered ${s.status}`);
    await L.page.reload({ waitUntil: 'domcontentloaded' });
    await L.page.getByTestId('interview-room').first().waitFor({ timeout: 30_000 });
    await joinCall(L.page);
    G = await guestRoom(ctx, iv, L.context); open.push(G.context);
    if (!((await synced(L.page)) && (await synced(G.page)))) throw new Error('the pads did not come into sync');
  } catch (e) {
    for (const s of ['I4.3a', 'I4.3b', 'I4.3c']) record(s, false, `the two could not meet in the call: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }
  let paste = null;
  await step('I4.3a', async () => {
    await typeInPad(G.page, '# my answer\n');
    await pad(G.page).locator('.cm-content').evaluate((el, text) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PASTED);
    const landed = await until(async () => ((await padText(L.page)) ?? '').includes('return sorted(items)'), 8000);
    const log = await until(async () => {
      const r = await api(L.context, 'GET', `/api/interviews/interviews/${iv}/pad/log`);
      const p = (r.body?.events ?? []).find((e) => e.kind === 'paste' && e.who?.side === 'candidate');
      return p ? r.body : null;
    }, 20_000, 1000);
    if (!log) return { ok: false, detail: `no candidate paste in the panel's log within 20 s (the paste reached the lead's pad: ${!!landed})` };
    paste = log.events.find((e) => e.kind === 'paste' && e.who?.side === 'candidate');
    const textOutsideSnapshots = log.events.filter((e) => e.kind !== 'snapshot' && 'text' in e).length;
    const raw = JSON.stringify(log.events.filter((e) => e.kind !== 'snapshot'));
    const ok = paste.inserted === PASTED.length && paste.lines >= 2 && !('text' in paste) && textOutsideSnapshots === 0 && !raw.includes('sorted(items)') && paste.who.name === 'Candidate';
    return { ok, detail: `paste ${JSON.stringify({ inserted: paste.inserted, lines: paste.lines, via: paste.via, who: paste.who?.name })}; events with text outside a snapshot ${textOutsideSnapshots}` };
  });
  await step('I4.3b', async () => {
    const page = (await G.page.locator('body').innerText()).replace(/\s+/g, ' ');
    const logRead = await guestApi(G.context, 'GET', '/pad/log');
    const staffRead = await api(G.context, 'GET', `/api/interviews/interviews/${iv}/pad/log`);
    const room = JSON.stringify((await guestApi(G.context, 'GET', '/room')).body ?? {});
    const ok = !/Paste,/.test(page) && [404, 403].includes(logRead.status) && staffRead.status === 403 && !/paste/i.test(room);
    return { ok, detail: `the page names a paste ${/Paste,/.test(page)}; the guest's /pad/log ${logRead.status}; the panel's log read with the guest's cookie ${staffRead.status}; the room read names a paste ${/paste/i.test(room)}` };
  });
  await step('I4.3c', async () => {
    const e = await endInterview(L.context, iv);
    if (e.status !== 200) return { ok: false, detail: `end answered ${e.status}` };
    const page = await L.context.newPage();
    await page.goto(`${portal}/interviews/rounds/${iv}/record`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-record-code-playback').first().waitFor({ timeout: 30_000 });
    const want = paste ? new RegExp(`Paste, ${paste.lines} lines?`) : /Paste, \d+ (lines?|characters?)/;
    const html = await until(async () => { const h = await page.getByTestId('interviews-record-code').first().evaluate((el) => `${el.innerText}\n${[...el.querySelectorAll('[aria-label],[title]')].map((x) => `${x.getAttribute('aria-label') ?? ''} ${x.getAttribute('title') ?? ''}`).join('\n')}`); return want.test(h) ? h : null; }, 15_000)
      ?? await page.getByTestId('interviews-record-code').first().evaluate((el) => `${el.innerText}\n${[...el.querySelectorAll('[aria-label],[title]')].map((x) => `${x.getAttribute('aria-label') ?? ''} ${x.getAttribute('title') ?? ''}`).join('\n')}`).catch(() => '');
    await shootPage(page, 'I4.3-record');
    const named = want.test(html);
    const accuses = ACCUSE.test(html);
    const panelLog = await api(L.context, 'GET', `/api/interviews/interviews/${iv}/pad/log`);
    await page.close();
    return { ok: named && !accuses && panelLog.status === 200, detail: `the record names the paste by its size ${named} (${(html.match(/(Paste|Drop)[^\n]{0,30}/) ?? ['none'])[0]}); accusing words ${accuses}; the lead's log read after the end ${panelLog.status}` };
  });
  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
