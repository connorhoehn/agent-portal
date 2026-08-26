// Roster route (routes/roster.ts) — the eligible-people pick-list behind the
// sprint steward + grant grantee selectors (audit RM-5). What is pinned: the
// real path queries people (not one initiative's contributors), maps the
// is_sme aggregate to a boolean, drops rows with no id, and that mock mode
// falls back to the in-memory cast so dev:mock keeps parity.

const mockFlag = { value: false };

jest.mock('../../config.js', () => ({
  config: {
    get mock() { return { aurora: mockFlag.value, agentcore: true, guardrails: true, cloudwatch: true }; },
    region: 'us-east-1',
  },
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { rosterRouter } from '../roster.js';
import { errorHandler } from '../../lib/async-handler.js';
import { exec } from '../../providers/aurora.js';
import { mockPeople } from '../../mock/people.js';

const execMock = exec as unknown as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/roster', rosterRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockFlag.value = false;
  execMock.mockReset();
});

describe('GET /api/roster (real path)', () => {
  it('returns the whole people table with an isSme flag, not one initiative\'s contributors', async () => {
    execMock.mockResolvedValue([
      { id: 'p-004', name: 'Nora Vance', title: 'Staff Engineer', is_sme: true },
      { id: 'p-020', name: 'Diana Martinez', title: 'Head of Design', is_sme: false },
    ]);
    const res = await request(buildApp()).get('/api/roster');
    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([
      { id: 'p-004', name: 'Nora Vance', title: 'Staff Engineer', isSme: true },
      { id: 'p-020', name: 'Diana Martinez', title: 'Head of Design', isSme: false },
    ]);
    // The SQL reads `people`, so anyone in the org is eligible — the RM-5 fix.
    expect(String(execMock.mock.calls[0]![0])).toMatch(/FROM people/);
  });

  it('coerces a null title and drops a row with no id', async () => {
    execMock.mockResolvedValue([
      { id: 'p-001', name: 'Alex Chen', title: null, is_sme: false },
      { id: null, name: 'ghost', title: 'x', is_sme: false },
    ]);
    const res = await request(buildApp()).get('/api/roster');
    expect(res.body.people).toEqual([
      { id: 'p-001', name: 'Alex Chen', title: null, isSme: false },
    ]);
  });
});

describe('GET /api/roster (mock path)', () => {
  it('serves the in-memory cast without touching the Data API', async () => {
    mockFlag.value = true;
    const res = await request(buildApp()).get('/api/roster');
    expect(res.status).toBe(200);
    expect(execMock).not.toHaveBeenCalled();
    expect(res.body.people).toHaveLength(mockPeople.length);
    const ids = res.body.people.map((p: { id: string }) => p.id);
    expect(ids).toContain('p-001');
    // Every entry carries the contract shape (isSme present, false in mock).
    expect(res.body.people.every((p: { isSme: boolean }) => p.isSme === false)).toBe(true);
  });
});
