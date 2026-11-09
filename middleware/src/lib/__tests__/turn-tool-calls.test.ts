// Chat-history provenance: the tool calls a turn made must survive storage.
//
// What broke: `recordTurn` wrote a turn's text and nothing else, so a
// conversation that showed source chips live showed none when reopened — the
// same claim with its evidence quietly removed. These tests cover the storage
// half: the caps that keep a turn's tool calls small enough to ride along on
// the Memory event, and the round trip through the provider.
//
// The load-bearing property is not "smaller". It is that what comes back is
// still TRUE: a capped retrieval result must remain parseable JSON naming the
// same documents, because `retrievedDocuments()` JSON.parses it and a failed
// parse renders as "knowledge base searched — no documents matched" — a false
// statement about the answer's evidence.

const mockSend = jest.fn();

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    agentcore: { memoryId: 'mem-test' },
  },
}));

jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class {
    send(cmd: unknown) { return mockSend(cmd); }
  },
  CreateEventCommand: class { constructor(public readonly input: any) {} },
  ListEventsCommand: class { constructor(public readonly input: any) {} },
  ListSessionsCommand: class { constructor(public readonly input: any) {} },
}));

import {
  capToolCalls,
  decodeToolCalls,
  distillRetrievalResult,
  encodeToolCalls,
  isToolCallsPayload,
  MAX_ARGS_CHARS,
  MAX_ENVELOPE_CHARS,
  MAX_RESULT_CHARS,
  MAX_TOOL_CALLS,
  TOOL_CALLS_MARKER,
  type StoredToolCall,
} from '../turn-tool-calls.js';
import { listEvents, recordTurn } from '../../providers/memory.js';
import { memoryActor } from '../memory-actor.js';

type Payload = Array<{ conversational: { role: string; content: { text: string } } }>;

/** A retrieval result the way `query_knowledge_base` returns it: fat passages. */
function retrievalResult(n: number): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      content: 'x'.repeat(2_000),
      score: 0.9,
      source: `s3://orgiq-documents-123456789012-us-east-1/perf/doc-${String(i).padStart(2, '0')}.txt`,
      title: `Doc ${i}`,
    })),
  );
}

describe('capToolCalls', () => {
  it('leaves a small call untouched', () => {
    const calls: StoredToolCall[] = [
      { id: 't1', name: 'query_graph', args: '{"sql":"SELECT * FROM people"}', result: '[{"id":"p-1"}]' },
    ];
    expect(capToolCalls(calls)).toEqual(calls);
  });

  it('drops calls with no name — a nameless call derives no chip and no summary', () => {
    expect(capToolCalls([{ name: '' }, { name: '   ' }] as StoredToolCall[])).toEqual([]);
    expect(capToolCalls(undefined)).toEqual([]);
  });

  it('caps args but keeps the head, where the sql/url a chip reads lives', () => {
    const sql = `{"sql":"SELECT * FROM people WHERE ${'a'.repeat(5_000)}"}`;
    const [out] = capToolCalls([{ name: 'query_graph', args: sql }]);
    expect(out?.args?.length).toBeLessThanOrEqual(MAX_ARGS_CHARS);
    expect(out?.args?.startsWith('{"sql":"SELECT * FROM people')).toBe(true);
    expect(out?.truncated).toBe(true);
  });

  it('distills an oversized retrieval result instead of truncating it', () => {
    const raw = retrievalResult(40);
    expect(raw.length).toBeGreaterThan(MAX_RESULT_CHARS);

    const [out] = capToolCalls([{ id: 't1', name: 'query_knowledge_base', result: raw }]);
    expect(out?.truncated).toBe(true);
    expect(out?.result?.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);

    // Still valid JSON — a plain slice() would not be — and still names every
    // document, so `documentsRetrieved` survives the round trip.
    const parsed = JSON.parse(out?.result ?? '') as Array<{ source: string; title?: string }>;
    expect(parsed).toHaveLength(40);
    expect(parsed[0]?.source).toContain('s3://');
    expect(parsed[0]?.title).toBe('Doc 0');
    // The passage bodies — the reason it was oversized — are gone.
    expect(out?.result).not.toContain('xxxx');
  });

  it('falls back to plain truncation for a non-JSON (A2A prose) result', () => {
    const prose = `The top two Kubernetes experts are: ${'word '.repeat(2_000)}`;
    const [out] = capToolCalls([{ name: 'get_expertise_scores', result: prose }]);
    expect(out?.result?.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out?.result?.endsWith('…[truncated]')).toBe(true);
    expect(out?.truncated).toBe(true);
  });

  it('keeps at most MAX_TOOL_CALLS, in order of appearance', () => {
    const many = Array.from({ length: MAX_TOOL_CALLS + 6 }, (_, i) => ({ name: `tool_${i}` }));
    const out = capToolCalls(many);
    expect(out).toHaveLength(MAX_TOOL_CALLS);
    expect(out[0]?.name).toBe('tool_0');
    expect(out[MAX_TOOL_CALLS - 1]?.name).toBe(`tool_${MAX_TOOL_CALLS - 1}`);
  });

  it('honours the envelope ceiling by dropping WHOLE calls, never gutting a kept one', () => {
    // A retrieval call whose result is kept in full is what makes a chip; a
    // call kept with its result stripped would read as "retrieved nothing".
    const heavy = Array.from({ length: MAX_TOOL_CALLS }, (_, i) => ({
      id: `t${i}`,
      name: 'query_knowledge_base',
      result: JSON.stringify([{ source: `s3://b/${'k'.repeat(3_800)}-${i}.txt` }]),
    }));
    const out = capToolCalls(heavy);

    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_ENVELOPE_CHARS);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(MAX_TOOL_CALLS);
    for (const tc of out) {
      expect(typeof tc.result).toBe('string');
      expect(JSON.parse(tc.result as string)).toHaveLength(1);
    }
  });
});

describe('distillRetrievalResult', () => {
  it('reads every uri shape retrievedDocuments() reads', () => {
    const raw = JSON.stringify({
      results: [
        { uri: 's3://b/a.txt', content: 'x' },
        { sourceUri: 's3://b/b.txt' },
        { location: { s3Location: { uri: 's3://b/c.txt' } }, title: 'C' },
      ],
    });
    expect(distillRetrievalResult(raw)).toEqual([
      { source: 's3://b/a.txt' },
      { source: 's3://b/b.txt' },
      { source: 's3://b/c.txt', title: 'C' },
    ]);
  });

  it('returns null for prose and for JSON that names no documents', () => {
    expect(distillRetrievalResult('The top two experts are…')).toBeNull();
    expect(distillRetrievalResult('[{"score":0.9}]')).toBeNull();
    expect(distillRetrievalResult('{"answer":"none"}')).toBeNull();
  });
});

describe('encode / decode', () => {
  it('round-trips a turn and marks its payload', () => {
    const calls: StoredToolCall[] = [
      { id: 't1', name: 'query_knowledge_base', args: '{"query":"kubernetes"}', result: '[{"source":"s3://b/a.txt"}]' },
      { id: 't2', name: 'get_expertise_scores', args: '{"skill":"Kubernetes"}', result: 'Sarah Thompson 87.63' },
    ];
    const encoded = encodeToolCalls(calls);
    expect(encoded?.startsWith(TOOL_CALLS_MARKER)).toBe(true);
    expect(isToolCallsPayload(encoded ?? '')).toBe(true);
    expect(decodeToolCalls(encoded ?? '')).toEqual(calls);
  });

  it('writes nothing when a turn made no tool calls', () => {
    expect(encodeToolCalls([])).toBeNull();
    expect(encodeToolCalls(undefined)).toBeNull();
  });

  it('treats ordinary prose and malformed envelopes as "no provenance", never an error', () => {
    expect(isToolCallsPayload('The top two experts are…')).toBe(false);
    expect(decodeToolCalls('The top two experts are…')).toBeNull();
    expect(decodeToolCalls(`${TOOL_CALLS_MARKER}{not json`)).toBeNull();
    expect(decodeToolCalls(`${TOOL_CALLS_MARKER}[{"noname":1}]`)).toBeNull();
    expect(decodeToolCalls(undefined)).toBeNull();
  });
});

describe('recordTurn → listEvents round trip', () => {
  beforeEach(() => { mockSend.mockReset(); });

  /** Replay a CreateEvent payload back through ListEvents, as Memory would. */
  function replay(payload: Payload) {
    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({
      events: [{
        eventId: 'evt-1',
        eventTimestamp: new Date('2026-08-24T18:34:38.727Z'),
        payload,
      }],
    });
  }

  it('persists the turn s tool calls and restores them onto the assistant message', async () => {
    mockSend.mockResolvedValueOnce({});
    await recordTurn({
      sessionId: 's-1',
      actorId: 'orgiq_u-rhea',
      userMessage: 'Who are the top two Kubernetes experts?',
      assistantMessage: 'Sarah Thompson and Marcus Müller.',
      toolCalls: [
        { id: 't1', name: 'query_knowledge_base', args: '{"query":"kubernetes"}', result: '[{"source":"s3://b/a.txt","title":"ADR 12"}]' },
      ],
    });

    const payload = mockSend.mock.calls[0]?.[0]?.input?.payload as Payload;
    expect(mockSend.mock.calls[0]?.[0]?.input?.actorId).toBe('orgiq_u-rhea');
    expect(payload.map((p) => p.conversational.role)).toEqual(['USER', 'ASSISTANT', 'TOOL']);

    replay(payload);
    const events = await listEvents('s-1', 'orgiq_u-rhea');

    // The TOOL payload is bookkeeping — it must never render as a message.
    expect(events.map((e) => e.role)).toEqual(['USER', 'ASSISTANT']);
    expect(events[0]?.toolCalls).toBeUndefined();
    expect(events[1]?.toolCalls).toEqual([
      { id: 't1', name: 'query_knowledge_base', args: '{"query":"kubernetes"}', result: '[{"source":"s3://b/a.txt","title":"ADR 12"}]' },
    ]);
  });

  it('keeps the transcript when the service rejects the provenance payload', async () => {
    // Provenance is an enrichment. A memory resource that will not take the
    // TOOL item must not cost the user the turn itself.
    mockSend.mockRejectedValueOnce(new Error('ValidationException: unsupported role'));
    mockSend.mockResolvedValueOnce({});
    await recordTurn({
      sessionId: 's-1',
      actorId: 'orgiq_u-rhea',
      userMessage: 'hi',
      assistantMessage: 'hello',
      toolCalls: [{ id: 't1', name: 'query_graph', args: '{}', result: '[]' }],
    });
    expect(mockSend).toHaveBeenCalledTimes(2);
    const retryPayload = mockSend.mock.calls[1]?.[0]?.input?.payload as Payload;
    expect(retryPayload.map((p) => p.conversational.role)).toEqual(['USER', 'ASSISTANT']);
  });

  it('writes no TOOL payload for a turn with no tool calls', async () => {
    mockSend.mockResolvedValueOnce({});
    await recordTurn({ sessionId: 's-1', actorId: 'orgiq_u-rhea', userMessage: 'hi', assistantMessage: 'hello' });
    const payload = mockSend.mock.calls[0]?.[0]?.input?.payload as Payload;
    expect(payload).toHaveLength(2);
  });

  it('restores a pre-provenance transcript exactly as before — text, no chips', async () => {
    replay([
      { conversational: { role: 'USER', content: { text: 'Who knows auth best?' } } },
      { conversational: { role: 'ASSISTANT', content: { text: 'Priya Raman. *Source: Search agent*' } } },
    ]);
    const events = await listEvents('s-old', 'orgiq_u-rhea');
    expect(events).toHaveLength(2);
    expect(events[1]?.text).toContain('Priya Raman');
    expect(events[1]?.toolCalls).toBeUndefined();
  });
});

describe('memoryActor — the transcript belongs to the signed-in user', () => {
  it('is one actor per user per tenant, from the session only', () => {
    expect(memoryActor({ sub: 'u-rhea', tenant: 'orgiq' })).toBe('orgiq_u-rhea');
    expect(memoryActor({ sub: 'u-rhea', tenant: 'assessment' })).toBe('assessment_u-rhea');
    expect(memoryActor({ sub: 'u-omar', tenant: 'orgiq' })).not.toBe(memoryActor({ sub: 'u-rhea', tenant: 'orgiq' }));
  });
  it('has no actor without a signed-in user, so nothing is read or written', () => {
    expect(memoryActor(null)).toBeNull();
    expect(memoryActor({ sub: '', tenant: 'orgiq' })).toBeNull();
    expect(memoryActor({ sub: 'u-rhea', tenant: '' })).toBeNull();
  });
  it('keeps a Cognito-style subject inside a conservative id charset', () => {
    expect(memoryActor({ sub: 'a1b2:c3@x', tenant: 'orgiq' })).toBe('orgiq_a1b2-c3-x');
  });
});
