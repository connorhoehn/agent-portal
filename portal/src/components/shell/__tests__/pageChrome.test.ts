// The page chrome fold (U5): off unless a mounted page holds it; released holds give the chrome back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { holdPageChromeFold, pageChromeFolded, usePageChromeFold, usePageChromeFolded } from '../pageChrome.ts';

test('by default nothing is folded: every other page renders its trail, rail and gutter as before', () => {
  assert.equal(pageChromeFolded(), false);
  function Probe() { return createElement('span', null, String(usePageChromeFolded())); }
  assert.equal(renderToStaticMarkup(createElement(Probe)), '<span>false</span>');
  // A page that passes false holds nothing (the effect never runs on the server, and false holds nothing on the client).
  function Quiet() { usePageChromeFold(false); return createElement('span', null, String(pageChromeFolded())); }
  assert.equal(renderToStaticMarkup(createElement(Quiet)), '<span>false</span>');
});

test('a hold folds the chrome until it is released; two holds need two releases; a release is idempotent', () => {
  const a = holdPageChromeFold();
  assert.equal(pageChromeFolded(), true);
  const b = holdPageChromeFold();
  a();
  assert.equal(pageChromeFolded(), true);
  a();
  assert.equal(pageChromeFolded(), true);
  b();
  assert.equal(pageChromeFolded(), false);
});
