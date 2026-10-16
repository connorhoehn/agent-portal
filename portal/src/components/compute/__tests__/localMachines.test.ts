// Run with:  cd portal && node --test 'src/components/compute/__tests__/*.test.ts'
//
// A paired machine used to render as a band ABOVE <ComputerLab> while the lab
// itself said "0 computers · nothing here". These pin the mapping that puts it
// IN the lab's own fleet instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_ID_PREFIX, isLocalMachineId, machineToComputer, nodeIdOf, withLocalMachines,
} from '../localMachines.ts';

const node = (over: Record<string, unknown> = {}) => ({
  id: 'node-abc123',
  label: 'Connors-MacBook-Pro',
  presence: { status: 'connected' as const, lastSeenAt: '2026-09-17T07:00:00.000Z' },
  acceptJobs: true,
  ...over,
});

test('a machine id round-trips through the prefix', () => {
  const c = machineToComputer(node());
  assert.equal(c.id, `${LOCAL_ID_PREFIX}node-abc123`);
  assert.equal(isLocalMachineId(c.id), true);
  assert.equal(nodeIdOf(c.id), 'node-abc123');
  // The field the lab reads to draw a laptop and keep a terminal off it.
  assert.equal(c.kind, 'local');
});

test('a microVM id is not mistaken for a machine', () => {
  // The prefix is the ONLY channel for "this is a laptop" until Computer.kind
  // ships, so a box id must never satisfy it.
  assert.equal(isLocalMachineId('box-mock-0001'), false);
  assert.equal(isLocalMachineId('rachel-scratch'), false);
});

test('connected-and-accepting reads idle; connected-but-paused does not', () => {
  // Being reachable and taking work are different facts. A paused machine
  // showing "idle" would read as "ready for work", which is the opposite of
  // true and the single most common reason a machine looks alive and does
  // nothing.
  assert.equal(machineToComputer(node()).status, 'idle');
  const paused = machineToComputer(node({ acceptJobs: false }));
  assert.equal(paused.status, 'waiting');
  assert.match(String(paused.currentTask), /Paused/);
});

test('an unreachable machine is stopped, and says the worker is not running', () => {
  const off = machineToComputer(node({ presence: { status: 'offline' } }));
  assert.equal(off.status, 'stopped');
  assert.match(String(off.currentTask), /not reachable|not running/i);
});

test('sessionId is long enough for the lab and is obviously not an AgentCore session', () => {
  // The field is documented as "AgentCore runtimeSessionId, >=33 chars — the
  // real address". A laptop has none, and a plausible-looking fake is worse
  // than an obvious placeholder: the shell pane would try to dial it.
  const c = machineToComputer(node());
  assert.ok(c.sessionId.length >= 33, `too short: ${c.sessionId.length}`);
  assert.match(c.sessionId, /no-agentcore-session/);
});

test('lastActivityAt is carried only when presence actually reports one', () => {
  const seen = machineToComputer(node());
  assert.equal(seen.lastActivityAt, '2026-09-17T07:00:00.000Z');
  const never = machineToComputer(node({ presence: { status: 'offline' } }));
  assert.equal(never.lastActivityAt, undefined);
});

test('viewing the lab never re-adopts a computer (no POST /boxes from a read)', async () => {
  let adopted = 0;
  const base = {
    listComputers: async () => [],
    adoptComputer: async () => { adopted++; },
  } as unknown as Parameters<typeof withLocalMachines>[0];
  const wrapped = withLocalMachines(base);
  await assert.rejects(() => wrapped.adoptComputer({ sessionId: 'x' } as never));
  assert.equal(adopted, 0);
});
