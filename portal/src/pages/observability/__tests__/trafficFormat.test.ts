// Run with:  cd portal && node --test 'src/pages/observability/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { heatmapBucketClass } from '../trafficFormat.ts';

test('heatmapBucketClass returns the empty-surface class for zero count or zero max', () => {
  assert.equal(heatmapBucketClass(0, 10), 'bg-surface');
  assert.equal(heatmapBucketClass(5, 0), 'bg-surface');
  assert.equal(heatmapBucketClass(-1, 10), 'bg-surface');
});

test('heatmapBucketClass buckets the count/max ratio into 5 intensities', () => {
  assert.equal(heatmapBucketClass(1, 100), 'bg-[rgba(99,102,241,0.10)]'); // t=0.01
  assert.equal(heatmapBucketClass(30, 100), 'bg-[rgba(99,102,241,0.25)]'); // t=0.3
  assert.equal(heatmapBucketClass(50, 100), 'bg-[rgba(99,102,241,0.45)]'); // t=0.5
  assert.equal(heatmapBucketClass(70, 100), 'bg-[rgba(99,102,241,0.70)]'); // t=0.7
  assert.equal(heatmapBucketClass(90, 100), 'bg-[rgba(99,102,241,0.95)]'); // t=0.9
});

test('heatmapBucketClass caps the ratio at 1 when count exceeds max', () => {
  assert.equal(heatmapBucketClass(150, 100), 'bg-[rgba(99,102,241,0.95)]');
});

test('heatmapBucketClass is exact at bucket boundaries', () => {
  assert.equal(heatmapBucketClass(20, 100), 'bg-[rgba(99,102,241,0.25)]'); // t=0.2 → next bucket
  assert.equal(heatmapBucketClass(80, 100), 'bg-[rgba(99,102,241,0.95)]'); // t=0.8 → next bucket
});
