import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defChannel, isConnected, rosterUsers, runChannel } from '../pipelinesRealtime.ts';

test('channels carry the pipelines tenant prefix the gateway admits', () => {
  assert.equal(runChannel('r-1'), 'pipelines:run:r-1');
  assert.equal(defChannel('d-1'), 'pipelines:def:d-1');
});

test('isConnected: only a connected gateway; no provider or a drop is unavailable', () => {
  assert.equal(isConnected('connected'), true);
  for (const s of ['connecting', 'disconnected', undefined, null]) assert.equal(isConnected(s), false);
});

test('rosterUsers: one avatar per person across tabs, named from metadata', () => {
  const users = rosterUsers([
    { clientId: 'c1', metadata: { userId: 'u-ines', displayName: 'Ines' } },
    { clientId: 'c2', metadata: { userId: 'u-ines', displayName: 'Ines' } },
    { clientId: 'c3', status: 'away', metadata: { userId: 'u-kofi' } },
  ]);
  assert.deepEqual(users, [{ id: 'u-ines', name: 'Ines' }, { id: 'u-kofi', name: 'u-kofi', idle: true }]);
});

test('eventsSource: gateway only while connected, SSE otherwise', async () => {
  const { eventsSource, phaseMoved, runWireChannel } = await import('../pipelinesRealtime.ts');
  assert.equal(eventsSource('connected'), 'gateway');
  for (const s of ['connecting', 'disconnected', undefined, null]) assert.equal(eventsSource(s), 'sse');
  assert.equal(runWireChannel('job:4'), 'pipeline:run:job:4');
  assert.equal(phaseMoved('running', 'completed'), true);
  assert.equal(phaseMoved(undefined, 'running'), false);
  assert.equal(phaseMoved('running', 'running'), false);
  assert.equal(phaseMoved('running', undefined), false);
});

test('recordBehind: a frame the header has not caught up with, including the first one seen', async () => {
  const { recordBehind } = await import('../pipelinesRealtime.ts');
  assert.equal(recordBehind('pending', 'completed'), true);
  assert.equal(recordBehind('completed', 'completed'), false);
  assert.equal(recordBehind('cancelled', 'completed'), false);
  assert.equal(recordBehind('running', 'running'), false);
  assert.equal(recordBehind(undefined, 'completed'), false);
  assert.equal(recordBehind('pending', undefined), false);
});
