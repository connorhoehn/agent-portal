// Run with:  cd portal && node --test 'src/components/chat/__tests__/commandFailure.test.ts'
// Every chat command's refusal reaches the thread's alert as the server's own sentence.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commandFailureMessage } from '../commandFailure.ts';
import { socialChatCommands } from '../chatCommandRegistry.ts';
import { socialSummarizeCommand } from '../../../pages/social/socialSummarize.ts';
import { socialDeckCommand } from '../../../pages/social/decks/socialDecksApi.ts';

const commands = socialChatCommands(socialSummarizeCommand, socialDeckCommand);
const ctx = (text: string, argumentText: string) => ({
  channel: 'social:ch:general', channelKind: 'room', user: { id: 'u-sana', displayName: 'Sana' }, idToken: null,
  sidePanel: { current: null, open: () => undefined, close: () => undefined }, text, argumentText,
}) as unknown as Parameters<(typeof commands)[number]['run']>[0];

const refused = (error: string) => (async () => ({ ok: false, status: 400, json: async () => ({ error }), text: async () => JSON.stringify({ error }) })) as unknown as typeof fetch;

test('the registry offers all five commands', () => {
  assert.deepEqual(commands.map(c => c.trigger), ['/summarize', '/deck', '/diagram', '/doc', '/agent']);
});

for (const trigger of ['/summarize', '/deck', '/diagram', '/doc', '/agent']) {
  test(`${trigger}: a refused start throws the server's sentence, and the alert shows it`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = refused(`${trigger} needs a clearer request.`);
    try {
      const command = commands.find(c => c.trigger === trigger)!;
      const failure = await command.run(ctx(`${trigger} last banana`, 'last banana')).then(() => null, (e: unknown) => e);
      assert.ok(failure, 'run must reject, not resolve silently');
      assert.equal(commandFailureMessage(trigger, failure), `${trigger} needs a clearer request.`);
    } finally { globalThis.fetch = original; }
  });
}

test('an error with no text falls back to a sentence naming the command', () => {
  assert.equal(commandFailureMessage('/summarize', new Error('')), '/summarize could not be started.');
  assert.equal(commandFailureMessage('/deck', undefined), '/deck could not be started.');
  assert.equal(commandFailureMessage('/doc', 'Too long'), 'Too long');
});
