// A refused deck call carries the server's sentence: the new-deck page's toast shows it (a 403 for someone not
// on the initiative says why), never an empty line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deckCall, DeckApiError } from '../deckApi.ts';

const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const SENTENCE = 'you can only build decks on initiatives you own or contribute to';

test('the 403 sentence reaches the error, whichever shape the server used', async () => {
  for (const body of [{ error: SENTENCE }, { error: { message: SENTENCE } }, { message: SENTENCE }, { error: '', reason: SENTENCE }]) {
    await assert.rejects(deckCall('/api/initiative-decks/projects/p-1', { method: 'POST', body: '{}' }, answer(403, body)),
      (err: unknown) => err instanceof DeckApiError && err.status === 403 && err.message === SENTENCE, JSON.stringify(body));
  }
});

test('a 403 with no sentence still says something', async () => {
  await assert.rejects(deckCall('/x', {}, answer(403, {})), (err: unknown) => err instanceof Error && err.message === 'You do not have permission for this action.');
});
