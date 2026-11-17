// Piece I3.7: the live transcript on the panel's side (docs/interviews-tenant-plan.md row I3.7, decisions 4 and 21; contract
// E5). The call on the stand-in media of h3-call.mjs, lines from the mock injector.
//   I3.7a  Nadia's leadership round (behavioural): what is said shows in the Milo tab's transcript for the lead and for the
//          panel member, under the speaker (the candidate shown as the candidate's name)
//   I3.7b  a technical round (Mateo's design round): the transcript is in the Milo tab, open (since UI round 2 it has the tab
//          to itself; the ledger's "folded" was the pane before decision 21), and the recruiter reads it by the API while live
//   I3.7c  /join shows none of it: the lines are on no page and in no read of the candidate's, nor in the chat they read
import { liveRoom, inject, sleep, guestReads, guestChatText } from './h3-call.mjs';

export default async function run(ctx) {
  const { SEED, record, resetMock, api, shootPage } = ctx;
  const WEN = SEED.cast.interviewer2; const HUGO = SEED.cast.interviewer;
  const step = async (name, fn) => {
    try { const r = await fn(); record(name, r.ok, r.detail); } catch (e) { record(name, false, e instanceof Error ? e.message.split('\n')[0] : String(e)); }
  };
  const transcriptOn = async (page, text, ms = 30_000) => {
    await page.getByTestId('interview-room-pane-tab-milo').click();
    const panel = page.getByTestId('interview-room-transcript');
    const end = Date.now() + ms;
    let t = '';
    while (Date.now() < end) { t = (await panel.first().innerText().catch(() => '')).replace(/\s+/g, ' '); if (t.includes(text)) break; await sleep(1000); }
    return { text: t, visible: await panel.first().isVisible().catch(() => false) };
  };
  const PANEL_LINE = 'Tell me about a project you would run differently next time.';
  const CAND_LINE = 'The billing rewrite: I would have shipped it behind a flag in smaller steps.';

  await resetMock();
  let candidateSide = null;
  const panelSeat = { userId: HUGO, label: 'panel' };
  await step('I3.7a', async () => {
    const r = await liveRoom(ctx, { interviewId: SEED.panelInterview, leadId: WEN, extra: [panelSeat] });
    try {
      await inject(ctx, r.callId, [{ userId: WEN, text: PANEL_LINE }, { userId: r.guest.guestId, text: CAND_LINE }]);
      const lead = await transcriptOn(r.leadPage, CAND_LINE);
      const panel = await transcriptOn(panelSeat.page, CAND_LINE);
      const shots = await shootPage(r.leadPage, 'I3.7a-transcript');
      // The candidate's own page and reads, while the lines are on the panel's side.
      const page = await r.guest.page.innerText('body').catch(() => '');
      const reads = await guestReads(ctx, r.guest.context);
      const chat = await guestChatText(r.guest);
      const tr = await api(r.guest.context, 'GET', `/api/interviews/interviews/${SEED.panelInterview}/transcript`);
      candidateSide = { leaks: [PANEL_LINE, CAND_LINE].filter((l) => page.includes(l) || reads.includes(l) || chat.includes(l)), read: tr.status };
      const ok = lead.text.includes(PANEL_LINE) && lead.text.includes(CAND_LINE) && /Wen Zhao/.test(lead.text) && /Nadia/.test(lead.text)
        && panel.text.includes(CAND_LINE) && shots.every((s) => s.ok);
      return { ok, detail: `lead's transcript "${lead.text.slice(0, 140)}"; the panel member's has the candidate's line ${panel.text.includes(CAND_LINE)}` };
    } finally { await r.close(); }
  });

  await step('I3.7c', async () => {
    if (!candidateSide) return { ok: false, detail: 'no room' };
    return { ok: candidateSide.leaks.length === 0 && [401, 403, 404].includes(candidateSide.read), detail: `lines on the candidate's page, reads or chat: ${JSON.stringify(candidateSide.leaks)}; the candidate's transcript read ${candidateSide.read}` };
  });

  await resetMock();
  await step('I3.7b', async () => {
    const iv = SEED.interviews.mateoDesign;
    const r = await liveRoom(ctx, { interviewId: iv, leadId: HUGO });
    try {
      await inject(ctx, r.callId, [{ userId: HUGO, text: PANEL_LINE }, { userId: r.guest.guestId, text: CAND_LINE }]);
      const tabs = (await r.leadPage.getByTestId('interview-room-pane').getByRole('tab').allInnerTexts()).map((t) => t.trim());
      const lead = await transcriptOn(r.leadPage, CAND_LINE);
      const rec = await api(r.recruiter, 'GET', `/api/interviews/interviews/${iv}/transcript`);
      const recHas = JSON.stringify(rec.body ?? '').includes(CAND_LINE);
      const ok = JSON.stringify(tabs) === '["Pad","Questions","Milo","Chat"]' && lead.visible && lead.text.includes(CAND_LINE) && rec.status === 200 && recHas;
      return { ok, detail: `tabs ${tabs.join('/')}; the transcript open in the Milo tab ${lead.visible} with the line ${lead.text.includes(CAND_LINE)}; the recruiter's read ${rec.status} with the line ${recHas}` };
    } finally { await r.close(); }
  });
}
