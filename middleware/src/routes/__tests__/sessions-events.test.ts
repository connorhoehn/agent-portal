// GET /api/sessions/:sessionId/events (routes/sessions.ts) — the stored
// transcript one conversation restores from.
//
// What is pinned:
//   * `toolCalls` PROVENANCE surviving the read. That array is what the portal
//     turns back into source chips and the "searched knowledge base ×3" line;
//     a turn written before tool-call persistence simply has no `toolCalls`
//     key and must restore as plain text, exactly as it did,
//   * the `{events}` envelope and the role vocabulary the transcript renderer
//     switches on,
//   * that the transcript is the signed-in user's (lib/memory-actor.ts): an
//     `?actorId=` used to read anyone's conversation and is now ignored,
//   * an unknown session reading as an EMPTY transcript, not a 404: a brand-new
//     conversation has no events yet and must not look like an error.

jest.mock('../../providers/memory.js', () => ({
  listSessions: jest.fn(), listEvents: jest.fn(), memoryConfigured: jest.fn(() => true),
}));
jest.mock('../../lib/session-titles.js', () => ({
  getSessionTitle: jest.fn(), beginBackfill: jest.fn(() => false),
  generateTitleReserved: jest.fn(), markUntitleable: jest.fn(), releaseBackfill: jest.fn(),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { sessionsRouter } from '../sessions.js';
import { errorHandler } from '../../lib/async-handler.js';
import { listEvents } from '../../providers/memory.js';

const eventsMock = listEvents as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = { sub: 'u-nora', tenant: 'orgiq', role: 'member', grants: {}, iat: 0 }; next(); });
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => { eventsMock.mockReset(); });

describe('GET /api/sessions/:sessionId/events', () => {
  it('preserves the tool-call provenance on an assistant turn', async () => {
    eventsMock.mockResolvedValue([
      { role: 'USER', text: 'who owns auth?', at: '2026-08-20T09:00:00Z' },
      {
        role: 'ASSISTANT', text: 'Nora Vance owns it.', at: '2026-08-20T09:00:04Z',
        toolCalls: [
          { name: 'kb_query', input: { q: 'auth owner' }, resultSummary: '3 documents' },
          { name: 'graph_read', input: {}, resultSummary: '1 person' },
        ],
      },
    ]);
    const res = await request(buildApp()).get('/api/sessions/sess-1/events');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['events']);
    const assistant = res.body.events[1];
    // The chips and the "searched knowledge base ×N" line are built from this.
    expect(assistant.toolCalls).toHaveLength(2);
    expect(assistant.toolCalls[0].name).toBe('kb_query');
    expect(assistant.toolCalls[0].resultSummary).toBe('3 documents');
  });

  it('restores a pre-provenance turn as plain text, with NO toolCalls key', async () => {
    eventsMock.mockResolvedValue([
      { role: 'ASSISTANT', text: 'an older answer', at: '2026-07-01T09:00:00Z' },
    ]);
    const res = await request(buildApp()).get('/api/sessions/sess-old/events');
    const turn = res.body.events[0];
    expect(turn.text).toBe('an older answer');
    // Absent, not an empty array — "we did not record this" is not "it used
    // no tools", and the renderer distinguishes them.
    expect(Object.prototype.hasOwnProperty.call(turn, 'toolCalls')).toBe(false);
  });

  it('reads the signed-in user\'s transcript, and ignores an ?actorId= naming anyone else', async () => {
    eventsMock.mockResolvedValue([]);
    const app = buildApp();
    await request(app).get('/api/sessions/sess-1/events');
    await request(app).get('/api/sessions/sess-1/events?actorId=u-rhea');
    await request(app).get('/api/sessions/sess-1/events?actorId=portal-default');
    expect(eventsMock.mock.calls).toEqual([
      ['sess-1', 'orgiq_u-nora'],
      ['sess-1', 'orgiq_u-nora'],
      ['sess-1', 'orgiq_u-nora'],
    ]);
  });

  it('refuses a caller with no signed-in user, and reads nothing', async () => {
    const app = express();
    app.use('/api/sessions', sessionsRouter);
    app.use(errorHandler);
    const res = await request(app).get('/api/sessions/sess-1/events?actorId=u-nora');
    expect(res.status).toBe(401);
    expect(eventsMock).not.toHaveBeenCalled();
  });

  it('reads a brand-new conversation as an EMPTY transcript, not a 404', async () => {
    eventsMock.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/sessions/sess-brand-new/events');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [] });
  });
});
