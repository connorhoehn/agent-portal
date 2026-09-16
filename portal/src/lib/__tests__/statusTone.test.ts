// Run with:  cd portal && node --test 'src/lib/__tests__/statusTone.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  runStateChip, severityTone, botStatusChip, presenceChip,
} from '../statusTone.ts';

test('runStateChip: canonical work-lane tones', () => {
  assert.deepEqual(runStateChip('queued'), { tone: 'neutral', label: 'queued' });
  assert.deepEqual(runStateChip('claimed'), { tone: 'accent', label: 'claimed' });
  assert.deepEqual(runStateChip('running'), { tone: 'accent', label: 'running', solid: true });
  assert.deepEqual(runStateChip('awaiting_review'), { tone: 'warning', label: 'awaiting review' });
  assert.deepEqual(runStateChip('done'), { tone: 'success', label: 'done' });
  assert.deepEqual(runStateChip('failed'), { tone: 'danger', label: 'failed' });
  assert.deepEqual(runStateChip('cancelled'), { tone: 'neutral', label: 'cancelled' });
  assert.deepEqual(runStateChip('skipped'), { tone: 'neutral', label: 'skipped' });
});

test('runStateChip: unknown status falls back to neutral, label de-underscored', () => {
  assert.deepEqual(runStateChip('some_weird_status'), { tone: 'neutral', label: 'some weird status' });
});

test('severityTone: findings vocabulary', () => {
  assert.equal(severityTone('critical'), 'danger');
  assert.equal(severityTone('warning'), 'warning');
  assert.equal(severityTone('info'), 'neutral');
});

test('severityTone: alarm vocabulary adds ok/unknown', () => {
  assert.equal(severityTone('ok'), 'success');
  assert.equal(severityTone('unknown'), 'neutral');
});

test('severityTone: guardrail HIGH/MEDIUM/LOW scale, case-insensitive', () => {
  assert.equal(severityTone('HIGH'), 'danger');
  assert.equal(severityTone('MEDIUM'), 'warning');
  assert.equal(severityTone('LOW'), 'neutral');
});

test('severityTone: null/undefined/unrecognized read neutral', () => {
  assert.equal(severityTone(null), 'neutral');
  assert.equal(severityTone(undefined), 'neutral');
  assert.equal(severityTone('whatever'), 'neutral');
});

test('botStatusChip: no isPulling arg — roster read (BotsPage/BotDetailPage)', () => {
  assert.deepEqual(botStatusChip({ enabled: true, pausedReason: null }), { tone: 'success', label: 'enabled' });
  assert.deepEqual(
    botStatusChip({ enabled: false, pausedReason: null }),
    { tone: 'warning', label: 'paused', title: undefined },
  );
  assert.deepEqual(
    botStatusChip({ enabled: true, pausedReason: 'over budget' }),
    { tone: 'warning', label: 'paused', title: 'over budget' },
  );
});

test('botStatusChip: isPulling given — live queue-pulse read', () => {
  assert.deepEqual(botStatusChip({ enabled: true, pausedReason: null }, true), { tone: 'success', label: 'processing' });
  assert.deepEqual(botStatusChip({ enabled: true, pausedReason: null }, false), { tone: 'neutral', label: 'idle' });
  assert.deepEqual(
    botStatusChip({ enabled: false, pausedReason: null }, false),
    { tone: 'warning', label: 'paused', title: undefined },
  );
  // A paused bot mid-run still reads as processing — pulling is the live fact.
  assert.deepEqual(botStatusChip({ enabled: false, pausedReason: null }, true), { tone: 'success', label: 'processing' });
});

test('presenceChip', () => {
  assert.deepEqual(presenceChip('connected'), { tone: 'success', dot: 'pulse', label: 'connected' });
  assert.deepEqual(presenceChip('stale'), { tone: 'warning', dot: 'static', label: 'stale' });
  assert.deepEqual(presenceChip('offline'), { tone: 'neutral', dot: 'static', label: 'offline' });
});
