// Run with: cd portal && node --test 'src/pages/social/decks/__tests__/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DeckApiError, DeckRevisionConflictError } from '../../../../components/decks/deckApi.ts';
import {
  canSave, deckRunStatusOf, fetchDeckFile, fetchDeckStatus, narrativeNotice, pollDelayMs, postMetadata, requestDeckPost, saveDeckRun,
  reviseSocialDeck, saveSocialDeckRevision, savedDeckId, socialDeckCommand, socialDeckPaths, startDeck, wantsPreview, type DeckRunStatus,
} from '../socialDecksApi.ts';

type Call = { url: string; init: RequestInit };
function stub(status: number, body: unknown): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
  return { calls, fetch: fetchStub };
}
const status = (over: Partial<DeckRunStatus> = {}): DeckRunStatus => ({
  runId: 'sdk-1', channel: 'social:ch:general', phase: 'completed', steps: [], error: null, preview: false, deckId: null, result: null, ...over,
});
const RESULT = { title: 'T', deckId: null, preview: true, spec: { title: 'T', slides: [] }, slides: [], warnings: [],
  narrative: { status: 'applied' as const, templatedSlideIds: [] }, messageCount: 3, pages: [], sourceMessageIds: [] };

test('paths encode ids and live under /api/chat', () => {
  assert.equal(socialDeckPaths.run, '/api/chat/commands/deck/run');
  assert.equal(socialDeckPaths.status('sdk-a b'), '/api/chat/commands/deck/runs/sdk-a%20b');
  assert.equal(socialDeckPaths.saveRun('sdk-1'), '/api/chat/commands/deck/runs/sdk-1/save');
  assert.equal(socialDeckPaths.file('d1', 'r1'), '/api/chat/decks/d1/revisions/r1/file');
  assert.equal(socialDeckPaths.post('d/1'), '/api/chat/decks/d%2F1/post');
  assert.equal(socialDeckPaths.page('d1'), '/social/decks/d1');
  assert.equal(socialDeckPaths.list('social:ch:x'), '/api/chat/decks?channel=social%3Ach%3Ax');
});

test('startDeck posts the channel and the raw command text with credentials', async () => {
  const s = stub(202, { runId: 'sdk-1', pipelineId: 'conversation-deck', card: {} });
  const out = await startDeck('social:ch:general', 'Review --preview', s.fetch);
  assert.equal(out.runId, 'sdk-1');
  assert.equal(s.calls[0]!.url, '/api/chat/commands/deck/run');
  assert.deepEqual(JSON.parse(String(s.calls[0]!.init.body)), { channel: 'social:ch:general', text: 'Review --preview' });
  assert.equal(s.calls[0]!.init.credentials, 'include');
});

test('the command is a private run, not a message', async () => {
  const s = stub(202, { runId: 'sdk-9', pipelineId: 'conversation-deck', card: { kind: 'agent-run' } });
  const prior = globalThis.fetch; globalThis.fetch = s.fetch;
  try {
    const outcome = await socialDeckCommand.run({ channel: 'social:ch:general', argumentText: 'x', text: '/deck x' } as never);
    assert.deepEqual(outcome, { kind: 'run', runId: 'sdk-9', pipelineId: 'conversation-deck', card: { kind: 'agent-run' }, echo: '/deck x', visibility: 'private' });
  } finally { globalThis.fetch = prior; }
  assert.equal(socialDeckCommand.trigger, '/deck');
});

test('errors carry the server\'s words; a stale save is a conflict carrying the head', async () => {
  await assert.rejects(startDeck('c', '', stub(422, { error: 'There are no messages you can read' }).fetch), (e: unknown) => e instanceof DeckApiError && e.status === 422 && /no messages/.test(e.message));
  await assert.rejects(saveDeckRun('sdk-1', stub(403, {}).fetch), /permission/);
  const prior = globalThis.fetch;
  globalThis.fetch = stub(409, { error: 'newer', activeRevisionId: 'srev-9' }).fetch;
  try {
    await assert.rejects(saveSocialDeckRevision('d1', { title: 't', slides: [] }, 'srev-1'), (e: unknown) => e instanceof DeckRevisionConflictError && e.activeRevisionId === 'srev-9');
  } finally { globalThis.fetch = prior; }
});

test('status, save and post are plain requests to their routes', async () => {
  const s = stub(200, { runId: 'sdk-1' });
  await fetchDeckStatus('sdk-1', undefined, s.fetch);
  await saveDeckRun('sdk-1', s.fetch);
  await requestDeckPost('sdeck-1', s.fetch);
  assert.deepEqual(s.calls.map(c => [c.init.method ?? 'GET', c.url]), [
    ['GET', '/api/chat/commands/deck/runs/sdk-1'], ['POST', '/api/chat/commands/deck/runs/sdk-1/save'], ['POST', '/api/chat/decks/sdeck-1/post'],
  ]);
  assert.equal(s.calls[1]!.init.body, undefined);
});

test('Save is offered only for a finished preview with no stored deck; Open/Post only once a deck exists', () => {
  assert.equal(canSave(status({ preview: true, result: RESULT })), true);
  assert.equal(canSave(status({ preview: true, result: RESULT, deckId: 'sdeck-1' })), false);
  assert.equal(canSave(status({ preview: false, result: RESULT })), false);
  assert.equal(canSave(status({ preview: true, phase: 'running', result: RESULT })), false);
  assert.equal(canSave(status({ preview: true, phase: 'failed', result: null })), false);
  assert.equal(savedDeckId(status({ preview: true, result: RESULT })), null);
  assert.equal(savedDeckId(status({ deckId: 'sdeck-1' })), 'sdeck-1');
  assert.equal(savedDeckId(status({ phase: 'running', deckId: 'sdeck-1' })), null);
});

test('--preview is recognised anywhere and case-insensitively', () => {
  assert.equal(wantsPreview('Review --preview'), true);
  assert.equal(wantsPreview('--PREVIEW Review'), true);
  assert.equal(wantsPreview('Review the preview'), false);
});

test('the run card status mirrors steps, failure and the running step', () => {
  const s = deckRunStatusOf(status({ phase: 'running', steps: [{ id: 'a', label: 'Read', status: 'completed' }, { id: 'b', label: 'Write', status: 'running' }] }));
  assert.equal(s.phase, 'running');
  assert.equal(s.stepLabel, 'Write');
  assert.equal(deckRunStatusOf(status({ phase: 'failed', error: 'boom' })).detail, 'boom');
});

test('narrative notices say what Nova did', () => {
  assert.match(narrativeNotice({ status: 'applied', templatedSlideIds: [] })!, /every quote is a message/);
  assert.match(narrativeNotice({ status: 'partial', templatedSlideIds: ['a', 'b'] })!, /2 kept plain quotes/);
  assert.match(narrativeNotice({ status: 'unavailable', templatedSlideIds: [], reason: 'offline' })!, /offline/);
  assert.equal(narrativeNotice({ status: 'none', templatedSlideIds: [] }), null);
  assert.equal(narrativeNotice(undefined), null);
});

test('the deck file is read through the BFF and a lost deck says so', async () => {
  const ok = await fetchDeckFile({ fileUrl: '/api/chat/decks/d/revisions/r/file', fileName: 'deck-v1.pptx' },
    (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch);
  assert.equal(ok.name, 'deck-v1.pptx');
  assert.match(ok.type, /presentationml/);
  assert.equal(ok.size, 3);
  await assert.rejects(fetchDeckFile({ fileUrl: 'x', fileName: 'y.pptx' }, (async () => new Response('', { status: 404 })) as typeof fetch), /no longer open/);
});

test('post metadata keeps the BFF\'s sourceDeck, the upload and the sender name', () => {
  const meta = postMetadata({ channel: 'c', deckId: 'd', revisionId: 'r', fileName: 'f.pptx', fileUrl: 'u', text: 't', metadata: { sourceDeck: { id: 'd', revisionId: 'r' } } },
    { attachments: [{ id: 'a1' }] }, 'Sana');
  assert.deepEqual(meta, { displayName: 'Sana', attachments: [{ id: 'a1' }], sourceDeck: { id: 'd', revisionId: 'r' } });
});

test('poll delay backs off to a cap', () => {
  assert.equal(pollDelayMs(0), 400);
  assert.equal(pollDelayMs(100), 2500);
});

test('revise posts to the deck under /api/chat and returns the saved revision', async () => {
  assert.equal(socialDeckPaths.revise('sdeck-1'), '/api/chat/decks/sdeck-1/revise');
  const prior = globalThis.fetch;
  const s = stub(201, { revisionId: 'srev-2', summary: 'Done.', changedSlideIds: ['overview'], engine: 'offline', replayed: false });
  globalThis.fetch = s.fetch;
  try {
    const out = await reviseSocialDeck('sdeck-1', { instruction: 'Add speaker notes', baseRevisionId: 'srev-1', requestId: 'req-1' });
    assert.equal(out.revisionId, 'srev-2');
    assert.equal(s.calls[0]!.url, '/api/chat/decks/sdeck-1/revise');
    assert.deepEqual(JSON.parse(String(s.calls[0]!.init.body)), { instruction: 'Add speaker notes', baseRevisionId: 'srev-1', requestId: 'req-1' });
    globalThis.fetch = stub(409, { error: 'the deck has a newer revision', activeRevisionId: 'srev-9' }).fetch;
    await assert.rejects(reviseSocialDeck('sdeck-1', { instruction: 'x', baseRevisionId: 'srev-1' }), (e: unknown) => e instanceof DeckRevisionConflictError && e.activeRevisionId === 'srev-9');
    globalThis.fetch = stub(403, { error: 'Only the person who built this deck can edit it' }).fetch;
    await assert.rejects(reviseSocialDeck('sdeck-1', { instruction: 'x', baseRevisionId: 'srev-1' }), (e: unknown) => e instanceof DeckApiError && e.status === 403);
  } finally { globalThis.fetch = prior; }
});
