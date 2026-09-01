// An initiative that exists but has no work yet must not read as a wrong id.
//
// THE BUG THIS PINS. `/api/graph/projects/:id/work` and `/decisions` 404 for a
// parent that does not exist — deliberately, so a typo (`p-nope`) reads as
// "wrong" rather than "empty". That design is right and this test keeps it.
//
// But in mock mode the existence check asked the wrong question:
//
//   MOCK_WORK_ITEMS.some(i => i.projectId === id) || Object.hasOwn(PROJECT_DECISIONS, id)
//
// which is "does this project have work or decisions?", not "does it exist?".
// The SQL path was correct (SELECT 1 FROM projects). So `p-realtime-analytics`
// — listed by GET /api/graph/projects, and open-able in the portal — answered
// 404 "Project not found" on both sub-collections, and the page logged an error
// on every load.
//
// That is the SAME confusion the 404s were introduced to prevent, running the
// other way: instead of a typo reading as empty, an empty initiative read as a
// typo. The two endpoints disagreed about whether the project was real.
//
// Both directions are asserted here, because fixing this by making everything
// exist would be just as wrong as the bug.

jest.mock('../aurora.js', () => ({ exec: jest.fn(), safeExec: jest.fn(async () => []) }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { projectExists } from '../work-items.js';
import { listProjects } from '../projects.js';

describe('projectExists (mock mode) agrees with the project list', () => {
  it('resolves an initiative that exists but has no work items', async () => {
    // The reported case. Before the fix this returned false and the route 404'd.
    expect(await projectExists('p-realtime-analytics')).toBe(true);
  });

  it('still refuses an id that is simply wrong', async () => {
    // The property the 404 exists for. If this ever passes, a typo has started
    // rendering as an empty board and nobody will notice.
    expect(await projectExists('p-nope')).toBe(false);
    expect(await projectExists('')).toBe(false);
  });

  it('resolves a populated initiative', async () => {
    expect(await projectExists('p-llm-platform')).toBe(true);
  });

  it('agrees with the list endpoint for EVERY project it returns', async () => {
    // The real invariant, rather than three hand-picked ids: anything
    // /api/graph/projects hands the portal must be open-able. A new seed
    // initiative with no work would otherwise reintroduce this silently.
    const listed = await listProjects({});
    expect(listed.length).toBeGreaterThan(0);
    const disagreements: string[] = [];
    for (const p of listed) {
      if (!(await projectExists(p.id))) disagreements.push(p.id);
    }
    expect(disagreements).toEqual([]);
  });
});
