import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpProposalPrompt, forgetProposalDecks, keepProposalAnswer, noteWaitingProposals, proposalDeckOf, proposalPromptGeneration, setProposalDeckHidden } from '../proposalDeckState.ts';

function withStorage(fn: (store: Map<string, string>) => void, storage?: unknown): void {
  const store = new Map<string, string>();
  const g = globalThis as { sessionStorage?: unknown };
  const before = g.sessionStorage;
  g.sessionStorage = storage ?? { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  forgetProposalDecks();
  try { fn(store); } finally { g.sessionStorage = before; forgetProposalDecks(); }
}

test('what this tab set aside ("Not now", "Skip") survives a reload', () => {
  withStorage((store) => {
    keepProposalAnswer('call-1', 'p1:ask');
    assert.deepEqual(JSON.parse(store.get('assistant-proposal-kept:call-1') ?? '[]'), ['p1:ask']);
    forgetProposalDecks(); // a reload: memory is gone, the tab's storage is not
    assert.deepEqual([...proposalDeckOf('call-1').kept], ['p1:ask']);
    assert.deepEqual([...proposalDeckOf('call-2').kept], []);
  });
});

test('what a tab set aside under the key used before the rename is still read, and written under the new key', () => {
  withStorage((store) => {
    store.set('nova-proposal-kept:call-1', JSON.stringify(['p0:ask']));
    assert.deepEqual([...proposalDeckOf('call-1').kept], ['p0:ask']);
    keepProposalAnswer('call-1', 'p1:ask');
    assert.deepEqual(JSON.parse(store.get('assistant-proposal-kept:call-1') ?? '[]'), ['p0:ask', 'p1:ask']);
    assert.equal(store.get('nova-proposal-kept:call-1'), JSON.stringify(['p0:ask']));
  });
});

test('storage that refuses is only a lost convenience', () => {
  const refusing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  withStorage(() => {
    assert.doesNotThrow(() => keepProposalAnswer('call-1', 'p1:ask'));
    assert.deepEqual([...proposalDeckOf('call-1').kept], ['p1:ask']);
  }, refusing);
});

test('a NEW proposal waiting on you shows the deck again after Esc; one already seen does not', () => {
  withStorage(() => {
    noteWaitingProposals('call-1', ['p1']);
    setProposalDeckHidden('call-1', true);
    noteWaitingProposals('call-1', ['p1']);
    assert.equal(proposalDeckOf('call-1').hidden, true);
    noteWaitingProposals('call-1', ['p1', 'p2']);
    assert.equal(proposalDeckOf('call-1').hidden, false);
  });
});

test('taking back an answer gives the question a new generation, so the deck asks it again', () => {
  withStorage(() => {
    assert.equal(proposalPromptGeneration('call-1', 'p1'), 0);
    bumpProposalPrompt('call-1', 'p1');
    bumpProposalPrompt('call-1', 'p1');
    assert.equal(proposalPromptGeneration('call-1', 'p1'), 2);
    assert.equal(proposalPromptGeneration('call-1', 'p2'), 0);
  });
});
