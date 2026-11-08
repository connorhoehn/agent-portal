// G22, dispatch without the questionnaire: "dispatch these top three" on an
// initiative page is one card naming the items, the initiative's defaults (the
// page's drawer: each item's model, the initiative's codebase) and the
// drawer's forecast, then three dispatches through the drawer's route after
// that one confirm. No model or profile question, no second card; a money
// brake is the usual refusal with nothing pushed through.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { ResultMemory } from '../tools.ts';
import { loggedEvents, FakeClock, fakeFetch, middlewareVoice, route, toolContext, type Route } from './voiceHarness.ts';
import type { PublishedPage } from '../pageContext.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000a2';
const CODEBASE = '11111111-2222-4333-8444-555555555555';
type Call = { name: string; arguments: Record<string, unknown>; said: string };

const ITEMS = [
  { id: 'w-1', type: 'story', title: 'Rotate the signing keys', status: 'open', priority: 'high', storyPoints: 2, estimateModel: null, children: [] },
  { id: 'w-2', type: 'story', title: 'Move sessions to the new store', status: 'open', priority: 'high', storyPoints: 5, estimateModel: 'us.anthropic.claude-sonnet-5', children: [] },
  { id: 'w-3', type: 'bug', title: 'Delete the legacy cookie', status: 'open', priority: 'medium', storyPoints: 1, estimateModel: null, children: [] },
  { id: 'w-4', type: 'story', title: 'Write the migration note', status: 'open', priority: 'low', storyPoints: 1, estimateModel: null, children: [] },
];
const PAGE: PublishedPage = {
  path: '/iq/projects/p-auth', record: { ref: 'initiative:p-auth', title: 'Auth migration' }, rowsLabel: 'work items',
  rows: ITEMS.map((i) => ({ ref: `work-item:${i.id}`, title: i.title, status: i.status, priority: i.priority, href: `/iq/projects/p-auth?item=${i.id}` })),
};
const DISPATCH: Call = { name: 'queue_work', arguments: { kind: 'dispatch', target: 'the top three', rows: [1, 2, 3], scope: 'this-page', note: null, model: null }, said: 'Dispatch these top three if we have budget.' };

async function run(opts: { dispatch?: Route; confirm?: boolean } = {}) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const clock = new FakeClock();
  let n = 0;
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['queue_work'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, mockScript: mockLiveScript(SESSION, DISPATCH),
    }),
    route('GET', '/api/graph/projects/p-auth/work', 200, [{ id: 'e-1', type: 'epic', title: 'Auth', children: ITEMS }]),
    route('GET', '/api/graph/projects/p-auth', 200, { id: 'p-auth', name: 'Auth migration', repoFullName: 'acme/auth' }),
    route('GET', '/api/agent-projects', 200, { projects: [{ id: CODEBASE, repoFullName: 'acme/auth', orgProjectId: 'p-auth' }] }),
    route('GET', '/api/bots/estimate', 200, { costUsdP25: 0.5, costUsdP75: 1.5 }),
    opts.dispatch ?? ((req) => (req.method === 'POST' && req.url === '/api/bots/dispatch-work' ? { status: 202, body: { run: { id: `run-${++n}`, jobId: `job-${n}` } } } : undefined)),
  ]);
  const tracked: string[] = [];
  const ctx = toolContext({ fetch, role: 'sme', allow: ['DispatchAgentRun', 'VoiceNavigate'], results: new ResultMemory(), page: () => PAGE, jobs: { track: (j) => { tracked.push(j.jobId); } } });
  const controller = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const cards: string[] = [];
  controller.subscribe(() => { const p = controller.getSnapshot().pending; if (p && cards.at(-1) !== `${p.requestId}`) cards.push(`${p.requestId}`); });
  await controller.start();
  await clock.advance(1500);
  const card = controller.getSnapshot().pending;
  const choice = controller.getSnapshot().choice;
  if (opts.confirm !== false) controller.confirm('click');
  await clock.advance(3000);
  const after = controller.getSnapshot();
  const stopping = controller.stop();
  await clock.advance(300);
  await stopping;
  return { card, choice, cards, after, log, tracked };
}

test('three page rows dispatch after one confirm, with the page\'s defaults and the drawer\'s forecast; no second prompt', async () => {
  const r = await run();
  assert.ok(r.card, 'one card');
  assert.equal(r.choice, null, 'no choice card');
  assert.equal(r.card!.title, 'Dispatch 3 work items');
  assert.deepEqual(r.card!.detail, [
    '1. Rotate the signing keys · Haiku',
    '2. Move sessions to the new store · Sonnet',
    '3. Delete the legacy cookie · Haiku',
    'Profile: Auth migration\'s own, with Haiku and Sonnet (the drawer\'s default) and the acme/auth codebase; no per-run cap.',
    'Forecast $1.50 to $4.50 in all.',
    'Agents run them on computers and spend against Auth migration.',
  ]);
  assert.equal(r.cards.length, 1, 'exactly one card was raised');
  assert.equal(r.after.pending, null, 'nothing waits after the confirm');
  const posts = r.log.filter((l) => l.method === 'POST' && l.url === '/api/bots/dispatch-work');
  assert.deepEqual(posts.map((p) => (p.body as Record<string, unknown>)['workItemId']), ['w-1', 'w-2', 'w-3']);
  for (const p of posts) {
    const body = p.body as Record<string, unknown>;
    assert.equal(body['agentProjectId'], CODEBASE);
    assert.ok(!Object.keys(body).some((k) => k.startsWith('confirmOver')), 'no confirm flag');
  }
  assert.equal((posts[1]!.body as Record<string, unknown>)['model'], 'us.anthropic.claude-sonnet-5', 'the item\'s own recorded model');
  assert.equal((posts[0]!.body as Record<string, unknown>)['model'], 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'else the runtime default');
  assert.deepEqual(r.tracked, ['job-1', 'job-2', 'job-3'], 'one followed job each');
  const confirms = loggedEvents(r.log).filter((e) => e['kind'] === 'confirm-shown');
  assert.equal(confirms.length, 1);
  const calls = r.after.turns.flatMap((t) => t.toolCalls ?? []);
  assert.deepEqual(calls.map((c) => [c.name, c.status, c.summary]), [['queue_work', 'done', '3 dispatches queued']]);
});

test('a money brake on the second item stops there, says so in the usual shape, and keeps what was sent', async () => {
  let n = 0;
  const r = await run({
    dispatch: (req) => {
      if (req.method !== 'POST' || req.url !== '/api/bots/dispatch-work') return undefined;
      n += 1;
      return n === 2 ? { status: 409, body: { error: 'over the allocation', gate: 'allocation', confirmFlag: 'confirmOverAllocation' } } : { status: 202, body: { run: { id: `run-${n}`, jobId: `job-${n}` } } };
    },
  });
  const calls = r.after.turns.flatMap((t) => t.toolCalls ?? []);
  assert.equal(calls[0]!.status, 'refused');
  assert.match(calls[0]!.summary, /needs a confirm on its page, not by voice: over the allocation/);
  assert.equal(r.log.filter((l) => l.method === 'POST' && l.url === '/api/bots/dispatch-work').length, 2, 'the third is never sent');
  assert.deepEqual(r.tracked, ['job-1']);
  const refused = loggedEvents(r.log).find((e) => e['kind'] === 'refused')!;
  assert.equal((refused['data'] as Record<string, unknown>)['reason'], 'budget');
});

test('a cancel sends nothing', async () => {
  const r = await run({ confirm: false });
  assert.ok(r.card);
  assert.equal(r.log.filter((l) => l.url === '/api/bots/dispatch-work').length, 0);
});
