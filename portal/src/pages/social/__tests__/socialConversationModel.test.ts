// Run with:  cd portal && node --test 'src/pages/social/__tests__/*.test.ts'
//
// A conversation's composer never assumes its reader may post: `/agent` (which
// starts flows as the member) is offered only when the host says so.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationCommands } from '../socialConversationModel.ts';

const ALL = [{ trigger: '/summarize' }, { trigger: '/agent' }, { trigger: '/deck' }];
const triggers = (list: readonly { trigger: string }[]) => list.map((c) => c.trigger);

test('a host that says nothing, or says no, gets no /agent; only an explicit yes keeps it', () => {
  assert.deepEqual(triggers(conversationCommands(ALL, undefined)), ['/summarize', '/deck']);
  assert.deepEqual(triggers(conversationCommands(ALL, false)), ['/summarize', '/deck']);
  assert.deepEqual(triggers(conversationCommands(ALL, true)), ['/summarize', '/agent', '/deck']);
});
