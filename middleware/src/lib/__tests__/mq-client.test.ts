// lib/mq-client.ts — the message-queue HTTP client. Pinned against a fake
// fetch: the exact routes and bodies message-queue's src/api/routes.ts serves,
// the redrive policy's ARN shape, and an X-Service-Auth header that verifies
// against the payload message-queue's verifyServiceRequest rebuilds
// ({protocol:'service-http-v1', audience, method, target, body}).

import { SERVICE_AUTH_HEADER, verifyEnvelope } from '@connorhoehn/service-runtime';
import { HttpMessageQueue, MessageQueueError } from '../mq-client.js';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

function fakeFetch(respond: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body ?? '' };
    calls.push(call);
    const { status, body } = respond(call);
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describe('HttpMessageQueue', () => {
  it('ensures a FIFO queue with a redrive policy by idempotent PUT, and tolerates a 409', async () => {
    const { calls, impl } = fakeFetch(() => ({ status: 409, body: { status: 'conflict' } }));
    const q = new HttpMessageQueue({ baseUrl: 'http://mq:3000/', serviceId: 'orgiq-middleware', fetchImpl: impl });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await q.ensureQueue({
      name: 'distill-compact-l1', fifo: true, visibilityTimeoutSeconds: 60,
      redrive: { deadLetterQueue: 'distill-compact-l1-dlq', maxReceiveCount: 3 },
    });
    warn.mockRestore();
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('http://mq:3000/api/v1/queues/distill-compact-l1');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      configuration: {
        fifo_queue: true,
        visibility_timeout_seconds: 60,
        redrive_policy: { dead_letter_target_arn: 'arn:message-queue:queue:distill-compact-l1-dlq', max_receive_count: 3 },
      },
    });
  });

  it('sends with group + dedup ids, receives, and acks by receipt handle', async () => {
    const { calls, impl } = fakeFetch((call) => {
      if (call.url.endsWith('/messages/receive')) {
        return { status: 200, body: { messages: [{ message_id: 'm1', receipt_handle: 'r/1', body: '{}', approximate_receive_count: 2, message_group_id: 'repo' }] } };
      }
      if (call.method === 'POST') return { status: 201, body: { message_id: 'm1' } };
      return { status: 200, body: { success: true } };
    });
    const q = new HttpMessageQueue({ baseUrl: 'http://mq:3000', serviceId: 'orgiq-middleware', fetchImpl: impl });
    expect(await q.send('distill-compact-l2', '{"job_id":"comp-91"}', { groupId: 'o/r', deduplicationId: 'comp-91' })).toEqual({ message_id: 'm1' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ message_body: '{"job_id":"comp-91"}', message_group_id: 'o/r', message_deduplication_id: 'comp-91' });
    const msgs = await q.receive('distill-compact-l2', { max: 5, waitSeconds: 10 });
    expect(JSON.parse(calls[1]!.body)).toEqual({ max_number_of_messages: 5, wait_time_seconds: 10 });
    expect(msgs).toEqual([{ message_id: 'm1', receipt_handle: 'r/1', body: '{}', approximate_receive_count: 2, message_group_id: 'repo' }]);
    expect(await q.ack('distill-compact-l2', 'r/1')).toBe(true);
    expect(calls[2]!.method).toBe('DELETE');
    expect(calls[2]!.url).toBe('http://mq:3000/api/v1/queues/distill-compact-l2/messages/r%2F1');
  });

  it('signs X-Service-Auth over the request message-queue verifies, and sends none without a secret', async () => {
    const { calls, impl } = fakeFetch(() => ({ status: 201, body: { message_id: 'm' } }));
    const signed = new HttpMessageQueue({ baseUrl: 'http://mq:3000', serviceId: 'orgiq-middleware', secret: 's3cret', fetchImpl: impl });
    await signed.send('distill-compact-l1', 'x');
    const header = calls[0]!.headers[SERVICE_AUTH_HEADER]!;
    const verdict = verifyEnvelope(header, {
      secret: 's3cret',
      allowedServices: ['orgiq-middleware'],
      payload: { protocol: 'service-http-v1', audience: 'message-queue', method: 'POST', target: '/api/v1/queues/distill-compact-l1/messages', body: calls[0]!.body },
    });
    expect(verdict).toEqual({ ok: true, serviceId: 'orgiq-middleware' });
    // A different body must not verify — the signature binds the payload.
    expect(verifyEnvelope(header, {
      secret: 's3cret', allowedServices: ['orgiq-middleware'],
      payload: { protocol: 'service-http-v1', audience: 'message-queue', method: 'POST', target: '/api/v1/queues/distill-compact-l1/messages', body: '{}' },
    }).ok).toBe(false);

    const unsigned = new HttpMessageQueue({ baseUrl: 'http://mq:3000', serviceId: 'orgiq-middleware', fetchImpl: impl });
    await unsigned.send('distill-compact-l1', 'x');
    expect(calls[1]!.headers[SERVICE_AUTH_HEADER]).toBeUndefined();
  });

  it('surfaces a non-2xx as MessageQueueError, and a stale receipt as a false ack', async () => {
    const { impl } = fakeFetch((call) => ({ status: call.method === 'DELETE' ? 400 : 503, body: { error: 'nope' } }));
    const q = new HttpMessageQueue({ baseUrl: 'http://mq:3000', serviceId: 'orgiq-middleware', fetchImpl: impl });
    await expect(q.send('distill-compact-l1', 'x')).rejects.toBeInstanceOf(MessageQueueError);
    expect(await q.ack('distill-compact-l1', 'stale')).toBe(false);
  });
});


describe('read-only queue attributes', () => {
  it('uses signed metadata GET, never the message receive endpoint', async () => {
    const { calls, impl } = fakeFetch(() => ({ status: 200, body: { attributes: {
      ApproximateNumberOfMessages: '7', ApproximateNumberOfMessagesNotVisible: 2,
      ApproximateNumberOfMessagesDelayed: '0', VisibilityTimeout: '60',
    } } }));
    const q = new HttpMessageQueue({ baseUrl: 'http://mq:3000', serviceId: 'orgiq-middleware', secret: 'test-secret', fetchImpl: impl });
    expect(await q.inspect('scope:queue')).toEqual({ ready: 7, inFlight: 2, delayed: 0, visibilityTimeoutSeconds: 60, fifo: null });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url).toBe('http://mq:3000/api/v1/queues/scope%3Aqueue/attributes');
    expect(call.body).toBe('');
    expect(verifyEnvelope(call.headers[SERVICE_AUTH_HEADER]!, {
      secret: 'test-secret', allowedServices: ['orgiq-middleware'],
      payload: { protocol: 'service-http-v1', audience: 'message-queue', method: 'GET', target: '/api/v1/queues/scope%3Aqueue/attributes', body: '' },
    }).ok).toBe(true);
  });

  it('keeps malformed or omitted metrics unknown and missing queues absent', async () => {
    const { impl } = fakeFetch(call => call.url.includes('absent') ? { status: 404 } : { status: 200, body: { attributes: {
      ApproximateNumberOfMessages: -1, ApproximateNumberOfMessagesNotVisible: 'NaN',
      ApproximateNumberOfMessagesDelayed: 1.5, VisibilityTimeout: '', FifoQueue: 'false',
    } } });
    const q = new HttpMessageQueue({ baseUrl: 'http://mq', serviceId: 'test', fetchImpl: impl });
    expect(await q.inspect('bad')).toEqual({ ready: null, inFlight: null, delayed: null, visibilityTimeoutSeconds: null, fifo: false });
    expect(await q.inspect('absent')).toBeNull();
  });

  it('bounds a metadata request and rejects a malformed response', async () => {
    let signal: AbortSignal | undefined;
    const impl = (async (_url: unknown, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return { status: 200, ok: true, text: async () => '{}' };
    }) as typeof fetch;
    const q = new HttpMessageQueue({ baseUrl: 'http://mq', serviceId: 'test', fetchImpl: impl });
    await expect(q.inspect('bad')).rejects.toThrow();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
