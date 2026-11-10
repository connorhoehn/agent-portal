// Regression walk, 9 November 2026 (night), defect D: fast typing in a composer whose host writes
// state per keystroke threw "Maximum update depth exceeded" from RichChatComposer's onUpdate, because
// the host handed the library a new `commands` array every render (lib/stableCommands.ts). The array
// now keeps its identity while its content does, and its functions still reach the latest render.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { commandsSignature, forwardToLatest } from '../stableCommands.ts';

const build = (agents: string[], disabled = false, seen: string[] = []) => [
  { trigger: '/agent', label: 'Ask a specific agent', modes: ['agent'],
    argument: { placeholder: 'Choose an agent', search: (q: string) => agents.filter((a) => a.includes(q)) },
    run: () => { seen.push(agents.join(',')); return true; } },
  { trigger: '/who-can-help', label: 'Who can help', disabled },
];

test('the same commands rebuilt on another render have the same signature', () => {
  assert.equal(commandsSignature(build(['search'])), commandsSignature(build(['search'])));
  assert.equal(commandsSignature(undefined), '');
});

test('a visible change (disabled, a label, a new command) changes the signature', () => {
  assert.notEqual(commandsSignature(build(['search'])), commandsSignature(build(['search'], true)));
  assert.notEqual(commandsSignature(build(['search'])), commandsSignature([...build(['search']), { trigger: '/x', label: 'X' }]));
  assert.notEqual(commandsSignature(build(['search'])), commandsSignature(build(['search']).map((c) => ({ ...c, label: `${c.label}!` }))));
});

test('a kept array calls the latest render\'s run and search, never the first one\'s', () => {
  const seen: string[] = [];
  const first = build(['search'], false, seen);
  let latest = first;
  const kept = forwardToLatest(first, () => latest);
  latest = build(['search', 'scoring'], false, seen);
  kept[0]!.run!(undefined as never);
  assert.deepEqual(seen, ['search,scoring']);
  assert.deepEqual(kept[0]!.argument!.search('scor'), ['scoring']);
  assert.equal(kept[1]!.run, undefined);
});

test('every composer host goes through the one wrapper that applies it', () => {
  const wrapper = readFileSync(new URL('../conversationComposer.ts', import.meta.url), 'utf8');
  assert.match(wrapper, /const commands = useStableCommands\(props\.commands\);/);
  assert.match(wrapper, /\.\.\.\(commands \? \{ commands \} : \{\}\),/);
});
