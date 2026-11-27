// The voice on an open deck (lib/voice/decks.ts; docs/deck-edit-operations.md): update's deck kind sends typed
// operations to the deck in view, resolved against its editor's page context; list's deck-template and
// deck-report kinds read the templates and the reports; the layouts open as a tab of the editor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_PLANNERS, VOICE_RUNNERS } from '../actions.ts';
import { confirmModeOf, planPreparedCall, prepareToolCall, runPreparedCall, type ConfirmPlan, type ToolContext, type ToolResult } from '../tools.ts';
import { pageContextNote, type PageDeck, type PublishedPage } from '../pageContext.ts';
import { fakeFetch, route, toolContext, type Route } from './voiceHarness.ts';
import { deckVoiceContext, DECK_OFFER } from '../../../components/decks/deckVoiceContext.ts';
import { DECK_REVISED_EVENT } from '../../../components/decks/deckApi.ts';
import type { Action } from '../../capabilities';

const SLIDES = [
  { id: 'title', title: 'Auth migration', layout: 'title' }, { id: 'agenda', title: 'Agenda', layout: 'agenda' },
  { id: 'summary', title: 'Where we are', layout: 'bullets' }, { id: 'work-status', title: 'Work status', layout: 'chart' },
  { id: 'closing', title: 'Next steps', layout: 'closing' },
];
const deck = (over: Partial<PageDeck> = {}): PageDeck => ({
  tenant: 'orgiq', id: 'idk-1', headRevisionId: 'irev-7', viewedRevisionId: 'irev-7', selectedSlideId: 'summary', selectedPosition: 3,
  dirty: false, readOnly: false, slides: SLIDES, ...over,
});
const page = (d: PageDeck | null = deck()): PublishedPage => ({
  path: '/iq/decks/idk-1', record: { ref: 'deck:idk-1', title: 'Auth migration: status' }, rowsLabel: 'slides',
  rows: SLIDES.map((s) => ({ ref: `slide:${s.id}`, title: s.title, status: s.layout })), deck: d,
});
const OK = { revision: { id: 'irev-9', label: 'Edited by operations', createdAt: '2026-11-27T10:00:00Z', producedBy: 'operations:u-me' }, touchedSlideIds: ['s-3f0a91c2'], findings: [], summary: 'Added a timeline slide at slide 4.', exampleSourceSlideIds: ['s-3f0a91c2'] };

async function update(fields: Record<string, unknown>, opts: { tenant?: string; allow?: Action[]; routes?: Route[]; page?: () => PublishedPage | null; ref?: string } = {}) {
  const { fetch, log } = fakeFetch(opts.routes ?? [route('POST', '/api/initiative-decks/idk-1/operations', 201, OK)]);
  const ctx: ToolContext = toolContext({ tenant: opts.tenant ?? 'orgiq', allow: opts.allow ?? ['DispatchAgentRun'], fetch, page: opts.page ?? (() => page()) });
  const p = prepareToolCall('update', { ref: opts.ref ?? 'this-page', fields }, ctx);
  if (!p.ok) return { prepared: false as const, result: p.result, log, card: null as ConfirmPlan | null, mode: null };
  const planned = await planPreparedCall(p.call, ctx, VOICE_PLANNERS);
  if (!planned || 'result' in planned) return { prepared: true as const, result: planned?.result as ToolResult, log, card: null as ConfirmPlan | null, mode: confirmModeOf(p.call) };
  assert.equal(log.filter((r) => r.method !== 'GET').length, 0, 'nothing is written before the confirm');
  const result = await runPreparedCall(p.call, ctx, VOICE_RUNNERS, planned.plan.data);
  return { prepared: true as const, result, log, card: planned.plan, mode: confirmModeOf(p.call) };
}
const writes = (log: Array<{ method: string; url: string; body: unknown }>) => log.filter((r) => r.method === 'POST').map((r) => [r.url, r.body]);

test('the editor publishes the deck: record, slides as rows, head, selection and the offer within the cap', () => {
  const spec = { title: 'Auth migration: status', slides: SLIDES.map((s) => ({ id: s.id, layout: s.layout, title: s.title, bullets: [], sources: [] })) } as never;
  const p = deckVoiceContext({ path: '/iq/decks/idk-1', tenant: 'orgiq', deckId: 'idk-1', title: 'Auth migration: status', spec, headRevisionId: 'irev-7', viewedRevisionId: 'irev-7', selectedSlideId: 'summary', dirty: false, readOnly: false });
  assert.equal(p.record!.ref, 'deck:idk-1');
  assert.deepEqual(p.rows.map((r) => r.ref), SLIDES.map((s) => `slide:${s.id}`));
  assert.equal(p.deck!.selectedPosition, 3);
  assert.ok(DECK_OFFER.length <= 240);
  const note = pageContextNote({ tenant: 'orgiq', pathname: p.path, page: p });
  assert.match(note, /In view: deck:idk-1/);
  assert.match(note, /Deck: 5 slides, slide 3 selected\. Slides are named by position\./);
  assert.match(note, /Offered here: add or change slides, fill a chart from a report, show example layouts/);
  assert.doesNotMatch(note, /irev-7/, 'the revision is the planner\'s, never the model\'s');
});

test('add_slide: the card says what changes in words, and the request is the contract\'s body on the head', async () => {
  const r = await update({ operations: [{ op: 'add_slide', layout: 'timeline', after: '3', title: 'Plan' }] });
  assert.equal(r.card!.title, 'Change "Auth migration: status"');
  assert.deepEqual(r.card!.detail, ['Add a timeline slide after slide 3 titled "Plan".', 'It saves a new version; the current one stays in the history.']);
  assert.equal(r.mode, 'voice');
  assert.deepEqual(writes(r.log), [['/api/initiative-decks/idk-1/operations', { baseRevisionId: 'irev-7', operations: [{ op: 'add_slide', layout: 'timeline', after: 'summary', title: 'Plan' }] }]]);
  assert.equal(r.result.outcome, 'done');
  assert.equal(r.result.output['revisionId'], 'irev-9');
  assert.match(String(r.result.output['say']), /Added a timeline slide at slide 4\. One slide still cites example content\./);
});

test('every operation reads as a sentence on the card, and each maps to its typed operation', async () => {
  const cases: Array<[Record<string, unknown>, string, Record<string, unknown>]> = [
    [{ op: 'set_chart', slide: '4', kind: 'pie', report: 'spend-by-initiative' }, 'Fill slide 4 with a pie chart from Spend by initiative.', { op: 'set_chart', slideId: 'work-status', kind: 'pie', report: { report: 'spend-by-initiative' } }],
    [{ op: 'set_chart', slide: 'this', kind: 'stacked-bar', report: 'runs-by-outcome', period: '7d' }, 'Fill slide 3 with a stacked bar chart from Runs by outcome (the last 7 days).', { op: 'set_chart', slideId: 'summary', kind: 'stacked-bar', report: { report: 'runs-by-outcome', params: { period: '7d' } } }],
    [{ op: 'set_title', slide: '2', title: 'What we cover' }, 'Rename slide 2 to "What we cover".', { op: 'set_title', slideId: 'agenda', title: 'What we cover' }],
    [{ op: 'move_slide', slide: '5', after: '1' }, 'Move slide 5 after slide 1.', { op: 'move_slide', slideId: 'closing', after: 'title' }],
    [{ op: 'move_slide', slide: '3', after: 'start' }, 'Move slide 3 to the start.', { op: 'move_slide', slideId: 'summary', to: 'start' }],
    [{ op: 'set_theme', theme: 'engineering' }, 'Use the engineering theme.', { op: 'set_theme', theme: 'engineering' }],
    [{ op: 'set_theme', theme: 'workspace' }, 'Use this workspace\'s own theme.', { op: 'set_theme', theme: { ref: 'orgiq' } }],
    [{ op: 'add_slide', layout: 'key-figures', after: 'end' }, 'Add a key figures slide at the end.', { op: 'add_slide', layout: 'key-figures', after: 'end' }],
  ];
  for (const [op, line, sent] of cases) {
    const r = await update({ operations: [op] });
    assert.equal(r.card?.detail?.[0], line, JSON.stringify(op));
    assert.deepEqual((writes(r.log)[0]![1] as { operations: unknown[] }).operations, [sent], JSON.stringify(op));
  }
});

test('removing a slide is click-only; several operations go in one request, all or none', async () => {
  const r = await update({ operations: [{ op: 'remove_slide', slide: '2' }, { op: 'set_title', slide: '1', title: 'Auth' }] });
  assert.equal(r.mode, 'click');
  assert.deepEqual(r.card!.detail, ['Remove slide 2 ("Agenda").', 'Rename slide 1 to "Auth".', 'It saves a new version; the current one stays in the history.']);
  assert.equal(writes(r.log).length, 1);
  assert.equal(((writes(r.log)[0]![1]) as { operations: unknown[] }).operations.length, 2);
});

test('preparation: the schema, the tenant, the role, and an open, saved, writable deck come first; nothing is sent', async () => {
  const schema = await update({ operations: [{ op: 'rewrite_slide', slide: '3' }] });
  assert.equal(schema.prepared, false);
  assert.equal(schema.result.outcome, 'refused');
  const tooMany = await update({ operations: Array.from({ length: 6 }, () => ({ op: 'set_theme', theme: 'plain' })) });
  assert.equal(tooMany.prepared, false);
  const role = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, { allow: ['ViewWorkItems'] });
  assert.match(String(role.result.output['reason']), /can't change this deck with your role/);
  const closed = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, { page: () => null });
  assert.match(String(closed.result.output['reason']), /Open the deck first/);
  const unsaved = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, { page: () => page(deck({ dirty: true })) });
  assert.match(String(unsaved.result.output['reason']), /unsaved changes\. Save them first/);
  const viewOnly = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, { page: () => page(deck({ readOnly: true })) });
  assert.match(String(viewOnly.result.output['reason']), /view this deck but not change it/);
  const other = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, { ref: 'deck:idk-other' });
  assert.match(String(other.result.output['reason']), /Only the deck in view/);
  const wrongTenant = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, { tenant: 'assessment', allow: ['RunAssessmentAgent'] });
  assert.match(String(wrongTenant.result.output['reason']), /another workspace/);
  const noSlide = await update({ operations: [{ op: 'set_title', slide: '9', title: 'X' }] });
  assert.match(String(noSlide.result.output['reason']), /5 slides; there is no slide 9/);
  for (const r of [role, closed, unsaved, viewOnly, other, wrongTenant, noSlide]) assert.equal(writes(r.log).length, 0);
});

test('each deck tenant sends to its own deck route under its own write action', async () => {
  for (const [tenant, action, url] of [['assessment', 'RunAssessmentAgent', '/api/assessment/decks/d-1/operations'], ['pipelines', 'RunPipeline', '/api/pipelines/decks/d-1/operations'], ['social', 'PostMessage', '/api/chat/decks/d-1/operations']] as const) {
    const r = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, {
      tenant, allow: [action], page: () => page(deck({ tenant, id: 'd-1' })), routes: [route('POST', url, 201, OK)],
    });
    assert.equal(r.result.outcome, 'done', tenant);
    assert.equal(writes(r.log)[0]![0], url);
  }
});

test('a refused report is the server\'s sentence as the voice\'s one line', async () => {
  const r = await update({ operations: [{ op: 'set_chart', slide: '4', kind: 'pie', report: 'spend-by-initiative' }] }, {
    routes: [route('POST', '/api/initiative-decks/idk-1/operations', 403, { error: 'operation 1 (set_chart): spend-by-initiative needs the budgets read tier' })],
  });
  assert.equal(r.result.outcome, 'refused');
  assert.equal(r.result.output['reason'], 'The deck was not changed: operation 1 (set_chart): spend-by-initiative needs the budgets read tier.');
});

test('a stale head re-reads the page context once: a newer head on the page goes again on it; the same head is said, not retried', async () => {
  let reads = 0;
  const moving = () => { reads += 1; return page(deck({ headRevisionId: reads > 2 ? 'irev-8' : 'irev-7', viewedRevisionId: reads > 2 ? 'irev-8' : 'irev-7' })); };
  const sent: string[] = [];
  const routes: Route[] = [(req) => {
    if (req.method !== 'POST') return undefined;
    const base = (req.body as { baseRevisionId: string }).baseRevisionId;
    sent.push(base);
    return base === 'irev-8' ? { status: 201, body: OK } : { status: 409, body: { error: 'A newer version exists.', activeRevisionId: 'irev-8' } };
  }];
  let announced: unknown = null;
  const g = globalThis as unknown as { dispatchEvent?: (e: Event) => boolean };
  const prev = g.dispatchEvent;
  g.dispatchEvent = (e: Event) => { if (e.type === DECK_REVISED_EVENT) announced = (e as CustomEvent).detail; return true; };
  try {
    const r = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, { page: moving, routes });
    assert.deepEqual(sent, ['irev-7', 'irev-8']);
    assert.equal(r.result.outcome, 'done');
    assert.deepEqual(announced, { deckId: 'idk-1', revisionId: 'irev-9' });
  } finally { g.dispatchEvent = prev; }

  const stuck = await update({ operations: [{ op: 'set_theme', theme: 'plain' }] }, {
    routes: [route('POST', '/api/initiative-decks/idk-1/operations', 409, { error: 'A newer version exists.', activeRevisionId: 'irev-8' })],
  });
  assert.equal(stuck.result.outcome, 'refused');
  assert.equal(stuck.result.output['code'], 'stale-revision');
  assert.equal(writes(stuck.log).length, 1, 'sent once, not retried on the same head');
});

test('list: example decks per tenant through the templates read; a deck\'s chart reports only with a deck open', async () => {
  const templates = { templates: [{ id: 'status-update', title: 'Status update', description: 'A weekly status for leadership.', slideCount: 9, layouts: [], preview: [] }] };
  for (const [tenant, url, href] of [['orgiq', '/api/initiative-decks/deck-templates', '/iq/decks/new?template=status-update'], ['assessment', '/api/assessment/deck-templates', '/assessment/decks/new?template=status-update'], ['pipelines', '/api/pipelines/deck-templates', '/pipelines/decks/new?template=status-update'], ['social', '/api/chat/deck-templates', '/social/decks/new?template=status-update']] as const) {
    const { fetch, log } = fakeFetch([route('GET', url, 200, templates)]);
    const ctx = toolContext({ tenant, fetch });
    const p = prepareToolCall('list', { kind: 'deck-template' }, ctx);
    assert.ok(p.ok, tenant);
    const r = await runPreparedCall(p.call, ctx, VOICE_RUNNERS);
    assert.equal(r.outcome, 'done', tenant);
    assert.equal(log[0]!.url, url);
    assert.equal((r.output['rows'] as Array<{ title: string }>)[0]!.title, 'Status update');
    void href;
  }
  const reports = { reports: [{ id: 'runs-by-outcome', description: 'Run outcomes for the initiative.', params: [], money: false }] };
  const { fetch, log } = fakeFetch([route('GET', '/api/initiative-decks/idk-1/chart-reports', 200, reports)]);
  const open = toolContext({ tenant: 'orgiq', fetch, page: () => page() });
  const p = prepareToolCall('list', { kind: 'deck-report' }, open);
  assert.ok(p.ok);
  const r = await runPreparedCall(p.call, open, VOICE_RUNNERS);
  assert.equal(log[0]!.url, '/api/initiative-decks/idk-1/chart-reports');
  assert.equal((r.output['rows'] as Array<{ title: string }>)[0]!.title, 'runs-by-outcome');
  const none = toolContext({ tenant: 'orgiq', fetch, page: () => null });
  const q = prepareToolCall('list', { kind: 'deck-report' }, none);
  assert.ok(q.ok);
  assert.match(String((await runPreparedCall(q.call, none, VOICE_RUNNERS)).output['reason']), /Open a deck first/);
  const asCtx = toolContext({ tenant: 'assessment', fetch, page: () => page(deck({ tenant: 'assessment' })) });
  const elsewhere = prepareToolCall('list', { kind: 'deck-report' }, asCtx);
  assert.ok(elsewhere.ok);
  const refusedThere = await runPreparedCall(elsewhere.call, asCtx, VOICE_RUNNERS);
  assert.equal(refusedThere.outcome, 'refused', 'reports are orgiq\'s: other tenants have no such list');
});

test('open: "show me example slides" is the new-deck page or the open deck\'s layouts tab, never an image in the dock', async () => {
  const ctx = toolContext({ tenant: 'orgiq' });
  const p = prepareToolCall('open', { page: 'deck-templates' }, ctx);
  assert.ok(p.ok);
  const r = await runPreparedCall(p.call, ctx, VOICE_RUNNERS);
  assert.equal(r.outcome, 'done');
  assert.deepEqual(ctx.navigations, ['/iq/decks/new']);
  const onDeck = toolContext({ tenant: 'orgiq', page: () => page(), tabs: () => ({ path: '/iq/decks/idk-1', tabs: ['slides', 'layouts'], tab: 'slides' }) });
  const t = prepareToolCall('open', { scope: 'this-page', tab: 'layouts' }, onDeck);
  assert.ok(t.ok);
  const shown = await runPreparedCall(t.call, onDeck, VOICE_RUNNERS);
  assert.equal(shown.outcome, 'done');
  assert.deepEqual(onDeck.navigations, ['/iq/decks/idk-1?tab=layouts']);
  for (const tenant of ['assessment', 'pipelines', 'social'] as const) {
    const c = toolContext({ tenant, role: tenant === 'assessment' ? 'assessor' : tenant === 'pipelines' ? 'pipeline-author' : 'member' });
    const q = prepareToolCall('open', { page: 'deck-templates' }, c);
    assert.ok(q.ok, tenant);
    await runPreparedCall(q.call, c, VOICE_RUNNERS);
    assert.deepEqual(c.navigations, [`/${tenant}/decks/new`], tenant);
  }
});
