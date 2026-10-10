// lib/memory-queue.ts — the MOCK_QUEUE backend. Pinned: the semantics the
// compaction consumer depends on, each of which message-queue provides over
// HTTP — dedup on send, FIFO per group, visibility-timeout redelivery with a
// rising receive count, a stale receipt refused on ack, and redrive to the
// dead-letter queue after max receives.

import { MemoryMessageQueue, type MemoryQueueRow } from '../memory-queue.js';

function harness(maxReceiveCount = 3) {
  const rows: MemoryQueueRow[] = [];
  let now = Date.parse('2026-09-24T12:00:00.000Z');
  const q = new MemoryMessageQueue({ rows: () => rows, now: () => now });
  const ready = (async () => {
    await q.ensureQueue({ name: 'work-dlq', fifo: true, visibilityTimeoutSeconds: 30 });
    await q.ensureQueue({
      name: 'work', fifo: true, visibilityTimeoutSeconds: 30,
      redrive: { deadLetterQueue: 'work-dlq', maxReceiveCount },
    });
  })();
  return { q, rows, ready, advance: (ms: number) => { now += ms; } };
}

describe('MemoryMessageQueue', () => {
  it('deduplicates a second send with the same deduplication id', async () => {
    const { q, rows, ready } = harness();
    await ready;
    const a = await q.send('work', '{"job_id":"comp-1"}', { groupId: 'r1', deduplicationId: 'comp-1' });
    const b = await q.send('work', '{"job_id":"comp-1"}', { groupId: 'r1', deduplicationId: 'comp-1' });
    expect(b.message_id).toBe(a.message_id);
    expect(rows).toHaveLength(1);
  });

  it('delivers one message per FIFO group at a time, in send order', async () => {
    const { q, ready } = harness();
    await ready;
    await q.send('work', 'r1-first', { groupId: 'r1', deduplicationId: '1' });
    await q.send('work', 'r1-second', { groupId: 'r1', deduplicationId: '2' });
    await q.send('work', 'r2-first', { groupId: 'r2', deduplicationId: '3' });
    const first = await q.receive('work', { max: 10 });
    expect(first.map((m) => m.body)).toEqual(['r1-first', 'r2-first']);
    // r1's head is leased, so r1-second waits for its ack.
    expect(await q.receive('work', { max: 10 })).toEqual([]);
    expect(await q.ack('work', first[0]!.receipt_handle)).toBe(true);
    expect((await q.receive('work', { max: 10 })).map((m) => m.body)).toEqual(['r1-second']);
  });

  it('redelivers an unacked message after its visibility timeout, with the receive count rising', async () => {
    const { q, ready, advance } = harness();
    await ready;
    await q.send('work', 'job', { groupId: 'g', deduplicationId: 'x' });
    const [first] = await q.receive('work');
    expect(first!.approximate_receive_count).toBe(1);
    advance(29_000);
    expect(await q.receive('work')).toEqual([]);
    advance(2_000);
    const [second] = await q.receive('work');
    expect(second!.message_id).toBe(first!.message_id);
    expect(second!.approximate_receive_count).toBe(2);
    // The first lease expired: its receipt no longer acks anything.
    expect(await q.ack('work', first!.receipt_handle)).toBe(false);
    expect(await q.ack('work', second!.receipt_handle)).toBe(true);
    expect(q.depth('work')).toEqual({ visible: 0, inflight: 0 });
  });

  it('moves a message to the dead-letter queue instead of delivering it past max receives', async () => {
    const { q, rows, ready, advance } = harness(3);
    await ready;
    await q.send('work', 'poison', { groupId: 'g', deduplicationId: 'p' });
    for (let i = 1; i <= 3; i += 1) {
      const [m] = await q.receive('work');
      expect(m!.approximate_receive_count).toBe(i);
      advance(31_000);
    }
    expect(await q.receive('work')).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.queue).toBe('work-dlq');
    expect(rows[0]!.dead_lettered_from).toBe('work');
    const [dead] = await q.receive('work-dlq');
    expect(dead!.body).toBe('poison');
  });

  it('refuses to send to a queue nobody ensured', async () => {
    const { q } = harness();
    await expect(q.send('nope', 'x')).rejects.toThrow(/does not exist/);
  });
});


it('inspects backlog and expired leases without receiving, redriving or changing receipts', async () => {
  const { q, rows, ready, advance } = harness(1);
  await ready;
  expect(await q.inspect('uncreated')).toBeNull();
  expect(q.definition('uncreated')).toBeUndefined();
  await q.send('work', 'private payload', { groupId: 'g' });
  const [leased] = await q.receive('work');
  const before = structuredClone(rows);
  expect(await q.inspect('work')).toMatchObject({ ready: 0, inFlight: 1, delayed: 0 });
  expect(rows).toEqual(before);
  advance(31_000);
  expect(await q.inspect('work')).toMatchObject({ ready: 1, inFlight: 0 });
  expect(rows).toEqual(before);
  expect(rows[0]!.receipt_handle).toBe(leased!.receipt_handle);
  expect(await q.inspect('work-dlq')).toMatchObject({ ready: 0 });
});
