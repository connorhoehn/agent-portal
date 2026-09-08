// GET /api/assessment/events — the `stream.gap` frame a reconnecting client
// gets when its Last-Event-ID predates the ring buffer's retention window
// (assessment-broker.ts's `gapFrameFor`, BUFFER_CAPACITY = 500). Without this
// wire-up, a client whose missed events were evicted looked identical to one
// that was fully caught up — both just got "whatever's currently buffered"
// with no signal anything was lost. Same SSE-over-a-real-socket harness as
// assessment.test.ts's "GET /events" describe block (supertest buffers a
// full response before resolving, which a long-lived stream never does).

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'ManageSubmissions', 'RunAssessmentAgent', 'Search', 'LabelFeedback',
    ] },
  ],
}));

import express from 'express';
import http from 'node:http';
import { attachToSharedServer } from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { assessmentBroker } from '../../lib/assessment-broker.js';
import { type Session } from '../../lib/session.js';

function buildApp(session: Partial<Session> = { role: 'assessor' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', role: 'assessor', tenant: 'assessment', grants: {}, iat: 0, ...session } as Session;
    next();
  });
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

// The stream is read over a raw socket (supertest buffers), but the socket
// goes to the file's ONE shared server rather than a listener of this suite's
// own — see src/test-support/http.ts. `attachToSharedServer` registers the app
// and hands back the port plus the header that routes to it.
function readChunks(app: express.Express, headers: Record<string, string>, onData: (chunk: string) => boolean): Promise<string> {
  const { port, headers: appHeaders } = attachToSharedServer(app);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/assessment/events', headers: { ...appHeaders, ...headers } }, (res) => {
      let buf = '';
      res.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        if (onData(buf)) {
          req.destroy();
          resolve(buf);
        }
      });
      res.on('error', () => resolve(buf));
    });
    req.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') resolve('');
      else reject(err);
    });
  });
}

describe('GET /events — stream.gap on a reconnect that predates the buffer', () => {
  it('precedes the replay with a stream.gap frame when Last-Event-ID is older than the buffer can cover', async () => {
    const before = assessmentBroker.publish({ type: 'knowledge.pulled', section: 'gap-target', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    // Evict `before` AND the event immediately after it (BUFFER_CAPACITY=500,
    // so >501 more publishes guarantees both are pushed out) — a client that
    // last saw `before` is now missing at least one real event, not just the
    // frame it already had.
    for (let i = 0; i < 502; i += 1) {
      assessmentBroker.publish({ type: 'knowledge.pulled', section: `filler-${i}`, pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    }

    const buf = await readChunks(buildApp(), { 'Last-Event-ID': assessmentBroker.frameId(before.seq) }, (b) => b.includes('"section":"filler-501"'));
    const gapIdx = buf.indexOf('"type":"stream.gap"');
    // BUFFER_CAPACITY=500 against 503 total publishes evicts exactly 3
    // (`before`, filler-0, filler-1) — filler-2 is the oldest still held.
    const replayIdx = buf.indexOf('"section":"filler-2"');
    expect(gapIdx).toBeGreaterThanOrEqual(0);
    expect(replayIdx).toBeGreaterThan(gapIdx);
  });

  it('does not emit stream.gap for a fresh connection (which also gets no history replay — see assessment.test.ts)', async () => {
    const gotLive = readChunks(buildApp(), {}, (b) => b.includes('"section":"no-gap-fresh"'));
    // Published only after the fresh connection is open, so this proves
    // "live events still arrive, with no gap frame" without relying on
    // history replay (a fresh connection gets none — decideReplay).
    await new Promise((r) => setTimeout(r, 50));
    assessmentBroker.publish({ type: 'knowledge.pulled', section: 'no-gap-fresh', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const buf = await gotLive;
    expect(buf).not.toContain('"type":"stream.gap"');
  });

  it('does not emit stream.gap for a reconnect whose Last-Event-ID is still within the buffer AND the age bound', async () => {
    const before = assessmentBroker.publish({ type: 'knowledge.pulled', section: 'recent-anchor', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const gotLive = readChunks(buildApp(), { 'Last-Event-ID': assessmentBroker.frameId(before.seq) }, (b) => b.includes('"section":"no-gap-live"'));
    await new Promise((r) => setTimeout(r, 50));
    assessmentBroker.publish({ type: 'knowledge.pulled', section: 'no-gap-live', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const buf = await gotLive;
    expect(buf).not.toContain('"type":"stream.gap"');
  });

  // DEFECTS #5/#8/#7's other half: even when the ring buffer never evicted
  // anything (BUFFER_CAPACITY untouched), a Last-Event-ID older than
  // REPLAY_MAX_AGE_MS must still surface a gap — a quiet tenant can hold an
  // hours-old event well inside a 500-slot buffer.
  it('emits stream.gap on a reconnect whose Last-Event-ID is within the buffer but past the age bound', async () => {
    const stale = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45m old; bound is 30m
    const before = assessmentBroker.publish({ type: 'knowledge.pulled', section: 'aged-marker', pages: 1, files_pulled: 1, ts: stale });
    assessmentBroker.publish({ type: 'knowledge.pulled', section: 'aged-followup', pages: 1, files_pulled: 1, ts: stale });

    const promise = readChunks(buildApp(), { 'Last-Event-ID': assessmentBroker.frameId(before.seq) }, (b) => b.includes('"section":"live-marker"'));
    await new Promise((r) => setTimeout(r, 50));
    assessmentBroker.publish({ type: 'knowledge.pulled', section: 'live-marker', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const buf = await promise;
    expect(buf).toContain('"type":"stream.gap"');
    // The stale follow-up is inside the excluded age window, not merely
    // missed — it must not be delivered even though it's still ring-buffer
    // resident.
    expect(buf).not.toContain('"section":"aged-followup"');
  });
});
