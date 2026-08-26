// Run with:  cd portal && node --test 'src/pages/newsroom/__tests__/*.test.ts'
//
// Plain node:test — the portal has no test runner in package.json.
// publishControl is pure TypeScript (no DOM, no fetch), so Node's
// type-stripping loader runs it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canShowPublishControl } from '../publishControl.ts';

test('editor sees the Publish button on a draft article', () => {
  assert.equal(canShowPublishControl('draft', true), true);
});

test('editor sees no button once the article is published', () => {
  assert.equal(canShowPublishControl('published', true), false);
});

test('reporter (no PublishArticle capability) never sees the button, published or not', () => {
  assert.equal(canShowPublishControl('draft', false), false);
  assert.equal(canShowPublishControl('published', false), false);
});

test('a null/unknown status is treated as unpublished for a capable role', () => {
  assert.equal(canShowPublishControl(null, true), true);
  assert.equal(canShowPublishControl('review', true), true);
  assert.equal(canShowPublishControl('archived', true), true);
});
