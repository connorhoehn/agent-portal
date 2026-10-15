jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, messageQueue: { mock: true } } }));
import { pipelineQueueInventory, readPipelineQueues } from '../pipeline-queues.js';
import { MessageQueueError, type MessageQueue } from '../mq-client.js';

it('bounds explicit queue inventory and rejects paths, duplicates and unconfigured queues', () => {
  const rows = pipelineQueueInventory(['ingest-landing', '../private', 'bad/name', 'extra', ...Array.from({ length: 40 }, (_, i) => `queue-${i}`)].join(','));
  expect(rows).toHaveLength(32);
  expect(new Set(rows.map(row => row.name)).size).toBe(32);
  expect(rows.some(row => row.name.includes('/'))).toBe(false);
  expect(rows.find(row => row.name === 'ingest-landing')).toMatchObject({ redriveTo: 'ingest-landing-dlq', maxReceives: 3 });
});

it('keeps successful counts and redacts upstream failures without any queue mutations', async () => {
  const inspect = jest.fn(async (name: string) => {
    if (name === 'ingest-landing') return { ready: 8, inFlight: 2, delayed: 0, fifo: true, visibilityTimeoutSeconds: 60 };
    if (name === 'ingest-landing-dlq') return null;
    throw new MessageQueueError('secret upstream http://private/?token=hidden', 403);
  });
  const queue: MessageQueue = { backend: 'http', inspect, ensureQueue: jest.fn(), send: jest.fn(), receive: jest.fn(), ack: jest.fn() };
  const result = await readPipelineQueues(queue, '');
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(result.queues.find(row => row.name === 'ingest-landing')).toMatchObject({ state: 'available', snapshot: { ready: 8 } });
  expect(result.queues.find(row => row.name === 'ingest-landing-dlq')).toMatchObject({ state: 'missing', snapshot: null });
  expect(result.queues.find(row => row.name === 'backfill-requests')).toMatchObject({ state: 'unavailable', snapshot: null });
  expect(JSON.stringify(result)).not.toMatch(/hidden|secret|private/);
  for (const operation of [queue.ensureQueue, queue.send, queue.receive, queue.ack]) expect(operation).not.toHaveBeenCalled();
});
