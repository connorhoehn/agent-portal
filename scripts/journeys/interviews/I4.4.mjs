// Piece I4.4: runs on the mock executor (docs/interviews-tenant-plan.md rows I4.4 and I4.5, decisions 13 and 19). Every run
// here goes to the mock executor (the stack's default); nothing a person types is executed. Both sides are IN the call
// (h8-room.mjs).
//   I4.4a  the row's judge line: the lead presses Run and both output panes show the same run (its status, then its output);
//          the lead reads "Run by you" and the candidate "Interviewer"
//   I4.4b  the candidate presses Run: the panel reads "Candidate", the candidate reads "Run by you"; neither the candidate's
//          pane nor the guest's run reads hold a panel member's name; shots of both at 1440 and 1280
//   I4.4c  each result from the mock's markers, on both panes: a failure with its exit code, a compile error, a timeout,
//          memory, a flooded stream cut, an internal error
//   I4.4d  Cancel from the other side: the lead starts a run that would time out, the candidate presses Cancel, both read
//          Cancelled
//   I4.5a  after a failing run, with Milo in the call and lines heard, the lead's next suggestion arrives on the scripted
//          stand-in; its words and its quote are nowhere on the candidate's page or in the guest's reads. The stand-in
//          quotes the last candidate line and never the code (coach/model.ts `scriptedSuggestion`): whether the quote is a
//          line of the pad or the output is written in the detail, not judged (the pinned request is code.test.ts's)
//   I4.4e  an opening with no cap (cleared through the opening editor's route as the recruiter; resetMock restores it): the
//          lead reads the cap sentence, the candidate reads a sentence with nothing about money, and no run is stored
import { chooseLanguage, staffRoom, joinCall, guestRoom, synced, typeInPad, padText, outputText, until, why, inviteMilo, hear, suggestion } from './h8-room.mjs';

const MONEY = /\$|cap\b|spend|budget|cost|money|pay|dollar/i;

export default async function run(ctx) {
  const { SEED, record, resetMock, startInterview, shootPage, api, guestApi } = ctx;
  const open = [];
  const step = async (name, fn) => { try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, why(e)); } };
  const lead = SEED.cast.interviewer;
  const leadName = SEED.names[lead];
  const iv = SEED.guestInterview;
  const base = `/api/interviews/interviews/${iv}/runs`;
  let n = 0;
  const runId = () => `h8-${Date.now().toString(36)}-${(n += 1)}`;
  const files = (content, lang = 'python') => (lang === 'swift'
    ? { language: 'swift', entrypoint: 'main.swift', files: [{ path: 'main.swift', content }] }
    : { language: 'python', entrypoint: 'main.py', files: [{ path: 'main.py', content }] });
  const runOf = async (id) => (await api(L.context, 'GET', `${base}/${id}`)).body?.run ?? null;
  const settled = async (id, ms = 25_000) => until(async () => { const r = await runOf(id); return r && !['queued', 'compiling', 'running'].includes(r.status) ? r : null; }, ms, 500);

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
    for (const s of ['I4.4a', 'I4.4b', 'I4.4c', 'I4.4d', 'I4.5a', 'I4.4e']) record(s, false, `the two could not meet in the call: ${why(e)}`);
    for (const c of open) await c.close().catch(() => undefined);
    await resetMock();
    return;
  }

  await step('I4.4a', async () => {
    // The pad's language outlives a reset (an earlier piece in the same run may have chosen one): choose it, then type its print.
    await chooseLanguage(L.page, 'JavaScript');
    await L.page.waitForTimeout(800);
    await typeInPad(L.page, '\nconsole.log("hello from the lead")');
    // Run reads the pad as the gateway holds it: wait until the candidate's pad shows the typed line, then press Run.
    await until(async () => /hello from the lead/.test(await padText(G.page)), 10_000);
    await L.page.waitForTimeout(800);
    await L.page.getByTestId('interview-pad-run').click();
    const lo = await until(async () => { const t = await outputText(L.page); return /hello from the lead/.test(t) && /Finished/.test(t) ? t : null; }, 20_000);
    const go = await until(async () => { const t = await outputText(G.page); return /hello from the lead/.test(t) && /Finished/.test(t) ? t : null; }, 20_000);
    const ok = !!lo && !!go && /Run by you/.test(lo) && /Interviewer/.test(go) && !go.includes(leadName);
    const typed = ok ? '' : ` [the pad holds ${JSON.stringify((await padText(L.page)).slice(-120))}]`;
    return { ok, detail: `the lead's pane "${(lo ?? await outputText(L.page)).slice(0, 140)}"${typed}; the candidate's "${(go ?? await outputText(G.page)).slice(0, 140)}"` };
  });

  await step('I4.4b', async () => {
    const before = ((await api(L.context, 'GET', base)).body?.runs ?? []).length;
    await G.page.getByTestId('interview-pad-run').click();
    const newer = await until(async () => { const r = (await api(L.context, 'GET', base)).body?.runs ?? []; return r.length > before ? r[0] : null; }, 15_000);
    const id = newer?.runId;
    if (id) await settled(id);
    const lo = await until(async () => { const t = await outputText(L.page); return /Candidate/.test(t) ? t : null; }, 15_000) ?? await outputText(L.page);
    const go = await until(async () => { const t = await outputText(G.page); return /Run by you/.test(t) ? t : null; }, 15_000) ?? await outputText(G.page);
    const guestRuns = JSON.stringify((await guestApi(G.context, 'GET', '/runs')).body ?? {});
    const leak = [leadName, SEED.names[SEED.cast.interviewer2], lead].filter((x) => go.includes(x) || guestRuns.includes(x));
    await shootPage(L.page, 'I4.4-lead-run');
    await shootPage(G.page, 'I4.4-candidate-run');
    const ok = newer?.startedBy?.side === 'candidate' && /Candidate/.test(lo) && /Run by you/.test(go) && leak.length === 0;
    return { ok, detail: `started by ${JSON.stringify(newer?.startedBy ?? null)}; the panel's pane "${lo.slice(0, 100)}"; the candidate's "${go.slice(0, 100)}"${leak.length ? `; the candidate reads ${JSON.stringify(leak)}` : ''}` };
  });

  await step('I4.4c', async () => {
    const cases = [
      { marker: 'fail', status: 'failed', pane: /Failed/, also: /Exit code\s*[1-9]/ },
      // An interpreted language has no compile step: the mock fails a Python run with a syntax error (status failed).
      { marker: 'compile-error', status: 'failed', pane: /Failed/, also: /./ },
      { marker: 'compile-error', status: 'compile_error', pane: /Didn.t compile|Failed/, also: /./, lang: 'swift' },
      { marker: 'timeout', status: 'timed_out', pane: /Timed out/, also: /./ },
      { marker: 'memory', status: 'memory_exceeded', pane: /Out of memory/, also: /./ },
      { marker: 'flood', status: 'succeeded', pane: /Finished/, also: /Cut at the output limit/ },
      { marker: 'internal', status: 'internal_error', pane: /Couldn.t run/, also: /./ },
    ];
    const seen = [];
    let ok = true;
    for (const c of cases) {
      const id = runId();
      const r = await api(L.context, 'POST', base, { runId: id, ...files(c.lang === 'swift' ? `print("case ${c.marker}")\n// mock:${c.marker}\n` : `print("case ${c.marker}")\n# mock:${c.marker}\n`, c.lang) });
      if (r.status !== 202) { ok = false; seen.push(`${c.marker}: start ${r.status}`); continue; }
      const done = await settled(id, 30_000);
      const both = await until(async () => {
        const [a, b] = [await outputText(L.page), await outputText(G.page)];
        return c.pane.test(a) && c.pane.test(b) && c.also.test(a) && c.also.test(b) ? true : null;
      }, 10_000);
      const good = done?.status === c.status && !!both;
      if (c.marker === 'flood') { const t = done?.result?.truncated; if (!(t?.stdout || t?.stderr)) ok = false; }
      ok = ok && good;
      seen.push(`${c.marker}: ${done?.status ?? 'no end'}${good ? '' : ` (panes: "${(await outputText(L.page)).slice(0, 60)}" / "${(await outputText(G.page)).slice(0, 60)}")`}`);
    }
    return { ok, detail: seen.join('; ') };
  });

  await step('I4.4d', async () => {
    const id = runId();
    const r = await api(L.context, 'POST', base, { runId: id, ...files('print("waiting")\n# mock:timeout\n') });
    if (r.status !== 202) return { ok: false, detail: `start ${r.status}` };
    const cancel = G.page.getByTestId('interview-pad-cancel').first();
    const shown = await cancel.waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (shown) await cancel.click();
    const done = await settled(id, 20_000);
    const both = await until(async () => (/Cancelled/.test(await outputText(L.page)) && /Cancelled/.test(await outputText(G.page)) ? true : null), 10_000);
    return { ok: shown && done?.status === 'cancelled' && !!both, detail: `Cancel on the candidate's side ${shown}; the run ${done?.status ?? 'did not end'}; both panes read Cancelled ${!!both}` };
  });

  await step('I4.5a', async () => {
    // A failing run first (its output is what the coach reads with the pad), then Milo in the call and lines heard.
    await typeInPad(G.page, '\n# mock:fail');
    await G.page.waitForTimeout(800);
    await G.page.getByTestId('interview-pad-run').click();
    await until(async () => /Failed/.test(await outputText(L.page)), 15_000);
    const pad = `${(await padText(L.page)) ?? ''}\n${await outputText(L.page)}`;
    const callId = await inviteMilo(ctx, L);
    if (!callId) return { ok: false, detail: 'Milo did not come into the call (no listening state)' };
    const guestId = (await guestApi(G.context, 'GET', '/room')).body?.room?.self?.userId ?? null;
    const lines = [
      { userId: lead, text: 'Walk me through what your function does when the list is empty.' },
      { userId: guestId, text: 'It returns early, but the traceback shows the index check runs first, so I would move it up.' },
    ];
    for (const l of lines) await hear(ctx, L, callId, l.userId, l.text);
    const quote = await suggestion(L.page);
    if (!quote) return { ok: false, detail: 'no suggestion within 160 s' };
    const basedOn = ((await L.page.getByTestId('interview-suggestion-based-on').first().getAttribute('title').catch(() => null)) ?? '').trim();
    const page = (await G.page.locator('body').innerText()).replace(/\s+/g, ' ');
    const reads = JSON.stringify([(await guestApi(G.context, 'GET', '/room')).body, (await guestApi(G.context, 'GET', '/runs')).body]);
    const sugg = quote.replace(/Have Milo ask|I’ll ask it|Skip|Based on/g, '').trim().slice(0, 60);
    const leaked = [sugg, basedOn].filter((s) => s && s.length > 12 && (page.includes(s) || reads.includes(s)));
    const fromCode = !!basedOn && (pad.includes(basedOn) || /traceback|mock:fail/i.test(basedOn));
    return { ok: leaked.length === 0, detail: `the suggestion "${quote.slice(0, 120)}"; based on "${basedOn.slice(0, 80)}" (a line of the pad or the output: ${fromCode}); on the candidate's side: ${leaked.length ? JSON.stringify(leaked) : 'nothing'}` };
  });

  await step('I4.4e', async () => {
    const recruiter = await ctx.signIn(SEED.cast.recruiter); open.push(recruiter);
    const opening = SEED.openings.backend;
    const o = (await api(recruiter, 'GET', `/api/interviews/openings/${opening}`)).body?.opening;
    if (!o) return { ok: false, detail: 'the recruiter cannot read the opening' };
    const put = await api(recruiter, 'PUT', `/api/interviews/openings/${opening}/details`, {
      revision: o.revision, title: o.title, level: o.level, team: o.team, location: o.location, hiringManagerId: o.hiringManagerId, state: o.state,
      budgetCapUsd: null, interviewCapUsd: o.interviewCapUsd,
    });
    if (put.status !== 200) return { ok: false, detail: `clearing the cap answered ${put.status} ${JSON.stringify(put.body).slice(0, 120)}` };
    const before = ((await api(L.context, 'GET', base)).body?.runs ?? []).length;
    await L.page.getByTestId('interview-pad-run').click();
    const lr = await until(async () => (await L.page.getByTestId('interview-pad-refusal').first().innerText().catch(() => '')) || null, 10_000) ?? '';
    await G.page.getByTestId('interview-pad-run').click();
    const gr = await until(async () => (await G.page.getByTestId('interview-pad-refusal').first().innerText().catch(() => '')) || null, 10_000) ?? '';
    const after = ((await api(L.context, 'GET', base)).body?.runs ?? []).length;
    await shootPage(G.page, 'I4.4-candidate-no-cap');
    const ok = /cap/i.test(lr) && !!gr && !MONEY.test(gr) && after === before;
    return { ok, detail: `the lead reads "${lr}"; the candidate reads "${gr}"; runs stored ${before} → ${after}` };
  });

  for (const c of open) await c.close().catch(() => undefined);
  await resetMock();
}
