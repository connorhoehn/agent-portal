// Run with:  cd portal && node --test 'src/pages/work/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  avgJobMinutes, botsOnQueue, estimateDrainMinutes, pausedBotCount, pullingBotIds, DEFAULT_JOB_MINUTES,
} from '../queueMath.ts';

test('avgJobMinutes falls back when nothing recorded a duration', () => {
  assert.equal(avgJobMinutes([]), DEFAULT_JOB_MINUTES);
  assert.equal(avgJobMinutes([{ status: 'done', result: {} }]), DEFAULT_JOB_MINUTES);
});

test('avgJobMinutes means only real durations', () => {
  const jobs = [
    { status: 'done', result: { durationMs: 4 * 60_000 } },
    { status: 'done', result: { durationMs: 8 * 60_000 } },
    { status: 'done', result: { durationMs: 0 } }, // ignored — zero drags toward "instant"
  ];
  assert.equal(avgJobMinutes(jobs), 6);
});

test('estimateDrainMinutes: empty queue is "nothing to drain", not 0 minutes', () => {
  assert.equal(estimateDrainMinutes(0, 0, 2, 6), null);
});

test('estimateDrainMinutes counts mid-flight work as half done and splits across workers', () => {
  // (4 queued + 2*0.5 processing) * 6 min / 2 workers = 15
  assert.equal(estimateDrainMinutes(4, 2, 2, 6), 15);
  // never reports under a minute while anything is left
  assert.equal(estimateDrainMinutes(1, 0, 8, 0.5), 1);
});

test('pullingBotIds: only claimed/running jobs with a bot behind them', () => {
  const ids = pullingBotIds([
    { status: 'running', botId: 'b1' },
    { status: 'claimed', botId: 'b2' },
    { status: 'queued', botId: 'b3' },
    { status: 'running', botId: null },
  ]);
  assert.deepEqual([...ids].sort(), ['b1', 'b2']);
});

// The "Bots on this queue" tile and the roster table below it must count and
// render the same list — a tile reading 4 over a 5-row roster was the two
// disagreeing about what "on this queue" means (org-leader DEFECTS #6).
test('botsOnQueue is the full roster, active and paused alike', () => {
  const bots = [
    { enabled: true, pausedReason: null },
    { enabled: true, pausedReason: null },
    { enabled: false, pausedReason: null },
    { enabled: true, pausedReason: 'budget exhausted' },
    { enabled: true, pausedReason: null },
  ];
  assert.equal(botsOnQueue(bots).length, bots.length);
  assert.equal(botsOnQueue(bots), bots);
});

test('pausedBotCount counts disabled bots and bots with a pause reason', () => {
  assert.equal(pausedBotCount([
    { enabled: true, pausedReason: null },
    { enabled: false, pausedReason: null },
    { enabled: true, pausedReason: 'budget exhausted' },
  ]), 2);
  assert.equal(pausedBotCount([{ enabled: true, pausedReason: null }]), 0);
  assert.equal(pausedBotCount([]), 0);
});
