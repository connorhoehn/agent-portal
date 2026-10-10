// Run with:  cd portal && node --test 'src/components/chat/__tests__/tenantDeck.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deckRefusal, parseTenantDeckText, tenantDeckAdapterOf, tenantDeckCommand } from '../tenantDeck.ts';
import { CONVERSATION_CHAT_COMMANDS, socialChatCommands } from '../chatCommandRegistry.ts';

test('/deck is routed per tenant by the channel, and nowhere else', () => {
  const initiative = tenantDeckAdapterOf('orgiq:initiative:p-auth-migration');
  assert.equal(initiative?.tenant, 'orgiq');
  assert.equal(initiative?.action, 'DispatchAgentRun');
  assert.equal(initiative?.page('d1'), '/iq/decks/d1');
  const run = tenantDeckAdapterOf('pipelines:run:r-9');
  assert.equal(run?.tenant, 'pipelines');
  assert.equal(run?.action, 'RunPipeline');
  assert.equal(run?.page('d1'), '/pipelines/decks/d1');
  assert.equal(tenantDeckAdapterOf('pipelines:run:agent-run:79eed77e')?.targetId, 'agent-run:79eed77e');
  for (const other of ['orgiq:work:w1', 'pipelines:def:x', 'social:ch:general', 'assessment:team:t1', 'orgiq:initiative:a:b', '', null]) {
    assert.equal(tenantDeckAdapterOf(other), null, String(other));
  }
});

test('the library grammar: prompt is the title, --preview is read anywhere, #page tokens are dropped, --from is refused', () => {
  assert.deepEqual(parseTenantDeckText(''), { preview: false });
  assert.deepEqual(parseTenantDeckText('Q4 status --preview'), { title: 'Q4 status', preview: true });
  assert.deepEqual(parseTenantDeckText('--preview Q4 #initiative:p-1 status'), { title: 'Q4 status', preview: true });
  assert.match(String(parseTenantDeckText('--from transcript')), /--from does not apply/);
});

test('a reader is refused with the reason, before any request', async () => {
  const ctx = { channel: 'orgiq:initiative:p-1', text: '/deck', argumentText: '', deckWriter: false } as never;
  await assert.rejects(() => tenantDeckCommand.run(ctx), /cannot build an initiative status deck/);
  await assert.rejects(() => tenantDeckCommand.run({ ...(ctx as object), channel: 'pipelines:run:r1' } as never), /cannot build a run report deck/);
  await assert.rejects(() => tenantDeckCommand.run({ ...(ctx as object), channel: 'orgiq:work:w1', deckWriter: true } as never), /not available/);
  assert.match(deckRefusal(tenantDeckAdapterOf('pipelines:run:r1')!), /run pipelines/);
});

test('the registry offers /deck to tenant conversations; Social keeps its own', () => {
  assert.ok(CONVERSATION_CHAT_COMMANDS.includes(tenantDeckCommand));
  assert.equal(CONVERSATION_CHAT_COMMANDS.filter(c => c.trigger === '/deck').length, 1);
  const social = socialChatCommands(CONVERSATION_CHAT_COMMANDS[0]!, { ...tenantDeckCommand, label: 'social' });
  assert.ok(!social.includes(tenantDeckCommand));
});

import { buildTenantDeckFromText, isDeckCommand } from '../tenantDeckCompose.ts';

test('the dock composer path: recognises /deck, refuses readers and unsupported pages without a request', async () => {
  assert.ok(isDeckCommand('/deck Q4') && isDeckCommand(' /DECK') && !isDeckCommand('/decker') && !isDeckCommand('deck'));
  assert.match(String(await buildTenantDeckFromText('orgiq:initiative:p-1', '/deck', false)), /cannot build an initiative status deck/);
  assert.match(String(await buildTenantDeckFromText('orgiq:work:w1', '/deck', true)), /not available/);
  assert.match(String(await buildTenantDeckFromText('orgiq:initiative:p-1', '/deck --from transcript', true)), /--from does not apply/);
});
