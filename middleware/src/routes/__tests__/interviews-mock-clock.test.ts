// POST /api/__mock/interviews/clock (routes/mock-control.ts): a walk moves the interviews tenant's clock and runs
// a sweep at that time; a mock reset puts the clock back. The clock itself is lib/interviews/__tests__/clock.test.ts.
jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));

import express from 'express';
import request from '../../test-support/http.js';
import { mockControlRouter } from '../mock-control.js';
import { interviewsClockOffsetMs, resetInterviewsClock } from '../../lib/interviews/clock.js';

const DAY = 86_400_000;

function app() {
  const a = express();
  a.use(express.json());
  a.use(mockControlRouter);
  return a;
}

describe('POST /api/__mock/interviews/clock', () => {
  afterEach(() => resetInterviewsClock());

  it('reads the clock, moves it, and puts it back', async () => {
    const read = await request(app()).post('/api/__mock/interviews/clock').send({});
    expect(read.status).toBe(200);
    expect(read.body.offsetMs).toBe(0);
    expect(Math.abs(new Date(read.body.now).getTime() - Date.now())).toBeLessThan(5000);

    const moved = await request(app()).post('/api/__mock/interviews/clock').send({ offsetMs: 91 * DAY });
    expect(moved.status).toBe(200);
    expect(moved.body.offsetMs).toBe(91 * DAY);
    expect(Math.abs(new Date(moved.body.now).getTime() - (Date.now() + 91 * DAY))).toBeLessThan(5000);
    expect(interviewsClockOffsetMs()).toBe(91 * DAY);

    const back = await request(app()).post('/api/__mock/interviews/clock').send({ offsetMs: 0 });
    expect(back.body.offsetMs).toBe(0);
  });

  it('refuses an offset that is not a number within ten years, and a sweep it does not know, changing nothing', async () => {
    await request(app()).post('/api/__mock/interviews/clock').send({ offsetMs: DAY });
    for (const body of [{ offsetMs: 'tomorrow' }, { offsetMs: 11 * 366 * DAY }, { sweep: 'everything' }]) {
      const r = await request(app()).post('/api/__mock/interviews/clock').send(body);
      expect(r.status).toBe(400);
      expect(typeof r.body.error).toBe('string');
    }
    expect(interviewsClockOffsetMs()).toBe(DAY);
  });

  it('runs one starting-soon pass and one retention pass on request, and says what each did', async () => {
    const soon = await request(app()).post('/api/__mock/interviews/clock').send({ sweep: 'soon' });
    expect(soon.status).toBe(200);
    expect(typeof soon.body.sweep.rang).toBe('number');
    const retention = await request(app()).post('/api/__mock/interviews/clock').send({ sweep: 'retention' });
    expect(retention.status).toBe(200);
    expect(retention.body.sweep).toEqual(expect.objectContaining({ retried: expect.any(Number), media: expect.any(Number), records: expect.any(Number) }));
  });

  it('a full mock reset puts the clock back', async () => {
    await request(app()).post('/api/__mock/interviews/clock').send({ offsetMs: 5 * DAY });
    expect(interviewsClockOffsetMs()).toBe(5 * DAY);
    const reset = await request(app()).post('/api/__mock/reset').send({});
    expect(reset.status).toBe(200);
    expect(interviewsClockOffsetMs()).toBe(0);
  });
});
