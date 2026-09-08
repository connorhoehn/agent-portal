// Route <-> test coverage for POST /api/assessment/knowledge/presence (see
// docs/assessment-journeys/stretch/realtime.md: presence never worked at all
// because no client ever announced itself — this route is the announcement
// half). Same harness as assessment-routes.test.ts: real router, real
// assessmentBroker singleton; only config.js and role-registry.js are
// stubbed so requireAction makes a real seed-policy decision against the
// mocked capability lists.
//
// Identity for the route comes from req.session, never the request body —
// these tests assert that explicitly by sending a spoofed sub/name and
// checking the broker recorded the SESSION's identity instead.

jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, auth: {} } }));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '', capabilities: [
      'ViewAssessment', 'ScoreAssessment', 'ManageSubmissions', 'RunAssessmentAgent', 'Search', 'LabelFeedback',
    ] },
  ],
}));

import express from 'express';
import request from '../../test-support/http.js';
import { assessmentRouter } from '../assessment.js';
import { errorHandler } from '../../lib/async-handler.js';
import { assessmentBroker } from '../../lib/assessment-broker.js';
import { type Session } from '../../lib/session.js';

function buildApp(session: Partial<Session> = { role: 'assessor' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-jonas', role: 'assessor', tenant: 'assessment', grants: {}, iat: 0, name: 'Jonas Lindqvist', ...session } as Session;
    next();
  });
  app.use('/api/assessment', assessmentRouter);
  app.use(errorHandler);
  return app;
}

const OUTSIDE_ROLE = 'member';

describe('POST /knowledge/presence', () => {
  it('204s an "enter" and the broker records the SESSION identity, not a spoofed body', async () => {
    const docId = `rule:presence-route-${Math.random()}`;
    const res = await request(buildApp())
      .post('/api/assessment/knowledge/presence')
      .send({ doc_id: docId, tab_id: 'tab-1', action: 'enter', sub: 'u-attacker', name: 'Someone Else' });
    expect(res.status).toBe(204);
    const viewers = assessmentBroker.viewersFor(docId);
    expect(viewers).toEqual([{ sub: 'u-jonas', name: 'Jonas Lindqvist', tab_id: 'tab-1', since: expect.any(String) }]);
  });

  it('"heartbeat" refreshes an already-entered tab without erroring', async () => {
    const docId = `rule:presence-route-${Math.random()}`;
    const app = buildApp();
    await request(app).post('/api/assessment/knowledge/presence').send({ doc_id: docId, tab_id: 'tab-1', action: 'enter' });
    const res = await request(app).post('/api/assessment/knowledge/presence').send({ doc_id: docId, tab_id: 'tab-1', action: 'heartbeat' });
    expect(res.status).toBe(204);
    expect(assessmentBroker.viewersFor(docId)).toHaveLength(1);
  });

  // `leave` is staged behind a short grace, not applied on the spot: a tab's
  // teardown `leave` can land after its remount's `enter` (StrictMode,
  // navigate-away-and-back), and an immediate delete made the viewer vanish
  // from their own roster until the next heartbeat. Real timers here —
  // supertest's HTTP round trip does not survive Jest's fake ones.
  it('"leave" removes the tab from the roster after the grace period', async () => {
    const docId = `rule:presence-route-${Math.random()}`;
    const app = buildApp();
    await request(app).post('/api/assessment/knowledge/presence').send({ doc_id: docId, tab_id: 'tab-1', action: 'enter' });
    const res = await request(app).post('/api/assessment/knowledge/presence').send({ doc_id: docId, tab_id: 'tab-1', action: 'leave' });
    expect(res.status).toBe(204);
    expect(assessmentBroker.viewersFor(docId)).toHaveLength(1);   // still listed, in grace
    await new Promise((r) => setTimeout(r, 2_300));
    expect(assessmentBroker.viewersFor(docId)).toEqual([]);        // gone after the grace
  });

  it('two tabs of the same signed-in user are two roster entries under one sub', async () => {
    const docId = `rule:presence-route-${Math.random()}`;
    const app = buildApp();
    await request(app).post('/api/assessment/knowledge/presence').send({ doc_id: docId, tab_id: 'tab-a', action: 'enter' });
    await request(app).post('/api/assessment/knowledge/presence').send({ doc_id: docId, tab_id: 'tab-b', action: 'enter' });
    const viewers = assessmentBroker.viewersFor(docId);
    expect(viewers).toHaveLength(2);
    expect(new Set(viewers.map((v) => v.sub))).toEqual(new Set(['u-jonas']));
  });

  it('400s a missing doc_id', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/knowledge/presence')
      .send({ tab_id: 'tab-1', action: 'enter' });
    expect(res.status).toBe(400);
  });

  it('400s a missing tab_id', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/knowledge/presence')
      .send({ doc_id: 'rule:x', action: 'enter' });
    expect(res.status).toBe(400);
  });

  it('400s an invalid action', async () => {
    const res = await request(buildApp())
      .post('/api/assessment/knowledge/presence')
      .send({ doc_id: 'rule:x', tab_id: 'tab-1', action: 'teleport' });
    expect(res.status).toBe(400);
  });

  it('403s a role with no ViewAssessment', async () => {
    const res = await request(buildApp({ role: OUTSIDE_ROLE }))
      .post('/api/assessment/knowledge/presence')
      .send({ doc_id: 'rule:x', tab_id: 'tab-1', action: 'enter' });
    expect(res.status).toBe(403);
  });
});

// sendBeacon may deliver `leave` as text/plain during teardown; that body
// used to be unparsed and the handler 500'd on `.doc_id` of undefined.
describe('POST /knowledge/presence — beacon encoding', () => {
  it('accepts a text/plain JSON body and 400s a non-JSON one', async () => {
    const app = buildApp();
    const ok = await request(app).post('/api/assessment/knowledge/presence')
      .set('Content-Type', 'text/plain;charset=UTF-8')
      .send(JSON.stringify({ doc_id: 'rules/scoring-stance', tab_id: 'b1', action: 'leave' }));
    expect(ok.status).toBe(204);
    const bad = await request(app).post('/api/assessment/knowledge/presence')
      .set('Content-Type', 'text/plain').send('not json');
    expect(bad.status).toBe(400);
  });
});
