// Mock-mode parity between the Initiatives rollup and the Budgets ledger.
//
// CLAUDE.md promises `dev:mock` mirrors schema/seed_program.sql, but the two
// surfaces were built from different fixtures and disagreed loudly: listProjects
// returned EMPTY_ROLLUPS (agentSpendUsd: null, lastAgentActivityAt: null) for
// every initiative, so /iq/projects said "no agent runs yet" while /admin/budgets
// reported $19.77 spent across those very initiative ids. Offline demo, two
// pages, contradictory money.
//
// The fix is a single source, not a second fixture: providers/projects.ts reads
// its mock spend + liveness out of providers/budgets.ts's own MOCK_BUDGETS via
// mockBudgetRow — literally the row the Budgets page renders. These tests pin
// that the two surfaces cannot drift, including the one number that is still
// mirrored by hand (activeHoursAgo ↔ activityHoursAgo).

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, region: 'us-east-1' } }));

import { listProjects } from '../projects.js';
import { listBudgets, listGrants } from '../budgets.js';

describe('mock Initiatives vs mock Budgets', () => {
  it('reports the same agent spend for every initiative both pages know', async () => {
    const projects = await listProjects({ limit: 200 });
    const budgets = await listBudgets();
    expect(budgets.length).toBeGreaterThan(0);

    let compared = 0;
    for (const b of budgets) {
      const p = projects.find((x) => x.id === b.orgProjectId);
      if (!p) continue;
      compared += 1;
      expect(p.agentSpendUsd).toBe(b.spentThisPeriodUsd);
    }
    // Every ledger row must exist on the Initiatives page — a budget for an
    // initiative that page has never heard of is its own defect.
    expect(compared).toBe(budgets.length);
  });

  it('never claims "no agent runs yet" beside a ledger showing money', async () => {
    const projects = await listProjects({ limit: 200 });
    const spending = (await listBudgets()).filter((b) => b.spentThisPeriodUsd > 0);
    expect(spending.length).toBeGreaterThan(0);
    for (const b of spending) {
      const p = projects.find((x) => x.id === b.orgProjectId)!;
      expect(p.agentSpendUsd).not.toBeNull();
      expect(p.agentSpendUsd).toBeGreaterThan(0);
      expect(p.lastAgentActivityAt).not.toBeNull();
    }
  });

  it('reports the same last-agent-activity timestamp on both pages', async () => {
    const projects = await listProjects({ limit: 200 });
    for (const b of await listBudgets()) {
      const p = projects.find((x) => x.id === b.orgProjectId)!;
      // Same string, not "within a few seconds": both are the ledger row's.
      expect(p.lastAgentActivityAt).toBe(b.lastAgentActivityAt);
      // …and the card's generic last-activity agrees with it, the way Aurora's
      // `lastAgent ?? createdAt` does.
      expect(p.lastActivityAt).toBe(b.lastAgentActivityAt);
    }
  });

  it('gives an initiative with no ledger row $0 and never — not null', async () => {
    const budgetIds = new Set((await listBudgets()).map((b) => b.orgProjectId));
    const offLedger = (await listProjects({ limit: 200 })).filter((p) => !budgetIds.has(p.id));
    // The mock cast is 14 initiatives against 7 ledger rows; if that ever went
    // to zero this test would be silently vacuous.
    expect(offLedger.length).toBeGreaterThan(0);
    for (const p of offLedger) {
      // Aurora returns 0 for an initiative with no attributed runs, not null —
      // null is reserved for a cluster too old to have the rollup at all.
      expect(p.agentSpendUsd).toBe(0);
      expect(p.lastAgentActivityAt).toBeNull();
    }
  });

  it('gives each initiative its own liveness rather than one flat stub', async () => {
    // The ledger's mock liveness was a single `now - 3h` constant for every
    // row. Once the Initiatives page started rendering that same value, the
    // constant would have made all 7 cards claim the identical last-activity —
    // so it is per-initiative (MockBudget.activityHoursAgo) and this pins it.
    const budgets = await listBudgets();
    for (const b of budgets) {
      expect(Date.now() - new Date(b.lastAgentActivityAt!).getTime()).toBeGreaterThan(0);
    }
    expect(new Set(budgets.map((b) => b.lastAgentActivityAt)).size).toBe(budgets.length);
  });
});

describe('mock sprint envelopes', () => {
  it('names initiatives the Budgets ledger also knows', async () => {
    const budgetIds = new Set((await listBudgets()).map((b) => b.orgProjectId));
    const grants = await listGrants();
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(budgetIds.has(g.orgProjectId)).toBe(true);
  });
});
