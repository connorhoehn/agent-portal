import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nearLine, parseThresholdFilter, passesThresholdFilter, thresholdView } from '../thresholdModel.ts';

test('thresholds: each row reads under 50%, 50%, 80% or at cap', () => {
  assert.deepEqual(thresholdView({ percent: 12.4, reached: 0 }), { label: 'under 50%', tone: 'neutral', meta: '12% spent or held', near: false, atCap: false });
  assert.deepEqual(thresholdView({ percent: 61, reached: 50 }), { label: '50%', tone: 'info', meta: '61% spent or held', near: false, atCap: false });
  assert.deepEqual(thresholdView({ percent: 81.4, reached: 80 }), { label: '80%', tone: 'warning', meta: '81% spent or held', near: true, atCap: false });
  assert.deepEqual(thresholdView({ percent: 106, reached: 100 }), { label: 'at cap', tone: 'danger', meta: '106% spent or held', near: true, atCap: true });
});

test('thresholds: no budget, or an older BFF, reads as nothing', () => {
  assert.equal(thresholdView({ percent: null, reached: 0 }).label, null);
  assert.equal(thresholdView(undefined).label, null);
  assert.equal(thresholdView(undefined).near, false);
});

test('thresholds: the near line follows the configured thresholds', () => {
  assert.equal(nearLine([50, 80, 100]), 80);
  assert.equal(nearLine([25, 90, 100]), 90);
  assert.equal(nearLine([100]), 100);
  assert.equal(thresholdView({ percent: 85, reached: 25 }, [25, 90, 100]).near, false);
  assert.equal(thresholdView({ percent: 30, reached: 25 }, [25, 90, 100]).label, '25%');
});

test('thresholds: "Near or at cap" keeps 80% and at-cap rows only', () => {
  assert.equal(parseThresholdFilter('near'), 'near');
  assert.equal(parseThresholdFilter('bogus'), 'all');
  assert.equal(passesThresholdFilter({ percent: 10, reached: 0 }, 'all'), true);
  assert.equal(passesThresholdFilter({ percent: 60, reached: 50 }, 'near'), false);
  assert.equal(passesThresholdFilter({ percent: 81, reached: 80 }, 'near'), true);
  assert.equal(passesThresholdFilter({ percent: 120, reached: 100 }, 'near'), true);
  assert.equal(passesThresholdFilter(undefined, 'near'), false);
});
