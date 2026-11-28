// The composer's proposal (DeckComposer + deckProposal.ts): the route, the card's words, a refusal said plainly,
// and Apply sending the proposed operations unchanged on the head they were checked on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDeckOperations, deckOpPaths, proposeDeckOperations, type DeckOperationsProposal } from '../deckApi.ts';
import { proposalDetail, proposalOutcome, proposalTitle } from '../deckProposal.ts';

const base: DeckOperationsProposal = {
  reply: 'Changing slide 3 to a KPI slide.', baseRevisionId: 'r1', operations: [{ op: 'remove_slide', slideId: 's3' }],
  lines: ['Change slide 3 from bullets to kpi'], destructive: false, touchedSlideIds: ['s3'], findings: [], engine: 'agent',
};

test('every tenant has a proposal route beside its operations route', () => {
  assert.equal(deckOpPaths.proposal('orgiq', 'd 1'), '/api/initiative-decks/d%201/operations/proposal');
  assert.equal(deckOpPaths.proposal('social', 'd1'), '/api/chat/decks/d1/operations/proposal');
});

test('a proposal shows as a card in the voice card\'s words; a removal says it waits for Apply', () => {
  assert.deepEqual(proposalOutcome(base), { kind: 'card', status: 'Changing slide 3 to a KPI slide.' });
  assert.equal(proposalTitle('Q3 "steering"'), 'Change "Q3 \'steering\'"');
  assert.deepEqual(proposalDetail(base), ['Change slide 3 from bullets to kpi.', 'It saves a new version; the current one stays in the history.']);
  assert.ok(proposalDetail({ ...base, destructive: true }).includes('This removes a slide. Nothing is removed until you click Apply.'));
});

test('a refused list shows the plain reason and no card; an empty one just the reply', () => {
  const refused = proposalOutcome({ ...base, lines: [], refusal: { reason: 'operation 1 (remove_slide): slide s3 is locked' } });
  assert.equal(refused.kind, 'refused');
  assert.match(refused.status, /^Changing slide 3 to a KPI slide\. Nothing can be applied: /);
  assert.deepEqual(proposalOutcome({ ...base, operations: [], lines: [], reply: 'Use Edit to reword it.' }), { kind: 'nothing', status: 'Use Edit to reword it.' });
});

test('propose posts the instruction on the head; Apply sends the same operations on the same base', async () => {
  const orig = globalThis.fetch;
  const sent: unknown[] = [];
  try {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push([url, JSON.parse(String(init.body))]);
      return url.endsWith('/proposal')
        ? new Response(JSON.stringify(base), { status: 200 })
        : new Response(JSON.stringify({ revision: { id: 'r2' }, touchedSlideIds: [], findings: [], summary: 'Removed slide 3.', exampleSourceSlideIds: [] }), { status: 201 });
    }) as typeof fetch;
    const p = await proposeDeckOperations('orgiq', 'd1', { baseRevisionId: 'r1', instruction: 'remove slide 3', slideId: 's3' });
    const out = await applyDeckOperations('orgiq', 'd1', { baseRevisionId: p.baseRevisionId, operations: p.operations });
    assert.equal(out.revision.id, 'r2');
    assert.deepEqual(sent, [
      ['/api/initiative-decks/d1/operations/proposal', { baseRevisionId: 'r1', instruction: 'remove slide 3', slideId: 's3' }],
      ['/api/initiative-decks/d1/operations', { baseRevisionId: 'r1', operations: [{ op: 'remove_slide', slideId: 's3' }] }],
    ]);
  } finally { globalThis.fetch = orig; }
});
