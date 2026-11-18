// Piece I4.6: the pad's language menu with the starter code, and a run on the configured run backend (docs/interviews-tenant-plan.md
// rows I4.2 and I4.6, decision 11). Both sides are IN the call (h8-room.mjs); the lead chooses Two Sum in Prepare first.
//   I4.6a  the lead leaves the pad on Java; the candidate picks Python from the same menu; both read Python, and the pad log
//          records the switch as the candidate's
//   I4.6b  the lead inserts Two Sum: the Python starter arrives on both sides (the starter of the shared language)
//   I4.6c  only with INTERVIEWS_RUN_BACKEND=docker in the walk's environment (the middleware it starts reads it): the candidate
//          completes the function and runs it; both panes show the output the code computed ([0, 1] and [1, 2]), and the
//          product's own run container started (docker events, label interviews.run=1). Without it the step is not recorded:
//          the mock runner prints literal values only, so it cannot show a computed result.
import { execFileSync } from 'node:child_process';
import { chooseLanguage, staffRoom, joinCall, guestRoom, synced, padText, outputText, until, why } from './h8-room.mjs';

const TWO_SUM = 'q-be-twosum';
const BODY = '\n    seen = {}\n    for i, n in enumerate(nums):\n        if target - n in seen:\n            return [seen[target - n], i]\n        seen[n] = i\n    return []\n';
const docker = (process.env.INTERVIEWS_RUN_BACKEND ?? '').trim().toLowerCase() === 'docker';

const pad = (page) => page.getByTestId('interview-pad').first();
const languageOf = (page) => pad(page).getByTestId('interview-pad-language').first()
  .evaluate((e) => {
    // The library's Select is a combobox button carrying its value in data-value; its native form is a <select>.
    if (e instanceof HTMLSelectElement) return e.value || null;
    return e.getAttribute('data-value') || null;
  }).catch(() => null);

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, api } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const iv = SEED.guestInterview;
  const names = ['I4.6a', 'I4.6b', ...(docker ? ['I4.6c'] : [])];

  await resetMock();
  let L = null; let G = null;
  try {
    L = await staffRoom(ctx, 'interviewer', iv); open.push(L.context);
    const row = (await api(L.context, 'GET', `/api/interviews/interviews/${iv}`)).body?.interview;
    const prep = await api(L.context, 'PUT', `/api/interviews/interviews/${iv}/questions`, { revision: row?.revision, questionIds: [TWO_SUM] });
    if (prep.status !== 200) throw new Error(`Prepare answered ${prep.status}`);
    const s = await startInterview(L.context, iv);
    if (s.status !== 200) throw new Error(`start answered ${s.status}`);
    await L.page.reload({ waitUntil: 'domcontentloaded' });
    await L.page.getByTestId('interview-room').first().waitFor({ timeout: 30_000 });
    await joinCall(L.page);
    G = await guestRoom(ctx, iv, L.context); open.push(G.context);
    if (!((await synced(L.page)) && (await synced(G.page)))) throw new Error('the pads did not come into sync');
  } catch (e) {
    for (const n of names) record(n, false, `the two could not meet in the call: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }

  await step('I4.6a', async () => {
    await chooseLanguage(L.page, 'Java');
    await until(async () => ((await languageOf(G.page)) === 'java' ? true : null), 8000);
    await chooseLanguage(G.page, 'Python');
    const both = await until(async () => ((await languageOf(L.page)) === 'python' && (await languageOf(G.page)) === 'python' ? true : null), 10_000);
    const log = await until(async () => {
      const r = await api(L.context, 'GET', `/api/interviews/interviews/${iv}/pad/log`);
      const ev = (r.body?.events ?? []).filter((e) => e.kind === 'language');
      return ev.some((e) => e.language === 'python' && e.who?.side === 'candidate') ? ev : null;
    }, 15_000, 1000);
    return { ok: !!both && !!log, detail: `both read Python=${!!both} (lead ${await languageOf(L.page)}, candidate ${await languageOf(G.page)}); the pad log's language events ${JSON.stringify((log ?? []).map((e) => `${e.who?.side}:${e.language}`))}` };
  });

  await step('I4.6b', async () => {
    await L.page.getByTestId('interview-pad-insert').click({ timeout: 8000 });
    await L.page.getByRole('menuitem').first().click({ timeout: 5000 });
    const lead = await until(async () => (((await padText(L.page)) ?? '').includes('def two_sum(') ? true : null), 10_000);
    const cand = await until(async () => (((await padText(G.page)) ?? '').includes('def two_sum(') ? true : null), 10_000);
    return { ok: !!lead && !!cand && (await languageOf(G.page)) === 'python', detail: `the Python starter on the lead's pad=${!!lead}, the candidate's=${!!cand}; language ${await languageOf(G.page)}` };
  });

  if (docker) {
    await step('I4.6c', async () => {
      // The starter's body is `pass`: the candidate replaces the whole document with a complete answer and its two cases.
      const text = (await padText(G.page)) ?? '';
      const head = text.slice(0, text.indexOf('def two_sum('));
      const code = `def two_sum(nums, target):${BODY}\n\nprint(two_sum([2, 7, 11, 15], 9))\nprint(two_sum([3, 2, 4], 6))\n`;
      await pad(G.page).locator('.cm-content').click();
      await G.page.keyboard.press('ControlOrMeta+A');
      await G.page.keyboard.insertText(`${head}${code}`);
      const since = Math.floor(Date.now() / 1000) - 1;
      await G.page.getByTestId('interview-pad-run').click();
      const want = /\[0, 1\]\s*\[1, 2\]/;
      const candOut = await until(async () => { const t = await outputText(G.page); return want.test(t) && /Finished/i.test(t) ? t : null; }, 60_000, 500);
      const leadOut = await until(async () => { const t = await outputText(L.page); return want.test(t) ? t : null; }, 20_000, 500);
      await new Promise((r) => setTimeout(r, 2000));
      const started = execFileSync('docker', ['events', '--since', String(since), '--until', String(Math.floor(Date.now() / 1000)), '--filter', 'label=interviews.run=1', '--filter', 'event=start', '--format', '{{.Actor.Attributes.name}}'], { timeout: 15_000 })
        .toString().split('\n').filter((n) => /^iv-run-[0-9a-f]{16}$/.test(n)).length;
      return { ok: !!candOut && !!leadOut && started >= 1, detail: `candidate "${(candOut ?? await outputText(G.page)).slice(0, 100)}"; the lead sees it=${!!leadOut}; run containers started ${started}` };
    });
  } else {
    console.log('I4.6c not run: start the walk with INTERVIEWS_RUN_BACKEND=docker to run code for real');
  }

  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
