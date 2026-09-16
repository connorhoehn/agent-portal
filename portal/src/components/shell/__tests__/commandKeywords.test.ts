// The palette showed 67 of its 73 entries a hint the user could not search
// for. These are about that: the words on screen are the words that match.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commandKeywords, hintKeywords } from '../commandKeywords.ts';

test('a hint contributes its substantive words', () => {
  assert.deepEqual(
    hintKeywords('Epics, stories, decisions and contributors'),
    ['epics', 'stories', 'decisions', 'contributors'],
  );
});

test('stopwords and short tokens are dropped', () => {
  // "and" is a stopword; "+" and "a" are below the length floor.
  assert.deepEqual(hintKeywords('MicroVM fleet + task runner'), ['microvm', 'fleet', 'task', 'runner']);
  assert.deepEqual(hintKeywords('What is deployed and what it cost'), ['deployed', 'cost']);
});

test('no hint yields no keywords, and neither does punctuation alone', () => {
  assert.deepEqual(hintKeywords(undefined), []);
  assert.deepEqual(hintKeywords(''), []);
  assert.deepEqual(hintKeywords('· — / +'), []);
});

test('repeats within a hint appear once', () => {
  assert.deepEqual(hintKeywords('runs, runs and more runs'), ['runs', 'more']);
});

test('the path and the authored synonyms lead, in that order', () => {
  const kw = commandKeywords('/iq/projects', 'Initiatives', ['initiative', 'program'], undefined);
  assert.deepEqual(kw, ['/iq/projects', 'initiative', 'program']);
});

test('hint words are appended after the authored synonyms', () => {
  const kw = commandKeywords('/iq/projects', 'Initiatives', ['program'], 'Epics and stories');
  assert.deepEqual(kw, ['/iq/projects', 'program', 'epics', 'stories']);
});

test('a hint word already in the label, path or synonyms is not repeated', () => {
  // "fleet" is an authored synonym, "agents" is in the path, "architecture"
  // is the label — only "connects" is new.
  const kw = commandKeywords(
    '/iq/agents',
    'Architecture',
    ['fleet'],
    'The agent fleet architecture and how it connects',
  );
  assert.deepEqual(kw, ['/iq/agents', 'fleet', 'agent', 'connects']);
});

test('a command with no hint and no synonyms still carries its path', () => {
  assert.deepEqual(commandKeywords('/iq/ask', 'Ask', undefined, undefined), ['/iq/ask']);
});

test('the words a reader sees really do end up searchable', () => {
  // The concrete regression: typing "epics" found nothing, because the only
  // place that word appeared was the display-only hint.
  const kw = commandKeywords('/iq/projects', 'Initiatives', [], 'Epics, stories, decisions and contributors');
  assert.ok(kw.includes('epics'));
  assert.ok(kw.includes('contributors'));
});
