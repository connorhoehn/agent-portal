// mock/work-items.ts's `large` branch.
//
// WHY THIS EXISTS. `searchWorkItems` caps at 200 rows by default and
// `getProjectWorkItems`'s `PROJECT_WORK_ITEMS_LIMIT` caps a single
// initiative's tree at 500 (providers/work-items.ts) — the seeded ~80-item
// board, spread across 14 initiatives with the busiest at 14 items, could
// never make either fire.

// work-items.ts imports providers/projects.ts (for `mockProjectName`), which
// imports config.ts — mocked the same way the other `large`-scenario tests
// in this directory already do.
jest.mock('../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true },
    region: 'us-east-1',
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
  },
}));

import { workItems, nextMockWorkItemId } from '../work-items.js';
import { fixtureRegistry } from '../core/index.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('workItems large scenario', () => {
  it('is bigger than default, and past both the 200-row search cap and the 500-row per-initiative cap', () => {
    const seeded = workItems.rows('default');
    const large = workItems.rows('large');
    expect(large.length).toBeGreaterThan(seeded.length);
    expect(large.length).toBeGreaterThan(200);

    const byProject = new Map<string, number>();
    for (const item of large) byProject.set(item.projectId, (byProject.get(item.projectId) ?? 0) + 1);
    expect(Math.max(...byProject.values())).toBeGreaterThan(500);
  });

  it('every large row has a well-formed wi- id, unique, with parentId translated into the same round', () => {
    const large = workItems.rows('large');
    const ids = new Set(large.map((i) => i.id));
    expect(ids.size).toBe(large.length);
    for (const item of large) {
      expect(item.id).toMatch(/^wi-[a-z0-9-]+$/);
      if (item.parentId) expect(ids.has(item.parentId)).toBe(true);
    }
  });

  it('every large row still resolves a real projectName (the projects.ts join survives cloning)', () => {
    const large = workItems.rows('large');
    for (const item of large) {
      expect(item.projectName).toBeTruthy();
      expect(item.projectName).not.toBe(item.projectId);
    }
  });

  it('reset restores the seeded board size', () => {
    fixtureRegistry.resetAll('large');
    expect(workItems.rows().length).toBeGreaterThan(200);

    fixtureRegistry.resetAll('default');
    const seeded = workItems.rows();
    expect(seeded.length).toBeLessThan(200);
    expect(seeded.every((i) => !i.id.includes('-x'))).toBe(true);
  });

  it('nextMockWorkItemId is untouched by the large clones (they never use the wi-mock- namespace)', () => {
    fixtureRegistry.resetAll('large');
    expect(nextMockWorkItemId()).toBe('wi-mock-1');
  });
});
