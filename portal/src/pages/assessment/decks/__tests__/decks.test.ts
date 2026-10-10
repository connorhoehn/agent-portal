// Run with: cd portal && node --test 'src/pages/assessment/decks/__tests__/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DeckApiError, DeckRevisionConflictError, createDeck, deckPaths, getDeck, listDecks, reviseDeck, saveRevision,
} from '../decksApi.ts';
import {
  deckFileName, deckReadOnly, failedLastRun, revisionSeq, deckRenderKey, generatingIds, openRevisionId, runProgressLabel, toEditorRevisions,
} from '../../../../components/decks/decksModel.ts';

type Call = { url: string; init: RequestInit };
function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return calls;
}

test('paths encode ids and the optional team filter', () => {
  assert.equal(deckPaths.list(), '/api/assessment/decks');
  assert.equal(deckPaths.list('a b'), '/api/assessment/decks?teamId=a%20b');
  assert.equal(deckPaths.file('d/1', 'r1'), '/api/assessment/decks/d%2F1/revisions/r1/file');
});

test('createDeck posts the body to the team route', async () => {
  const calls = stubFetch(202, { deckId: 'd1', runId: 'r1' });
  assert.deepEqual(await createDeck('t1', { title: 'T', dimensionIds: ['1'] }), { deckId: 'd1', runId: 'r1' });
  assert.equal(calls[0]!.url, '/api/assessment/teams/t1/decks');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { title: 'T', dimensionIds: ['1'] });
});

test('reads use GET with credentials', async () => {
  const calls = stubFetch(200, []);
  await listDecks('t1');
  await getDeck('d1').catch(() => undefined);
  assert.equal(calls[0]!.url, '/api/assessment/decks?teamId=t1');
  assert.equal(calls[0]!.init.credentials, 'include');
  assert.equal(calls[0]!.init.method, undefined);
});

test('a stale base on save is a revision conflict carrying the server message', async () => {
  stubFetch(409, { error: 'stale base', activeRevisionId: 'rev-9' });
  await assert.rejects(
    saveRevision('d1', { title: 't', slides: [] }, 'r1'),
    (err) => err instanceof DeckRevisionConflictError && err.status === 409 && err.message === 'stale base' && err.activeRevisionId === 'rev-9',
  );
});

test('a stale base on revise is a conflict too; a locked-slide 409 is not', async () => {
  stubFetch(409, { error: 'the deck has a newer revision', activeRevisionId: 'rev-2' });
  await assert.rejects(reviseDeck('d1', { instruction: 'x', baseRevisionId: 'r1' }), (e) => e instanceof DeckRevisionConflictError);
  stubFetch(409, { error: 'slide s1 is locked' });
  await assert.rejects(reviseDeck('d1', { instruction: 'x', baseRevisionId: 'r1' }),
    (e) => e instanceof DeckApiError && !(e instanceof DeckRevisionConflictError));
});

test('a 400 lists the validation errors', async () => {
  stubFetch(400, { error: 'invalid DeckSpec', errors: ['slides[0].id missing', 'title empty'] });
  await assert.rejects(saveRevision('d1', { title: '', slides: [] }, 'r1'),
    (e) => e instanceof DeckApiError && e.message === 'invalid DeckSpec: slides[0].id missing; title empty');
});

test('saveRevision sends locked slide ids and label when given', async () => {
  const calls = stubFetch(201, { id: 'rev-1', label: 'L', createdAt: '', producedBy: 'person:x' });
  await saveRevision('d1', { title: 't', slides: [] }, 'r0', { lockedSlideIds: ['a'], label: 'L' });
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { spec: { title: 't', slides: [] }, baseRevisionId: 'r0', lockedSlideIds: ['a'], label: 'L' });
});

test('other failures are DeckApiError with the server message, 403 has a default', async () => {
  stubFetch(403, {});
  await assert.rejects(reviseDeck('d1', { instruction: 'x', baseRevisionId: 'r1' }), (err) =>
    err instanceof DeckApiError && !(err instanceof DeckRevisionConflictError) && /permission/.test(err.message));
});

test('openRevisionId prefers the active revision, falls back to the newest (first: newest first)', () => {
  const revisions = [{ id: 'b', label: 'v2', createdAt: '', producedBy: 'x' }, { id: 'a', label: 'v1', createdAt: '', producedBy: 'x' }];
  assert.equal(openRevisionId({ revisions, activeRevisionId: 'a' }), 'a');
  assert.equal(openRevisionId({ revisions, activeRevisionId: 'gone' }), 'b');
  assert.equal(openRevisionId({ revisions: [], activeRevisionId: null }), null);
});

test('toEditorRevisions formats createdAt through the host formatter', () => {
  assert.deepEqual(toEditorRevisions([{ id: 'a', label: 'v1', createdAt: 'T', producedBy: 'x' }], (s) => `<${s}>`), [{ id: 'a', label: 'v1', createdAt: '<T>' }]);
});

test('notes text does not change the render key, having notes does', () => {
  const slide = { id: 's', layout: 'content', title: 'x', sources: [] } as never;
  const base = { title: 't', slides: [{ ...(slide as object), notes: 'a' }] } as never;
  const edited = { title: 't', slides: [{ ...(slide as object), notes: 'b' }] } as never;
  const none = { title: 't', slides: [{ ...(slide as object), notes: '' }] } as never;
  assert.equal(deckRenderKey(base), deckRenderKey(edited));
  assert.notEqual(deckRenderKey(base), deckRenderKey(none));
});

test('generatingIds scopes to one slide or the whole deck, and only while running', () => {
  const spec = { title: 't', slides: [{ id: 'a' }, { id: 'b' }] } as never;
  assert.deepEqual(generatingIds(spec, 'a', true), ['a']);
  assert.deepEqual(generatingIds(spec, undefined, true), ['a', 'b']);
  assert.deepEqual(generatingIds(spec, 'a', false), []);
});

test('runProgressLabel and deckFileName and deckReadOnly', () => {
  assert.equal(runProgressLabel(null), 'Starting…');
  assert.equal(runProgressLabel({ status: 'running', progress: { phase: 'Drafting', detail: '3 of 9' } }), 'Drafting — 3 of 9');
  assert.equal(deckFileName('Team A: Review', 2), 'team-a-review-v2.pptx');
  assert.equal(deckFileName('!!!', 1), 'review-deck-v1.pptx');
  const revs = [{ id: 'c' }, { id: 'b' }, { id: 'a' }] as never;
  assert.equal(revisionSeq(revs, 'c'), 3);
  assert.equal(revisionSeq(revs, 'a'), 1);
  const failed = { runId: 'r', command: 'revise-review-deck', status: 'failed', summary: '', error: 'boom' };
  assert.equal(failedLastRun({ lastRun: failed }), failed);
  assert.equal(failedLastRun({ lastRun: failed, pendingRun: { ...failed, status: 'running' } }), null);
  assert.equal(failedLastRun({ lastRun: { ...failed, status: 'completed' } }), null);
  assert.equal(deckReadOnly((a) => a === 'RunAssessmentAgent'), false);
  assert.equal(deckReadOnly(() => false), true);
});

import { deckSourceOptions } from '../../../../components/decks/decksModel.ts';

test('deckSourceOptions lists each cited document once', () => {
  const spec = { title: 't', slides: [
    { id: 'a', sources: [{ documentId: 'x', title: 'X' }, { documentId: 'y', title: 'Y' }] },
    { id: 'b', sources: [{ documentId: 'x', title: 'X' }] },
    { id: 'c' },
  ] } as never;
  assert.deepEqual(deckSourceOptions(spec).map((o) => o.documentId), ['x', 'y']);
  assert.deepEqual(deckSourceOptions(null), []);
});
