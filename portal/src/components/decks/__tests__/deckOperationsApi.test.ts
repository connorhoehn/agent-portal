// The deck operations client (docs/deck-edit-operations.md): each tenant's routes, the body, the refusals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeckOperations, DeckApiError, DeckRevisionConflictError, deckOpPaths, layoutPreviewMap, reportTakesPeriod } from '../deckApi.ts';

test('every tenant has its own operations, chart reports, templates and layouts routes', () => {
  assert.equal(deckOpPaths.operations('orgiq', 'idk 1'), '/api/initiative-decks/idk%201/operations');
  assert.equal(deckOpPaths.chartReports('assessment', 'd1'), '/api/assessment/decks/d1/chart-reports');
  assert.equal(deckOpPaths.templates('pipelines'), '/api/pipelines/deck-templates');
  assert.equal(deckOpPaths.layouts('social'), '/api/chat/deck-layouts');
});

test('the layout previews keep only layouts with an example picture; a report takes a period only when it says so', () => {
  assert.deepEqual(layoutPreviewMap([{ layout: 'chart', useFor: 'x', example: { templateId: 't', slideId: 's', svg: '<svg/>' } }, { layout: 'quote', useFor: 'y', example: null }]), { chart: '<svg/>' });
  assert.equal(reportTakesPeriod({ id: 'spend-by-initiative', description: '', params: [{ name: 'period' }] }), true);
  assert.equal(reportTakesPeriod({ id: 'jobs-by-status', description: '', params: [] }), false);
});

test('apply posts the base and the operations; a stale base is a conflict; a refusal keeps the server\'s sentence', async () => {
  const orig = globalThis.fetch;
  const sent: unknown[] = [];
  try {
    globalThis.fetch = (async (url: string, init: RequestInit) => { sent.push([url, JSON.parse(String(init.body))]); return new Response(JSON.stringify({ revision: { id: 'r2' }, touchedSlideIds: [], findings: [], summary: 'ok', exampleSourceSlideIds: [] }), { status: 201 }); }) as typeof fetch;
    const out = await applyDeckOperations('orgiq', 'd1', { baseRevisionId: 'r1', operations: [{ op: 'set_theme', theme: 'plain' }] });
    assert.equal(out.revision.id, 'r2');
    assert.deepEqual(sent, [['/api/initiative-decks/d1/operations', { baseRevisionId: 'r1', operations: [{ op: 'set_theme', theme: 'plain' }] }]]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'A newer version exists.', activeRevisionId: 'r3' }), { status: 409 })) as typeof fetch;
    await assert.rejects(applyDeckOperations('orgiq', 'd1', { baseRevisionId: 'r1', operations: [] }), (e: unknown) => e instanceof DeckRevisionConflictError && e.activeRevisionId === 'r3');
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'operation 1 (set_chart): spend-by-initiative needs the budgets read tier' }), { status: 403 })) as typeof fetch;
    await assert.rejects(applyDeckOperations('orgiq', 'd1', { baseRevisionId: 'r1', operations: [] }), (e: unknown) => e instanceof DeckApiError && e.status === 403 && /budgets read tier/.test(e.message));
  } finally { globalThis.fetch = orig; }
});

test('filling a chart from a report says the slide is renamed, on the panel and on the voice card', async () => {
  const { reportTitleNote, reportRenameClause } = await import('../deckApi.ts');
  assert.equal(reportTitleNote('Depots live by week', 'spend-by-initiative', '30d'), 'The slide\'s title "Depots live by week" becomes "Spend by initiative, the last 30 days".');
  assert.equal(reportTitleNote('Spend by initiative, this month', 'spend-by-initiative'), 'The slide keeps its title, "Spend by initiative, this month".');
  assert.equal(reportTitleNote('Plan', 'runs-by-outcome'), 'The slide\'s title "Plan" becomes the report\'s title.');
  assert.equal(reportRenameClause('Depots live by week', 'jobs-by-status'), ', renaming it from "Depots live by week" to "Agent jobs by status"');
  assert.equal(reportRenameClause('', 'jobs-by-status'), ', titling it "Agent jobs by status"');
});
