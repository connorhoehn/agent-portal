// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// Plain node:test — same arrangement as components/chat/__tests__ (the portal
// has no test runner in package.json). Node strips the types; chatSessions is
// pure TypeScript whose only environment dependency here is `fetch`, stubbed
// per test.
//
// Two things are under test, both of them honesty properties:
//
//   1. A RESTORED turn carries the same provenance a live one does. The chips
//      and the tool-summary line are derived from `message.toolCalls`, so a
//      transcript restored without them shows the identical answer with its
//      evidence removed. The assertions compare a restored message against the
//      live shape by running BOTH through the real derivation.
//   2. A history load that FAILED is not an empty conversation. It used to be
//      `if (!r.ok) return []`, which on auto-resume read as "your conversation
//      is gone".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchSessionMessages, SessionHistoryError } from '../chatSessions.ts';
import { deriveSources } from '../../components/chat/answerSources.ts';
import { summarizeToolCalls } from '../../components/chat/toolCallSummary.ts';

const S3 = 's3://orgiq-documents-123456789012-us-east-1/adr/adr-012.txt';

/** Stub `fetch` for one call, restoring whatever was there before. */
function withFetch<T>(impl: () => Promise<Response> | Promise<never>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = impl;
  return run().finally(() => { (globalThis as { fetch: unknown }).fetch = original; });
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const STORED_EVENTS = {
  events: [
    {
      eventId: 'evt-1',
      sessionId: 's-1',
      timestamp: '2026-08-24T18:34:38.727Z',
      role: 'USER',
      text: 'Who are the top two Kubernetes experts? Cite your sources.',
    },
    {
      eventId: 'evt-1',
      sessionId: 's-1',
      timestamp: '2026-08-24T18:34:38.727Z',
      role: 'ASSISTANT',
      text: 'Sarah Thompson (87.63) and Marcus Müller (77.31).\n\n*Source: Scoring specialist*',
      toolCalls: [
        {
          id: 'tc-1',
          name: 'query_knowledge_base',
          args: '{"query":"kubernetes"}',
          result: JSON.stringify([{ source: S3, title: 'ADR 12: Kubernetes rollout' }]),
        },
        { id: 'tc-2', name: 'get_expertise_scores', args: '{"skill":"Kubernetes"}', result: 'Sarah Thompson 87.63' },
      ],
    },
  ],
};

test('a restored turn carries tool calls in the live stream shape', async () => {
  const msgs = await withFetch(() => jsonResponse(STORED_EVENTS), () => fetchSessionMessages('s-1'));

  assert.equal(msgs.length, 2);
  const assistant = msgs[1]!;
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.toolCalls, [
    {
      id: 'tc-1',
      name: 'query_knowledge_base',
      args: '{"query":"kubernetes"}',
      result: JSON.stringify([{ source: S3, title: 'ADR 12: Kubernetes rollout' }]),
      done: true,
    },
    {
      id: 'tc-2',
      name: 'get_expertise_scores',
      args: '{"skill":"Kubernetes"}',
      result: 'Sarah Thompson 87.63',
      done: true,
    },
  ]);
  // The user turn has no provenance of its own — and never invents any.
  assert.deepEqual(msgs[0]!.toolCalls, []);
});

test('a restored turn derives the same chips and summary a live one does', async () => {
  const msgs = await withFetch(() => jsonResponse(STORED_EVENTS), () => fetchSessionMessages('s-1'));
  const restored = msgs[1]!;

  // What the live stream would have held for the identical turn.
  const live = {
    content: restored.content,
    toolCalls: [
      { id: 'tc-1', name: 'query_knowledge_base', args: '{"query":"kubernetes"}', result: JSON.stringify([{ source: S3, title: 'ADR 12: Kubernetes rollout' }]), done: true },
      { id: 'tc-2', name: 'get_expertise_scores', args: '{"skill":"Kubernetes"}', result: 'Sarah Thompson 87.63', done: true },
    ],
  };

  const fromRestored = deriveSources({ content: restored.content, toolCalls: restored.toolCalls });
  const fromLive = deriveSources(live);

  assert.deepEqual(fromRestored.sources, fromLive.sources);
  assert.deepEqual(fromRestored.provenance, fromLive.provenance);
  assert.equal(fromRestored.cleaned, fromLive.cleaned);

  // Concretely: the document chip is back, and so is the summary line.
  assert.equal(fromRestored.sources[0]?.label, 'ADR 12: Kubernetes rollout');
  assert.equal(fromRestored.provenance.documentsRetrieved, 1);
  assert.equal(
    summarizeToolCalls(restored.toolCalls),
    'searched knowledge base · read expertise scores',
  );
});

test('a capped result still yields the chip it was capped for', async () => {
  // The middleware distills an oversized retrieval result down to uri+title.
  // The point of that shape is that this derivation still works on it.
  const capped = {
    events: [{
      eventId: 'evt-2', sessionId: 's-2', timestamp: '2026-08-24T18:00:00.000Z', role: 'ASSISTANT',
      text: 'Two ADRs cover this.',
      toolCalls: [{
        id: 'tc-1', name: 'query_knowledge_base', args: '{"query":"rollout"}',
        result: JSON.stringify([{ source: S3, title: 'ADR 12' }, { source: 's3://b/adr-013.txt' }]),
        truncated: true,
      }],
    }],
  };
  const msgs = await withFetch(() => jsonResponse(capped), () => fetchSessionMessages('s-2'));
  const { sources, provenance } = deriveSources({ content: msgs[0]!.content, toolCalls: msgs[0]!.toolCalls });
  assert.equal(provenance.documentsRetrieved, 2);
  assert.deepEqual(sources.map(s => s.label), ['ADR 12', 'adr-013']);
});

test('a turn stored before provenance existed restores as text with no chips', async () => {
  const legacy = {
    events: [{
      eventId: 'evt-old', sessionId: 's-old', timestamp: '2026-08-01T00:00:00.000Z', role: 'ASSISTANT',
      text: 'Priya Raman knows auth best. [Source: Search agent]',
    }],
  };
  const msgs = await withFetch(() => jsonResponse(legacy), () => fetchSessionMessages('s-old'));
  assert.deepEqual(msgs[0]!.toolCalls, []);
  const { sources, provenance } = deriveSources({ content: msgs[0]!.content, toolCalls: msgs[0]!.toolCalls });
  assert.deepEqual(sources, []);
  // Still honest about the citation it removed — that part never depended on
  // stored tool calls.
  assert.equal(provenance.unverifiedClaims, 1);
});

test('an empty conversation is empty — no error', async () => {
  const msgs = await withFetch(() => jsonResponse({ events: [] }), () => fetchSessionMessages('s-empty'));
  assert.deepEqual(msgs, []);
});

test('an expired session is reported as such, not as an empty conversation', async () => {
  await withFetch(() => jsonResponse({ error: 'Unauthenticated' }, 401), async () => {
    await assert.rejects(
      () => fetchSessionMessages('s-1'),
      (err: unknown) => {
        assert.ok(err instanceof SessionHistoryError);
        assert.equal((err as SessionHistoryError).status, 401);
        assert.equal((err as SessionHistoryError).needsAuth, true);
        assert.match((err as SessionHistoryError).message, /sign in/i);
        return true;
      },
    );
  });
});

test('a server error is a load failure, distinct from an auth problem', async () => {
  await withFetch(() => jsonResponse({ error: 'boom' }, 500), async () => {
    await assert.rejects(
      () => fetchSessionMessages('s-1'),
      (err: unknown) => {
        assert.ok(err instanceof SessionHistoryError);
        assert.equal((err as SessionHistoryError).status, 500);
        assert.equal((err as SessionHistoryError).needsAuth, false);
        assert.match((err as SessionHistoryError).message, /HTTP 500/);
        return true;
      },
    );
  });
});

test('an unreachable server throws rather than reporting an empty conversation', async () => {
  await withFetch(() => Promise.reject(new TypeError('Failed to fetch')), async () => {
    await assert.rejects(() => fetchSessionMessages('s-1'), SessionHistoryError);
  });
});

test('a malformed body is a load failure, not an empty conversation', async () => {
  await withFetch(
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('bad json')) } as Response),
    async () => { await assert.rejects(() => fetchSessionMessages('s-1'), SessionHistoryError); },
  );
  await withFetch(() => jsonResponse({ notEvents: true }), async () => {
    await assert.rejects(() => fetchSessionMessages('s-1'), SessionHistoryError);
  });
});
