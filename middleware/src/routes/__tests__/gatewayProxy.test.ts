import express from 'express';
import request from '../../test-support/http.js';
import { gatewayProxyRouter } from '../gateway-proxy.js';

const app = express();
app.use(express.json());
app.use('/api/gateway', gatewayProxyRouter);

describe('retired generic gateway signing bridge', () => {
  const priorFetch = global.fetch;
  const fetchSpy = jest.fn();
  beforeEach(() => { fetchSpy.mockClear(); global.fetch = fetchSpy; });
  afterEach(() => { global.fetch = priorFetch; });

  function expectRetired(res: { status: number; body: { error: string } }) {
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/retired/);
    expect(fetchSpy).not.toHaveBeenCalled();
  }

  it('refuses publishing to arbitrary channels without signing an upstream call', async () => {
    expectRetired(await request(app).post('/api/gateway/channels/private-room/messages').send({ message: 'hello' }));
  });
  it('does not expose another channel presence roster', async () => {
    expectRetired(await request(app).get('/api/gateway/presence/other-tenant'));
  });
  it('does not expose another channel chat history', async () => {
    expectRetired(await request(app).get('/api/gateway/chat/assessment-secret/history'));
  });
  it('does not expose another channel activity through encoded channel names', async () => {
    expectRetired(await request(app).get('/api/gateway/activity/room%2Fprivate/history'));
  });
});
