// GET /api/assessment/events — the `stream.gap` frame a reconnecting client
// gets when its Last-Event-ID predates the replay store's retention window.
// Without this wire-up, a client whose missed events were evicted looked
// identical to one that was fully caught up — both just got "whatever's
// currently buffered" with no signal anything was lost. Same SSE-over-a-real-
// socket harness as assessment.test.ts's "GET /events" describe block
// (supertest buffers a full response before resolving, which a long-lived
// stream never does).
//
// Retention is now PARTITIONED (`Map<partitionKey, ring>` in
// lib/assessment-broker.ts, REVIEW-2026-09-05 finding #7), so the first test
// below had to change shape: it used to prove eviction by publishing 502
// events on 502 DIFFERENT sections, which is precisely the "an unrelated
// flurry elsewhere in the tenant blows your retention window" behaviour the
// partitioning removes. It now floods ONE section past that partition's own
// capacity — a real same-resource eviction — and the last test in the file is
// the regression guard for the other half: an unrelated presence flood must
// NOT cost a client its knowledge save.

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
import { assessmentBroker, REPLAY_CHANNELS } from '../../lib/assessment-broker.js';
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
  it('precedes the replay with a stream.gap frame when Last-Event-ID is older than the partition can cover', async () => {
    // All of these land in ONE partition (`pull:gap-target`) because
    // `knowledge.pulled` keys on its section — so this is a genuine
    // same-resource eviction, not one resource crowding out another.
    const CAP = REPLAY_CHANNELS.pull.capacity;
    const FILLERS = CAP + 2; // evicts `before`, filler-0 and filler-1
    const before = assessmentBroker.publish({ type: 'knowledge.pulled', section: 'gap-target', pages: 0, files_pulled: 0, ts: new Date().toISOString() });
    // `files_pulled` numbers the fillers so the reader can stop on the last
    // one's DATA line. Stopping on its `id:` line would be a trap: writeSSE
    // emits `id:` and `data:` as two separate writes, and the gap frame's id
    // is `frameId(current seq)` — the same id as the newest event — so an
    // id-only predicate can fire on the gap frame's id and cut the socket
    // before its payload ever arrives.
    for (let i = 0; i < FILLERS; i += 1) {
      assessmentBroker.publish({ type: 'knowledge.pulled', section: 'gap-target', pages: 1, files_pulled: i, ts: new Date().toISOString() });
    }

    const buf = await readChunks(buildApp(), { 'Last-Event-ID': assessmentBroker.frameId(before.seq) }, (b) => b.includes(`"files_pulled":${FILLERS - 1}`));
    const gapIdx = buf.indexOf('"type":"stream.gap"');
    // `before` + FILLERS = CAP + 3 pushes into a CAP-slot ring evicts exactly
    // 3 — `before` and the two after it — so the frame at `before.seq + 3` is
    // the oldest still held, and it must land AFTER the gap frame.
    const replayIdx = buf.indexOf(`id: ${assessmentBroker.frameId(before.seq + 3)}\n`);
    expect(gapIdx).toBeGreaterThanOrEqual(0);
    expect(replayIdx).toBeGreaterThan(gapIdx);
    // ...and the two that WERE evicted are genuinely absent, not merely late.
    expect(buf).not.toContain(`id: ${assessmentBroker.frameId(before.seq + 1)}\n`);
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
    // missed — it must not be delivered even though it's still resident.
    expect(buf).not.toContain('"section":"aged-followup"');
  });

  // ── The regression this whole item exists for (REVIEW-2026-09-05 #7) ──
  //
  // Presence is the highest-frequency event type on this tenant. Under the
  // old single 500-slot ring, 800 roster updates across the tenant pushed a
  // knowledge save clean out of retention, and the reconnecting client got a
  // truthful-but-avoidable `stream.gap` for a save the server still had every
  // reason to be holding. With `presence:<doc_id>` partitions — one slot
  // each, superseding — the save sits untouched in `doc:<id>` and the
  // reconnect is not gapped at all.
  it('a presence flood far past the old 500-slot buffer does NOT evict a knowledge save still inside the window', async () => {
    const anchor = assessmentBroker.publish({ type: 'knowledge.pulled', section: 'flood-anchor', pages: 1, files_pulled: 1, ts: new Date().toISOString() });
    const save = assessmentBroker.publish({
      type: 'knowledge.doc.saved', id: 'rule:scoring-guardrails.md', stamp: 's-flood', by: 'u-jonas', ts: new Date().toISOString(),
    });

    // 20 docs x 40 roster updates = 800 presence events, well past the 500
    // that used to be the whole tenant's retention.
    for (let round = 0; round < 40; round += 1) {
      for (let doc = 0; doc < 20; doc += 1) {
        assessmentBroker.publish({
          type: 'knowledge.presence',
          doc_id: `flood-doc-${doc}`,
          viewers: [{ sub: 'u-amina', name: 'Amina', tab_id: `tab-${round}`, since: new Date().toISOString() }],
          ts: new Date().toISOString(),
        });
      }
    }

    const promise = readChunks(buildApp(), { 'Last-Event-ID': assessmentBroker.frameId(anchor.seq) }, (b) => b.includes('"stamp":"flood-live"'));
    await new Promise((r) => setTimeout(r, 50));
    assessmentBroker.publish({ type: 'knowledge.doc.saved', id: 'rule:scoring-guardrails.md', stamp: 'flood-live', by: 'u-jonas', ts: new Date().toISOString() });
    const buf = await promise;

    // The save the client missed is replayed...
    expect(buf).toContain('"stamp":"s-flood"');
    expect(buf).toContain(`id: ${assessmentBroker.frameId(save.seq)}\n`);
    // ...and, because nothing it needed was thrown away, it is NOT told it
    // missed anything. (`stream.gap` is still emitted for real losses — the
    // three tests above.)
    expect(buf).not.toContain('"type":"stream.gap"');
  });
});
