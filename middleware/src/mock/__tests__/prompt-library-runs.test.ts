// The asset's pass rate is read from the eval-run rows, not carried beside
// them. Before this, the drawer showed one asset with three figures at once:
// a seeded 88% under Health & usage and Release readiness, and the 100% of the
// run a person had just made under Evals.
import { mockLibraryAssets } from '../prompt-library.js';
import { promptEvalRuns } from '../prompt-evals.js';

afterEach(() => promptEvalRuns.reset());

function asset(id: string) {
  const a = mockLibraryAssets().find((x) => x.id === id);
  if (!a) throw new Error(`no asset ${id}`);
  return a;
}

test('an asset that has never been run keeps its seeded baseline', () => {
  const email = asset('lib-stakeholder-email');
  expect(promptEvalRuns.rows().some((r) => r.assetId === email.id)).toBe(false);
  expect(email.evalPassRate).toBe(0.88);
});

test('the newest run for the asset version is the rate the asset reports', () => {
  const before = asset('lib-stakeholder-email');
  promptEvalRuns.rows().unshift({
    id: 'run-lib-stakeholder-email-test-1', assetId: before.id, version: before.version,
    ranAt: '2026-09-15T12:00:00.000Z', ranBy: 'u-mia', passRate: 1, total: 2, passed: 2, results: [],
  });
  expect(asset('lib-stakeholder-email').evalPassRate).toBe(1);
  // An older run does not win over the newer one, whatever the array order.
  promptEvalRuns.rows().unshift({
    id: 'run-lib-stakeholder-email-test-0', assetId: before.id, version: before.version,
    ranAt: '2026-09-01T12:00:00.000Z', ranBy: 'u-mia', passRate: 0.5, total: 2, passed: 1, results: [],
  });
  expect(asset('lib-stakeholder-email').evalPassRate).toBe(1);
});

test('a run for a different version of the asset does not leak into this one', () => {
  const before = asset('lib-stakeholder-email');
  promptEvalRuns.rows().unshift({
    id: 'run-lib-stakeholder-email-test-v9', assetId: before.id, version: 'v99',
    ranAt: '2026-09-15T12:00:00.000Z', ranBy: 'u-mia', passRate: 0, total: 2, passed: 0, results: [],
  });
  expect(asset('lib-stakeholder-email').evalPassRate).toBe(0.88);
});
