// G55: creating documents, whiteboards and status decks from an initiative's
// Docs tab by voice. "Create a PowerPoint of this initiative's progress this
// past sprint" on the initiative page is ONE queue_work deck call with scope
// "this-page" and the user's words as `focus`: one card, then the deck route
// with the words as its brief (and the narrative they steer). "New whiteboard
// called Flow" is create { kind: 'whiteboard' }: the Docs tab's own read says
// whether this persona may (the route's canWrite), one card, the route, and
// the editor opens. create { kind: 'deck' } is the same queue_work path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { ResultMemory, planPreparedCall, prepareToolCall, runPreparedCall, type ConfirmPlan, type ToolResult } from '../tools.ts';
import { pageContextNote, publishPageOffers, resetPageOffers, type PublishedPage } from '../pageContext.ts';
import { newFileChoices, newFileOffers } from '../../../pages/projects/initiativeFilesModel.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext, type LoggedRequest, type Route } from './voiceHarness.ts';
import type { Action } from '../../capabilities';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000d5';
type Call = { name: string; arguments: Record<string, unknown>; said: string };

const PAGE: PublishedPage = {
  path: '/iq/projects/p-auth', record: { ref: 'initiative:p-auth', title: 'Auth Migration' }, rowsLabel: 'work items',
  rows: [{ ref: 'work-item:w-1', title: 'Rotate the signing keys', status: 'open', priority: 'high' }],
};
const PROJECTS = [{ id: 'p-auth', name: 'Auth Migration' }, { id: 'p-obs', name: 'Observability Platform' }];
const SAID = 'Create a PowerPoint of this initiative\'s progress this past sprint.';
// What the delegation backend calls for that sentence on this page (the scripted Live session plays it).
const DECK: Call = { name: 'queue_work', arguments: { kind: 'deck', target: 'this initiative', scope: 'this-page', focus: 'progress this past sprint', rows: null, note: null, model: null }, said: SAID };
const BRIEF = { words: 'progress this past sprint', window: { sprintId: 'spr-auth-s1', name: 'Sprint 9 — OIDC core', startsOn: '2026-09-27', endsOn: '2026-10-18', status: 'done', which: 'last-ended' } };
const deckRoute: Route = (req) => (req.method === 'POST' && req.url === '/api/initiative-decks/projects/p-auth'
  ? { status: 201, body: { deckId: 'idk-9', revisionId: 'irev-1', includesBudget: false, narrative: { requested: true, status: 'applied', templatedSlideIds: [] }, brief: BRIEF } } : undefined);

const writes = (log: readonly LoggedRequest[]) => log.filter((l) => l.method !== 'GET' && !l.url.startsWith('/api/voice/')).map((l) => [l.method, l.url, l.body]);

async function session(call: Call, opts: { confirm?: boolean } = {}) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, mockScript: mockLiveScript(SESSION, call),
    }),
    route('GET', '/api/graph/projects', 200, PROJECTS),
    deckRoute,
  ]);
  const finished: string[] = [];
  const ctx = toolContext({ fetch, role: 'sme', allow: ['DispatchAgentRun', 'VoiceNavigate'], results: new ResultMemory(), page: () => PAGE,
    jobs: { track: () => {}, finished: (j, state, detail) => { finished.push(`${j.title}:${state}:${detail ?? ''}`); } } });
  const controller = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await controller.start();
  await clock.advance(1500);
  const card = controller.getSnapshot().pending;
  if (opts.confirm !== false) controller.confirm('voice');
  await clock.advance(3000);
  const after = controller.getSnapshot();
  const stopping = controller.stop();
  await clock.advance(300);
  await stopping;
  return { card, after, log, finished };
}

test('the example sentence is one queue_work deck on the initiative in view, with the words as its focus; one card, then the deck route with the brief', async () => {
  // The call the scripted session makes is valid as the catalogue states it.
  assert.ok(prepareToolCall('queue_work', DECK.arguments, toolContext()).ok, 'the call validates against the catalogue');
  const r = await session(DECK);
  assert.ok(r.card, 'one card');
  assert.equal(r.card!.tool, 'queue_work');
  assert.equal(r.card!.title, 'Build a status deck for Auth Migration');
  assert.match(String(r.card!.detail), /Focus, in your words: "progress this past sprint"\. The figures stay the initiative's record/);
  assert.match(String(r.card!.detail), /spends a little/);
  assert.deepEqual(writes(r.log), [['POST', '/api/initiative-decks/projects/p-auth', { narrative: true, brief: 'progress this past sprint' }]], 'one deck, the words as its brief');
  assert.equal(r.log.filter((l) => l.url.startsWith('/api/search')).length, 0, 'no search for the initiative in view');
  const calls = r.after.turns.flatMap((t) => t.toolCalls ?? []);
  assert.deepEqual(calls.map((c) => [c.name, c.status]), [['queue_work', 'done']]);
  assert.deepEqual(r.finished, ['The Auth Migration deck:done:focus: Sprint 9 — OIDC core (2026-09-27 to 2026-10-18)']);
  assert.equal(loggedEvents(r.log).filter((e) => e['kind'] === 'confirm-shown').length, 1);
});

test('a cancel sends nothing', async () => {
  const r = await session(DECK, { confirm: false });
  assert.ok(r.card);
  assert.deepEqual(writes(r.log), []);
});

async function plan(tool: 'create' | 'queue_work', args: Record<string, unknown>, opts: { allow?: Action[]; routes?: Route[]; page?: PublishedPage | null; tenant?: string } = {}) {
  const { fetch, log } = fakeFetch(opts.routes ?? []);
  const finished: string[] = [];
  const ctx = toolContext({ fetch, tenant: opts.tenant ?? 'orgiq', allow: opts.allow ?? ['DispatchAgentRun'], page: () => (opts.page === undefined ? PAGE : opts.page),
    jobs: { track: () => {}, finished: (j, state) => { finished.push(`${j.title}:${state}`); } } });
  const p = prepareToolCall(tool, args, ctx);
  assert.ok(p.ok, `${tool} ${JSON.stringify(args)} validates`);
  const { VOICE_PLANNERS, VOICE_RUNNERS } = await import('../actions.ts');
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  if (!planned || 'result' in planned) return { card: null as ConfirmPlan | null, result: planned?.result as ToolResult, log, ctx, run: null as ToolResult | null };
  assert.deepEqual(writes(log), [], 'nothing is written before the confirm');
  const run = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data);
  return { card: planned.plan, result: run, log, ctx, run };
}

const DOCS = (canWrite: boolean): Route => route('GET', '/api/graph/projects/p-auth/workspace-documents', 200, { projectId: 'p-auth', documents: [], canWrite });
const CREATED: Route = (req) => (req.method === 'POST' && req.url === '/api/graph/projects/p-auth/workspace-documents'
  ? { status: 201, body: { projectId: 'p-auth', document: { id: 'wdoc-7', href: '/iq/documents/wdoc-7', kind: (req.body as { kind: string }).kind } } } : undefined);

test('"new whiteboard called Flow" on the initiative page: one card, the Docs tab\'s route, and the editor opens', async () => {
  const r = await plan('create', { kind: 'whiteboard', fields: { title: 'Flow' } }, { allow: [], routes: [DOCS(true), CREATED] });
  assert.equal(r.card!.title, 'Create the whiteboard "Flow" in Auth Migration');
  assert.deepEqual(writes(r.log), [['POST', '/api/graph/projects/p-auth/workspace-documents', { title: 'Flow', kind: 'whiteboard' }]]);
  assert.equal(r.run!.outcome, 'done');
  assert.equal(r.run!.output['opened'], true);
  assert.deepEqual(r.ctx.navigations, ['/iq/documents/wdoc-7'], 'the editor opens');
  // A document by name of another initiative, untitled: the page's own default title.
  const doc = await plan('create', { kind: 'document', fields: { initiative: 'observability' } }, { allow: [], routes: [
    route('GET', '/api/graph/projects/p-obs/workspace-documents', 200, { projectId: 'p-obs', documents: [], canWrite: true }),
    route('GET', '/api/graph/projects', 200, PROJECTS),
    (req) => (req.method === 'POST' && req.url === '/api/graph/projects/p-obs/workspace-documents' ? { status: 201, body: { projectId: 'p-obs', document: { id: 'wdoc-8', href: '/iq/documents/wdoc-8' } } } : undefined)] });
  assert.equal(doc.card!.title, 'Create the page "Untitled page" in Observability Platform');
  assert.deepEqual(writes(doc.log), [['POST', '/api/graph/projects/p-obs/workspace-documents', { title: 'Untitled page', kind: 'page' }]]);
});

test('a persona who is not on the initiative is refused before any card; the route\'s refusal is said if it comes anyway', async () => {
  const r = await plan('create', { kind: 'document', fields: { initiative: 'this-page', title: 'Notes' } }, { allow: [], routes: [DOCS(false), CREATED] });
  assert.equal(r.card, null);
  assert.equal(r.result.outcome, 'refused');
  assert.match(r.result.summary, /Only the people on Auth Migration/);
  assert.deepEqual(writes(r.log), []);
  const raced = await plan('create', { kind: 'document', fields: { title: 'Notes' } }, { allow: [], routes: [DOCS(true),
    route('POST', '/api/graph/projects/p-auth/workspace-documents', 403, { error: 'you can only create documents on initiatives you own or contribute to', code: 'NOT_ON_INITIATIVE' })] });
  assert.equal(raced.run!.outcome, 'refused');
  assert.match(raced.run!.summary, /own or contribute to/);
  // No initiative in view and none named: nothing to put it in.
  const nowhere = await plan('create', { kind: 'whiteboard', fields: {} }, { allow: [], page: null });
  assert.equal(nowhere.result.outcome, 'refused');
  assert.match(nowhere.result.summary, /Name the initiative/);
});

test('create { kind: deck } is queue_work\'s deck: the same card, the same route and body', async () => {
  const r = await plan('create', { kind: 'deck', fields: { focus: 'progress this past sprint' } }, { routes: [route('GET', '/api/graph/projects', 200, PROJECTS), deckRoute] });
  assert.equal(r.card!.title, 'Build a status deck for Auth Migration');
  assert.deepEqual(writes(r.log), [['POST', '/api/initiative-decks/projects/p-auth', { narrative: true, brief: 'progress this past sprint' }]]);
  assert.equal(r.run!.outcome, 'done');
  // The deck spends: a role without DispatchAgentRun is refused before any read.
  const role = await plan('create', { kind: 'deck', fields: {} }, { allow: [], routes: [] });
  assert.equal(role.result.outcome, 'refused');
  assert.equal(role.log.length, 0);
});

test('queue_work deck: no focus sends the page button\'s empty body; a focus outside Work is refused; this-page needs an initiative in view', async () => {
  const plain = await plan('queue_work', { kind: 'deck', target: 'this initiative', scope: 'this-page' }, { routes: [route('GET', '/api/graph/projects', 200, PROJECTS), deckRoute] });
  assert.deepEqual(writes(plain.log), [['POST', '/api/initiative-decks/projects/p-auth', {}]]);
  const social = await plan('queue_work', { kind: 'deck', target: 'platform', focus: 'last sprint' }, { tenant: 'social', allow: ['ViewSocial'], page: null, routes: [
    route('GET', '/api/social/resolve?kind=channel', 200, { kind: 'channel', match: { id: 'platform', name: 'platform', channel: 'social:ch:platform' }, candidates: [] })] });
  assert.equal(social.result.outcome, 'refused');
  assert.match(social.result.summary, /Only an initiative's status deck takes a focus/);
  const nowhere = await plan('queue_work', { kind: 'deck', target: 'this initiative', scope: 'this-page', focus: 'last sprint' }, { page: { path: '/iq/work', rows: [] } });
  assert.equal(nowhere.result.outcome, 'refused');
  assert.match(nowhere.result.summary, /no initiative to build a deck for/);
});

test('the Docs tab\'s New menu is in the page context, as the choices this persona sees and the call for each', () => {
  resetPageOffers();
  const off = publishPageOffers({ path: PAGE.path, what: 'New file', offers: newFileOffers(newFileChoices({ capabilitiesReady: true, canWritePages: true, canDispatch: true })) });
  const note = pageContextNote({ tenant: 'orgiq', pathname: PAGE.path, pageId: 'initiatives', page: PAGE });
  assert.match(note, /It offers New file: Document \(create kind document, initiative "this-page"/);
  assert.match(note, /Whiteboard \(create kind whiteboard/);
  assert.match(note, /Presentation \(a PowerPoint status deck\) \(queue_work kind deck with scope "this-page", focus what it should cover in the user's words\)/);
  // Another path never borrows them; the page not yet published still shows them; unmounting clears them.
  assert.doesNotMatch(pageContextNote({ tenant: 'orgiq', pathname: '/iq/work', page: null }), /It offers/);
  assert.match(pageContextNote({ tenant: 'orgiq', pathname: PAGE.path, page: null }), /has not shown any rows yet\.\nIt offers New file/);
  off();
  assert.doesNotMatch(pageContextNote({ tenant: 'orgiq', pathname: PAGE.path, page: PAGE }), /It offers/);
  // A contributor without DispatchAgentRun is offered pages and boards, never the deck.
  const contributor = newFileOffers(newFileChoices({ capabilitiesReady: true, canWritePages: true, canDispatch: false }));
  assert.deepEqual(contributor.map((o) => o.kind), ['document', 'whiteboard']);
});
