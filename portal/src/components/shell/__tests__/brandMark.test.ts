import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brandInitials, brandMarkUri, gradientStops } from '../brandMark.ts';

test('initials are the first two letters of the label', () => {
  assert.equal(brandInitials('Org'), 'Or');
  assert.equal(brandInitials('Assessment'), 'As');
  assert.equal(brandInitials('X'), 'X');
  assert.equal(brandInitials(''), '?');
});

test('gradient stops are the first and last colours of the gradient', () => {
  assert.deepEqual(gradientStops('linear-gradient(90deg, #6366f1 0%, #8b5cf6 55%, #ec4899 100%)'), ['#6366f1', '#ec4899']);
  assert.deepEqual(gradientStops('linear-gradient(90deg, rgb(13, 148, 136) 0%, rgb(59, 130, 246) 100%)'), ['rgb(13, 148, 136)', 'rgb(59, 130, 246)']);
  assert.equal(gradientStops('none'), null);
});

test('the mark is an SVG data URI carrying both stops and the initials', () => {
  const uri = brandMarkUri('Org', '#6366f1', '#ec4899');
  assert.ok(uri.startsWith('data:image/svg+xml;utf8,'));
  const svg = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
  assert.ok(svg.includes('stop-color="#6366f1"') && svg.includes('stop-color="#ec4899"') && svg.includes('>Or<'));
});
