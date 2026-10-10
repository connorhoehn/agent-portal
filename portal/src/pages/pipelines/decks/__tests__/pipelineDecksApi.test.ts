// Run with: cd portal && node --test 'src/pages/pipelines/decks/__tests__/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeckRevisionConflictError, DeckApiError } from '../../../../components/decks/deckApi.ts';
import { createRunDeck, getReviseRun, narrativeNotice, reviseRunDeck, previewRunDeck, runDeckPaths, saveRunDeckRevision } from '../pipelineDecksApi.ts';

type Call = { url: string; init: RequestInit };
function stubFetch(status: number, body: unknown): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  return calls;
}
const SPEC = { title: 'T', slides: [] };

test('paths encode ids (run ids contain a colon) and the optional run filter', () => {
  assert.equal(runDeckPaths.create('job:abc 1'), '/api/pipelines/runs/job%3Aabc%201/decks');
  assert.equal(runDeckPaths.list(), '/api/pipelines/decks');
  assert.equal(runDeckPaths.list('job:1'), '/api/pipelines/decks?runId=job%3A1');
  assert.equal(runDeckPaths.file('d1', 'r1'), '/api/pipelines/decks/d1/revisions/r1/file');
  assert.equal(runDeckPaths.page('d/1'), '/pipelines/decks/d%2F1');
});

test('createRunDeck posts the narrative flag to the run route', async () => {
  const calls = stubFetch(201, { deckId: 'd1', revisionId: 'r1', narrative: { requested: true, status: 'applied', templatedSlideIds: [] } });
  const out = await createRunDeck('job:1', { narrative: true });
  assert.equal(out.deckId, 'd1');
  assert.equal(calls[0]!.url, '/api/pipelines/runs/job%3A1/decks');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { narrative: true });
  assert.equal(calls[0]!.init.credentials, 'include');
});

test('a stale base is a DeckRevisionConflictError naming the head; other failures are DeckApiError', async () => {
  stubFetch(409, { error: 'the deck has a newer revision', activeRevisionId: 'prev-9' });
  await assert.rejects(saveRunDeckRevision('d1', SPEC as never, 'prev-1'), (e: unknown) => e instanceof DeckRevisionConflictError && e.activeRevisionId === 'prev-9');
  stubFetch(403, {});
  await assert.rejects(saveRunDeckRevision('d1', SPEC as never, 'prev-1'), (e: unknown) => e instanceof DeckApiError && e.status === 403 && /permission/.test(e.message));
  stubFetch(400, { error: 'invalid DeckSpec', errors: ['a', 'b'] });
  await assert.rejects(previewRunDeck('d1', SPEC as never), /invalid DeckSpec: a; b/);
});

test('narrativeNotice says what happened, and nothing when none was asked', () => {
  assert.equal(narrativeNotice(undefined), null);
  assert.equal(narrativeNotice({ requested: false, status: 'none', templatedSlideIds: [] }), null);
  assert.match(narrativeNotice({ requested: true, status: 'partial', templatedSlideIds: ['summary'] })!, /1 kept template/);
  assert.match(narrativeNotice({ requested: true, status: 'unavailable', templatedSlideIds: [], reason: 'offline' })!, /offline/);
});

test('revise and run-read paths encode ids and live under the deck', () => {
  assert.equal(runDeckPaths.revise('d/1'), '/api/pipelines/decks/d%2F1/revise');
  assert.equal(runDeckPaths.run('d1', 'pdr-1'), '/api/pipelines/decks/d1/runs/pdr-1');
});

test('reviseRunDeck posts the instruction, slide and base; a stale base is a conflict naming the head, a locked slide a plain error', async () => {
  const calls = stubFetch(202, { runId: 'pdr-0f0e0d0c-0b0a-4908-8706-050403020100' });
  const out = await reviseRunDeck('d1', { instruction: 'Tighten', slideId: 'summary', baseRevisionId: 'prev-1' });
  assert.equal(out.runId, 'pdr-0f0e0d0c-0b0a-4908-8706-050403020100');
  assert.equal(calls[0]!.url, '/api/pipelines/decks/d1/revise');
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { instruction: 'Tighten', slideId: 'summary', baseRevisionId: 'prev-1' });
  stubFetch(409, { error: 'the deck has a newer revision', activeRevisionId: 'prev-9' });
  await assert.rejects(reviseRunDeck('d1', { instruction: 'x', baseRevisionId: 'prev-1' }),
    (e: unknown) => e instanceof DeckRevisionConflictError && e.activeRevisionId === 'prev-9');
  stubFetch(409, { error: 'slide summary is locked' });
  await assert.rejects(reviseRunDeck('d1', { instruction: 'x', baseRevisionId: 'prev-1' }),
    (e: unknown) => e instanceof DeckApiError && !(e instanceof DeckRevisionConflictError) && e.status === 409 && /locked/.test(e.message));
  stubFetch(403, {});
  await assert.rejects(reviseRunDeck('d1', { instruction: 'x', baseRevisionId: 'prev-1' }), (e: unknown) => e instanceof DeckApiError && e.status === 403);
});

test('getReviseRun reads the caller\'s run of this deck', async () => {
  const calls = stubFetch(200, { id: 'pdr-1', status: 'completed', summary: 'Saved revision 2.', error: null, changedSlideIds: ['summary'] });
  const run = await getReviseRun('d1', 'pdr-1');
  assert.deepEqual(run.changedSlideIds, ['summary']);
  assert.equal(calls[0]!.url, '/api/pipelines/decks/d1/runs/pdr-1');
  stubFetch(404, { error: 'run not found' });
  await assert.rejects(getReviseRun('d1', 'pdr-2'), (e: unknown) => e instanceof DeckApiError && e.status === 404);
});
