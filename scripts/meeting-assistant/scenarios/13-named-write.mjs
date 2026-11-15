// named-write: a write asked of Nova that names another person needs that person's consent (docs/meeting-consent-design.md, package 7).
//  Vera asks Nova to create a work item assigned to Nora. No action card is posted: a proposal card is, needing Nora, run by Vera.
//  Vera alone cannot run it. Vera consents; Nora consents last through the API, so it waits consented for Vera (the executor's
//  own click is the last step); Vera's "Run it now" runs the turn once in her stand-in; the card ends done.
import { waitFor, sleep } from '../lib/harness.mjs';

export default {
  order: 13, id: 'named-write', limitSeconds: 120, title: 'a write naming another person is a proposal that needs them; their consent runs it for the asker',
  async run(ctx) {
    const { r } = ctx;
    const { p, call } = await ctx.setup({ people: ['vera', 'nora', 'mia'] });
    for (const k of ['vera', 'nora', 'mia']) ctx.lane(k);
    const args = { kind: 'work-item', fields: { title: 'Cutover runbook', assignee: 'Nora' } };
    ctx.say('vera', 1000, 'Nova, create a work item for the cutover runbook and assign it to Nora.', {
      dry: { call: { name: 'create', args }, followup: (out) => ({ text: /consent/i.test(out) ? 'This needs your consent and Nora\'s. Answer in the prompt above the call controls.' : 'I could not offer that.', frames: 14 }) },
    });
    const veraRuns = ctx.turns('vera', (t) => (t.kind === 'write' ? { ok: true, say: 'Created the work item.', delayMs: 300 } : { withhold: true }));
    const noraRuns = ctx.turns('nora', () => ({ ok: true, say: 'Created the work item.' }));
    ctx.begin();
    const card = await waitFor(async () => (await call.novaMessages(p.vera)).find((m) => m.metadata?.kind === 'assistant-proposal'), 25_000, 400);
    r.expect('Vera\'s request is a proposal card', !!card, card ? `state ${card.metadata.state}` : 'no proposal card');
    const actionCards = (await call.novaMessages(p.vera)).filter((m) => m.metadata?.kind === 'assistant-action');
    r.expect('no action card was posted for it', actionCards.length === 0, `${actionCards.length} action card(s)`);
    if (!card) { await ctx.world.stopLanes(); return; }
    const id = card.metadata.proposalId;
    const listed = (await p.vera.call('GET', `${call.A}/proposals`)).json?.proposals ?? [];
    const mine = listed.find((x) => x.id === id);
    const named = (mine?.named ?? []).map((x) => x.userId);
    r.expect('it needs Nora and Vera runs it', !!mine && named.includes('u-nora') && mine.executor?.userId === 'u-vera' && mine.source === 'asked',
      mine ? `named ${named.join(',')}; executor ${mine.executor?.userId}; source ${mine.source}` : 'not listed');
    r.expect('it was asked by Vera and says what it will write in words', mine?.askedBy?.userId === 'u-vera' && /^Create a work item titled "Cutover runbook", owned by /.test(mine?.outcome?.summary ?? ''),
      `asked by ${mine?.askedBy?.userId}; "${mine?.outcome?.summary}"`);
    const answer = (who, response) => who.call('POST', `${call.A}/proposals/${encodeURIComponent(id)}/response`, { response });
    const v = await answer(p.vera, 'consent');
    r.harness('Vera consents', v.status === 200, `HTTP ${v.status}`);
    await sleep(1500);
    r.expect('Vera\'s consent alone runs nothing', veraRuns.log.length === 0, `${veraRuns.log.length} turn(s)`);
    const n = await answer(p.nora, 'consent');
    r.harness('Nora consents through the API', n.status === 200, `HTTP ${n.status}`);
    await sleep(1500);
    const waiting = ((await p.vera.call('GET', `${call.A}/proposals`)).json?.proposals ?? []).find((x) => x.id === id);
    r.expect('Nora\'s last consent waits for Vera: consented, nothing ran, Vera may run it now', waiting?.state === 'consented' && waiting?.you?.canRun === true && veraRuns.log.length === 0,
      `${waiting?.state}; canRun ${waiting?.you?.canRun}; ${veraRuns.log.length} turn(s)`);
    const go = await p.vera.call('POST', `${call.A}/proposals/${encodeURIComponent(id)}/response`, { response: 'consent', asExecutor: true });
    r.harness('Vera runs it now', go.status === 200, `HTTP ${go.status}`);
    const done = await waitFor(async () => { const m = (await call.novaMessages(p.vera)).find((x) => x.metadata?.proposalId === id); return m?.metadata?.state === 'done' ? m : null; }, 20_000, 400);
    const ran = veraRuns.log.filter((x) => x.kind === 'write' && x.posted === 200);
    r.expect('the turn ran once in Vera\'s stand-in with the frozen call', ran.length === 1 && JSON.stringify(ran[0]?.args) === JSON.stringify(args), `${ran.length} run(s)`);
    r.expect('nothing ran in Nora\'s stand-in', noraRuns.log.length === 0, `${noraRuns.log.length} turn(s)`);
    r.expect('the proposal card ends done', !!done, done ? 'done' : 'not done');
    await ctx.world.stopLanes();
    await ctx.debug();
  },
};
