// The shared error handler answers a body over express.json's limit with 413 and one plain sentence, never a 500
// (H8 finding 1, OWED O-243). The pad log's real-app proof is routes/__tests__/interviews-pad-limits.test.ts.
import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler, TOO_LARGE } from '../async-handler.js';

const app = express();
app.use(express.json({ limit: '1kb' }));
app.post('/echo', (req, res) => { res.json({ got: Object.keys(req.body ?? {}).length }); });
app.use(errorHandler);

it('a body over the limit is a 413 with a plain sentence, never a 500', async () => {
  const r = await request(app).post('/echo').set('content-type', 'application/json').send(JSON.stringify({ text: 'x'.repeat(4096) }));
  expect([r.status, r.body.error]).toEqual([413, TOO_LARGE]);
});

it('a body under the limit is read as before', async () => {
  const r = await request(app).post('/echo').send({ a: 1 });
  expect([r.status, r.body.got]).toEqual([200, 1]);
});
