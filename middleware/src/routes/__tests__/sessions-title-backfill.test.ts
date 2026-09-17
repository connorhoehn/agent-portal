// GET /api/sessions title backfill: the wasteful-re-query fix.
//
// The backfill used to fire `listEvents` (a memory / Data-API read) on EVERY
// poll for any session lacking a cached title, because the de-dupe guard sat
// AFTER the read. Two settled outcomes re-queried forever: a session with no
// USER first message, and a generation that returned blank. These tests pin
// the fix: a settled session issues NO read on the next poll, while a
// titleable session still gets its title exactly once.
//
// config.ts uses import.meta (CJS test build can't compile it); the bedrock
// runtime client is ESM — both mocked, same pattern as the sibling tests.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1' },
}));

const listSessions = jest.fn();
const listEvents = jest.fn();
jest.mock('../../providers/memory.js', () => ({
  listSessions: (...a: unknown[]) => listSessions(...a),
  listEvents: (...a: unknown[]) => listEvents(...a),
  // The route asks the provider whether Memory is configured at all, so it can
  // say WHY an empty list is empty rather than telling the reader to go start a
  // conversation that cannot be recorded. These tests are about title
  // backfill, so configured is the state they mean.
  memoryConfigured: () => true,
}));

// Nova ConverseCommand — returns a fixed title so the titleable path is
// deterministic and never touches AWS.
const send = jest.fn(async () => ({
  output: { message: { content: [{ text: 'Kubernetes Experts' }] } },
}));
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: jest.fn(() => ({ send })),
  ConverseCommand: jest.fn((input: unknown) => ({ input })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { sessionsRouter } from '../sessions.js';
import { _resetTitleState, getSessionTitle } from '../../lib/session-titles.js';

function buildApp() {
  const app = express();
  app.use('/api/sessions', sessionsRouter);
  return app;
}

function session(sessionId: string) {
  return { sessionId, actorId: 'portal-default', createdAt: '2026-01-01T00:00:00Z' };
}

/** Let the fire-and-forget backfill (read + generation) drain. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
}

describe('GET /api/sessions title backfill', () => {
  beforeEach(() => {
    _resetTitleState();
    listSessions.mockReset();
    listEvents.mockReset();
    send.mockClear();
  });

  it('a permanently-untitleable session (no USER message) issues NO read on the second poll', async () => {
    const app = buildApp();
    listSessions.mockResolvedValue([session('s-no-user')]);
    // Events exist but none are USER-role → never titleable.
    listEvents.mockResolvedValue([
      { eventId: 'e1', sessionId: 's-no-user', timestamp: 't', role: 'ASSISTANT', text: 'hi' },
    ]);

    // First poll: reserves, reads once, settles as untitleable.
    await request(app).get('/api/sessions').expect(200);
    await flush();
    expect(listEvents).toHaveBeenCalledTimes(1);

    // Second poll: session is negative-cached → no read, no generation.
    await request(app).get('/api/sessions').expect(200);
    await flush();
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('a session whose generation returns blank is negative-cached (no re-read, no re-Nova)', async () => {
    const app = buildApp();
    listSessions.mockResolvedValue([session('s-blank')]);
    listEvents.mockResolvedValue([
      { eventId: 'e1', sessionId: 's-blank', timestamp: 't', role: 'USER', text: 'hello there' },
    ]);
    send.mockResolvedValueOnce({ output: { message: { content: [{ text: '   ' }] } } });

    await request(app).get('/api/sessions').expect(200);
    await flush();
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(getSessionTitle('s-blank')).toBeUndefined();

    // Second poll: settled as untitleable → nothing re-issued.
    await request(app).get('/api/sessions').expect(200);
    await flush();
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a titleable session gets its title exactly once, then is served from cache', async () => {
    const app = buildApp();
    listSessions.mockResolvedValue([session('s-ok')]);
    listEvents.mockResolvedValue([
      { eventId: 'e1', sessionId: 's-ok', timestamp: 't', role: 'USER', text: 'Who knows kubernetes?' },
    ]);

    // First poll: reads, generates the title.
    const r1 = await request(app).get('/api/sessions').expect(200);
    expect(r1.body.sessions[0].title).toBe(''); // async — not ready in-band
    await flush();
    expect(getSessionTitle('s-ok')).toBe('Kubernetes Experts');
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    // Second poll: served from cache — no further read, no further Nova call.
    const r2 = await request(app).get('/api/sessions').expect(200);
    await flush();
    expect(r2.body.sessions[0].title).toBe('Kubernetes Experts');
    expect(listEvents).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
