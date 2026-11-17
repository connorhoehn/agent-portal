// Piece I3.10: Milo's question plan on Prepare (docs/interviews-tenant-plan.md row I3.10; contract E6). Nadia's leadership
// round (accepted: Wen leads, Hugo on the panel); the plan comes from the scripted stand-in.
//   I3.10a  the lead: "Ask Milo for a plan" in the section body → Milo's suggested plan → Use this plan → Save plan → after a
//           reload the plan holds the drafted questions; shots at both widths
//   I3.10b  the three-plans line: two more asks, then the fourth reads "Milo has drafted three plans for this round. …"
//   I3.10c  absent for the panel member (Hugo), the recruiter (Greta) and on a live round (Kwame's, Hugo leads)
//   I3.10d  the budget-paused line: with the opening's caps at $0 the ask reads "Milo is paused for this opening until its
//           budget is raised, …" and no plan
//   I3.10e  panel against candidate: the plan's reasons are on no page and in no read of the candidate's
//   I3.10f  the plan's rows in Milo's log (the recruiter's export) hold no candidate name
import { sleep, setCaps } from './h3-call.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, api, signIn, portal, shootPage, mintInvite, openGuest } = ctx;
  const iv = SEED.panelInterview;
  const WEN = SEED.cast.interviewer2; const HUGO = SEED.cast.interviewer;
  const AT_MAX = 'Milo has drafted three plans for this round. Choose from those, or build the plan yourself below.';
  const PAUSED = 'Milo is paused for this opening until its budget is raised, so no plan can be drafted. You can still choose the questions yourself.';
  const prepare = (id) => `${portal}/interviews/rounds/${id}/prepare`;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const open = async (context, id) => {
    const page = await context.newPage();
    await page.goto(prepare(id), { waitUntil: 'domcontentloaded' });
    await page.getByTestId('interviews-prepare').or(page.getByText(/not found/i)).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    await sleep(800);
    return page;
  };
  const askOnce = async (page) => {
    await page.getByTestId('interviews-draft-ask').click();
    const end = Date.now() + 30_000;
    while (Date.now() < end && /Asking Milo/.test(await page.getByTestId('interviews-draft-ask').innerText().catch(() => ''))) await sleep(300);
    await sleep(300);
    const line = (await page.getByTestId('interviews-draft-line').first().innerText({ timeout: 2000 }).catch(() => '')).trim();
    const problem = (await page.getByTestId('interviews-draft-problem').first().innerText({ timeout: 500 }).catch(() => '')).trim();
    const rows = await page.getByTestId('interviews-draft-prompt').allInnerTexts();
    return { line, problem, rows: rows.map((r) => r.trim()) };
  };

  await resetMock();
  const wen = await signIn(WEN);
  let reasons = [];
  try {
    await step('I3.10a', async () => {
      const page = await open(wen, iv);
      const first = await askOnce(page);
      await page.getByTestId('interviews-draft-use').click();
      await page.getByTestId('interviews-plan-save').click();
      await sleep(1500);
      const note = (await page.getByTestId('interviews-plan-note').first().innerText({ timeout: 5000 }).catch(() => '')).trim();
      const shots = await shootPage(page, 'I3.10a-prepare');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId('interviews-plan-table').waitFor({ timeout: 30_000 });
      const saved = (await page.getByTestId('interviews-plan-prompt').allInnerTexts()).map((t) => t.trim());
      await page.close();
      const ok = first.rows.length > 0 && saved.length === first.rows.length && first.rows.every((r, i) => saved[i] === r) && shots.every((s) => s.ok);
      return { ok, detail: `drafted ${first.rows.length} ("${(first.rows[0] ?? '').slice(0, 50)}"); saved "${note}"; after the reload ${saved.length} in the same order ${first.rows.every((r, i) => saved[i] === r)}` };
    });

    await step('I3.10b', async () => {
      const page = await open(wen, iv);
      const second = await askOnce(page);
      const third = await askOnce(page);
      const fourth = await askOnce(page);
      await page.close();
      const ok = second.rows.length > 0 && third.rows.length > 0 && (fourth.line === AT_MAX || fourth.problem === AT_MAX);
      return { ok, detail: `second ${second.rows.length}, third ${third.rows.length}, fourth: "${fourth.line || fourth.problem}"` };
    });
    await step('I3.10f', async () => {
      const greta = await signIn(SEED.cast.recruiter);
      try {
        const r = await api(greta, 'GET', `/api/interviews/interviews/${iv}/milo-export`);
        const plans = [];
        const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.kind === 'plan') plans.push(x); Object.values(x).forEach(walk); } };
        walk(r.body);
        const text = JSON.stringify(plans);
        const named = ['Nadia', 'Petrova'].filter((n) => text.includes(n));
        return { ok: r.status === 200 && plans.length >= 3 && named.length === 0, detail: `export ${r.status}: ${plans.length} plan rows; the candidate's name in them: ${named.join(', ') || 'no'}` };
      } finally { await greta.close(); }
    });
  } finally { await wen.close(); }

  await step('I3.10c', async () => {
    await resetMock();
    const hugo = await signIn(HUGO); const greta = await signIn(SEED.cast.recruiter);
    try {
      const counts = [];
      for (const [who, ctxOf, id] of [['panel', hugo, iv], ['recruiter', greta, iv], ['live round', hugo, SEED.interviews.kwameLive]]) {
        const page = await open(ctxOf, id);
        counts.push(`${who} ${await page.getByTestId('interviews-draft-ask').count()}`);
        await page.close();
      }
      const lead = await open(hugo, SEED.interviews.mateoDesign);
      const leadHas = await lead.getByTestId('interviews-draft-ask').count();
      await lead.close();
      const ok = counts.every((c) => c.endsWith(' 0')) && leadHas === 1;
      return { ok, detail: `"Ask Milo for a plan": ${counts.join(', ')}; Hugo as the lead of Mateo's ready round ${leadHas}` };
    } finally { await hugo.close(); await greta.close(); }
  });

  await step('I3.10d', async () => {
    await resetMock();
    const w = await signIn(WEN); const greta = await signIn(SEED.cast.recruiter);
    try {
      await setCaps(ctx, greta, SEED.openings.em, { budgetCapUsd: 0, interviewCapUsd: 0 });
      const page = await open(w, iv);
      const out = await askOnce(page);
      await page.close();
      return { ok: (out.line === PAUSED || out.problem === PAUSED) && out.rows.length === 0, detail: `"${out.line || out.problem}"; rows ${out.rows.length}` };
    } finally { await w.close(); await greta.close(); }
  });

  await step('I3.10e', async () => {
    await resetMock();
    const greta = await signIn(SEED.cast.recruiter);
    const lead = await signIn(WEN);
    try {
      // The reasons Milo gives the lead for a draft (the scripted stand-in is deterministic from the kit).
      const d = await api(lead, 'POST', `/api/interviews/interviews/${iv}/plan-draft`, {});
      reasons = (d.body?.plan?.questions ?? []).map((q) => String(q.why ?? q.reason ?? '')).filter((r) => r.length > 0);
      if (!reasons.length) return { ok: false, detail: `no reasons in the draft (${d.status} ${JSON.stringify(d.body).slice(0, 100)})` };
      const inv = await mintInvite(greta, iv);
      const g = await openGuest(inv.linkPath);
      try {
        const page = await g.page.innerText('body').catch(() => '');
        const read = await api(g.context, 'GET', '/api/interview-invite/interview');
        const draft = await api(g.context, 'POST', `/api/interviews/interviews/${iv}/plan-draft`, {});
        const leaks = reasons.filter((r) => page.includes(r) || JSON.stringify(read.body ?? '').includes(r));
        return { ok: leaks.length === 0 && [401, 403, 404].includes(draft.status), detail: `${reasons.length} reasons; on the candidate's page or read: ${leaks.length}; the candidate's plan-draft ${draft.status}` };
      } finally { await g.context.close(); }
    } finally { await greta.close(); await lead.close(); }
  });
}
