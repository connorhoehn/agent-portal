// Run with: cd portal && node --test 'src/pages/projects/decks/__tests__/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeckRevisionConflictError, DeckApiError } from '../../../../components/decks/deckApi.ts';
import {
  DECK_FOCUS_MAX, cleanFocus, createInitiativeDeck, deckCreateBody, focusDetail, initiativeDeckPaths, narrativeNotice, previewInitiativeDeck, reviseInitiativeDeck, saveInitiativeDeckRevision, shareWithheldReason,
} from '../initiativeDecksApi.ts';

type Call = { url: string; init: RequestInit };
function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  return calls;
}
const SPEC = { title: 'T', slides: [] };

test('paths encode ids and the optional initiative filter; the page lives under /iq', () => {
  assert.equal(initiativeDeckPaths.create('p-auth migration'), '/api/initiative-decks/projects/p-auth%20migration');
  assert.equal(initiativeDeckPaths.list(), '/api/initiative-decks');
  assert.equal(initiativeDeckPaths.list('p-soc2'), '/api/initiative-decks?projectId=p-soc2');
  assert.equal(initiativeDeckPaths.file('d1', 'r1'), '/api/initiative-decks/d1/revisions/r1/file');
  assert.equal(initiativeDeckPaths.page('d/1'), '/iq/decks/d%2F1');
});

test('createInitiativeDeck posts the flags to the initiative route', async () => {
  const calls = stubFetch(201, { deckId: 'd1', revisionId: 'r1', includesBudget: false, narrative: { requested: true, status: 'applied', templatedSlideIds: [] } });
  const out = await createInitiativeDeck('p-soc2', { narrative: true, includeBudget: false });
  assert.equal(out.deckId, 'd1');
  assert.equal(calls[0]!.url, '/api/initiative-decks/projects/p-soc2');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { narrative: true, includeBudget: false });
  assert.equal(calls[0]!.init.credentials, 'include');
});

test('a stale base is a DeckRevisionConflictError naming the head; other failures are DeckApiError', async () => {
  stubFetch(409, { error: 'the deck has a newer revision', activeRevisionId: 'irev-9' });
  await assert.rejects(saveInitiativeDeckRevision('d1', SPEC as never, 'irev-1'), (e: unknown) => e instanceof DeckRevisionConflictError && e.activeRevisionId === 'irev-9');
  stubFetch(403, {});
  await assert.rejects(saveInitiativeDeckRevision('d1', SPEC as never, 'irev-1'), (e: unknown) => e instanceof DeckApiError && e.status === 403 && /permission/.test(e.message));
  stubFetch(404, { error: 'deck not found' });
  await assert.rejects(previewInitiativeDeck('d1', SPEC as never), (e: unknown) => e instanceof DeckApiError && e.status === 404);
  stubFetch(400, { error: 'invalid DeckSpec', errors: ['a', 'b'] });
  await assert.rejects(previewInitiativeDeck('d1', SPEC as never), /invalid DeckSpec: a; b/);
});

test('narrativeNotice says what happened, and nothing when none was asked', () => {
  assert.equal(narrativeNotice(undefined), null);
  assert.equal(narrativeNotice({ requested: false, status: 'none', templatedSlideIds: [] }), null);
  assert.match(narrativeNotice({ requested: true, status: 'partial', templatedSlideIds: ['summary'] })!, /1 kept template/);
  assert.match(narrativeNotice({ requested: true, status: 'unavailable', templatedSlideIds: [], reason: 'offline' })!, /offline/);
});

test('a deck with budget figures is never offered for sharing; one without is', () => {
  assert.match(shareWithheldReason({ includesBudget: true })!, /budget figures/);
  assert.equal(shareWithheldReason({ includesBudget: false }), null);
});

test('revise posts the instruction, the base and the request id to the deck, and returns the saved revision', async () => {
  assert.equal(initiativeDeckPaths.revise('d/1'), '/api/initiative-decks/d%2F1/revise');
  const calls = stubFetch(201, { revisionId: 'irev-2', summary: 'Done.', changedSlideIds: ['summary'], engine: 'offline', replayed: false });
  const out = await reviseInitiativeDeck('d1', { instruction: 'Add speaker notes', slideId: 'summary', baseRevisionId: 'irev-1', requestId: 'req-1' });
  assert.equal(out.revisionId, 'irev-2');
  assert.equal(calls[0]!.url, '/api/initiative-decks/d1/revise');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { instruction: 'Add speaker notes', slideId: 'summary', baseRevisionId: 'irev-1', requestId: 'req-1' });
});

test('revise: a stale base is a conflict naming the head; a refusal is a DeckApiError', async () => {
  stubFetch(409, { error: 'the deck has a newer revision', activeRevisionId: 'irev-9' });
  await assert.rejects(reviseInitiativeDeck('d1', { instruction: 'x', baseRevisionId: 'irev-1' }), (e: unknown) => e instanceof DeckRevisionConflictError && e.activeRevisionId === 'irev-9');
  stubFetch(403, {});
  await assert.rejects(reviseInitiativeDeck('d1', { instruction: 'x', baseRevisionId: 'irev-1' }), (e: unknown) => e instanceof DeckApiError && e.status === 403);
});

test('status deck dialog: reader/no deck, reader/with deck, builder/no deck', async () => {
  const { statusDeckDialogState } = await import('../initiativeDecksApi.ts');
  const r0 = statusDeckDialogState({ canBuild: false, deckCount: 0, projectName: 'Auth' });
  assert.equal(r0.showBuild, false); assert.equal(r0.primary, 'none');
  assert.match(r0.notice!, /read status decks but not build one/); assert.ok(r0.emptyText);
  const r1 = statusDeckDialogState({ canBuild: false, deckCount: 2, projectName: 'Auth' });
  assert.equal(r1.showBuild, false); assert.equal(r1.primary, 'open'); assert.ok(r1.notice); assert.equal(r1.emptyText, null);
  const b0 = statusDeckDialogState({ canBuild: true, deckCount: 0, projectName: 'Auth' });
  assert.equal(b0.showBuild, true); assert.equal(b0.primary, 'build'); assert.equal(b0.notice, null); assert.match(b0.emptyText!, /No status deck for Auth yet/);
});

test('G55: the dialog posts the focus as `brief` (what the voice path sends), turns the narrative on, and a blank focus changes nothing', async () => {
  assert.deepEqual(deckCreateBody({ title: '', narrative: false, includeBudget: true, focus: '' }), {});
  assert.deepEqual(deckCreateBody({ title: ' Q4 ', narrative: false, includeBudget: false, focus: '   ' }), { title: 'Q4', includeBudget: false });
  assert.deepEqual(deckCreateBody({ title: '', narrative: false, includeBudget: true, focus: ' progress\n this  past sprint ' }), { narrative: true, brief: 'progress this past sprint' });
  assert.equal(cleanFocus('x'.repeat(300))!.length, DECK_FOCUS_MAX);
  const calls = stubFetch(201, { deckId: 'd1', revisionId: 'r1', includesBudget: true, narrative: { requested: true, status: 'applied', templatedSlideIds: [] }, brief: { words: 'progress this past sprint', window: { sprintId: 's3', name: 'Sprint 3', startsOn: '2026-10-05', endsOn: '2026-10-16', status: 'done', which: 'last-ended' } } });
  const out = await createInitiativeDeck('p-soc2', deckCreateBody({ title: '', narrative: false, includeBudget: true, focus: 'progress this past sprint' }));
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { narrative: true, brief: 'progress this past sprint' });
  assert.equal(focusDetail(out.brief), 'Focus: Sprint 3 (2026-10-05 to 2026-10-16), the last ended sprint.');
});

test('G55: the created deck names the window when the route chose one, the words when none fit, nothing without a focus', () => {
  assert.equal(focusDetail(undefined), null);
  assert.equal(focusDetail(null), null);
  assert.match(focusDetail({ words: 'security work', window: null })!, /^Focus: “security work”\. No sprint window matched/);
  assert.match(focusDetail({ words: 'this sprint', window: { sprintId: 's4', name: 'Sprint 4', startsOn: null, endsOn: '2026-10-30', status: 'active', which: 'current' } })!, /Sprint 4 \(\? to 2026-10-30\), the current sprint/);
});
