// An offline allocation write used to read back attributed to the seed
// author (the release manager, six days ago) whatever session made it — the
// Aurora path stores updated_by/updated_at and the ledger renders both, so the
// mock was the one place a budget change could not be traced to a person.
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { upsertAllocation, getBudget } from '../budgets.js';
import { initiativeBudgets } from '../../mock/budgets.js';
import { freezeClock } from '../../mock/core/index.js';

const NOON = '2026-09-16T12:00:00.000Z';

beforeEach(() => {
  freezeClock(NOON);
  initiativeBudgets.reset();
});

describe('upsertAllocation offline', () => {
  it('attributes an updated allocation to the session that wrote it, stamped from the clock', async () => {
    const before = await getBudget('p-observability');
    expect(before?.updatedBy).toBe('u-release');
    const after = await upsertAllocation('p-observability', 96, 'u-rachel');
    expect(after?.allocatedUsd).toBe(96);
    expect(after?.updatedBy).toBe('u-rachel');
    expect(after?.updatedAt).toBe(NOON);
    expect(after?.updatedByName).not.toBe(before?.updatedByName);
  });

  it('attributes a first allocation the same way', async () => {
    const row = await upsertAllocation('p-inference-platform', 40, 'u-vera');
    expect(row?.updatedBy).toBe('u-vera');
    expect(row?.updatedAt).toBe(NOON);
  });

  it('reset puts the seed author back', async () => {
    await upsertAllocation('p-observability', 96, 'u-rachel');
    initiativeBudgets.reset();
    expect((await getBudget('p-observability'))?.updatedBy).toBe('u-release');
  });
});
