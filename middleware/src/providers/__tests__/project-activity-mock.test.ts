// The initiative activity FEED in dev:mock — providers/work-items.ts's
// getProjectActivity, not providers/activity.ts's time series.
//
// Two no-ops shipped together and hid each other. `addWorkItemComment` was
// `if (config.mock.aurora) return;` — a write that reported success and stored
// nothing — and `getProjectActivity` was `if (config.mock.aurora) return [];`.
// So offline every initiative's history read "nothing here yet" over a fixture
// holding its work items and (in schema/seed_program.sql) its comments, and
// the system comment a simulated marketplace dispatch leaves on the item it
// ran vanished on the way to a feed that would not have shown it anyway.
//
// These pin both halves, and the projection they share with the Aurora branch.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true } } }));

import { getProjectActivity, addWorkItemComment, mockReprojectedIso, MOCK_EPOCH } from '../work-items.js';
import { workItemComments } from '../../mock/work-item-comments.js';
import { workItems } from '../../mock/work-items.js';
import { fixtureRegistry } from '../../mock/core/index.js';

afterEach(() => {
  fixtureRegistry.resetAll('default');
});

describe('getProjectActivity — mock mode', () => {
  it('is not empty for a seeded initiative', async () => {
    const feed = await getProjectActivity('p-auth-migration');
    expect(feed.length).toBeGreaterThan(0);
  });

  it('shows a completion as `completed`, dated by when it completed', async () => {
    const feed = await getProjectActivity('p-auth-migration', { limit: 100 });
    // wi-auth-e1-s1 is done, completedAt D(14), PR merged — the merged arm
    // wins the `kind`, and the action reads `completed` because the item
    // really is finished.
    const completion = feed.find((e) => e.workItemId === 'wi-auth-e1-s1');
    expect(completion).toBeDefined();
    expect(completion!.action).toBe('completed');
    expect(completion!.ticketId).toBe('AUTH-E1-S1');
    expect(completion!.actorName).toBe('Nora Chang');

    // Dated fourteen days ago, not four months ago: the seeds encode an offset
    // from MOCK_EPOCH and the feed replays it from real today (the same
    // reprojection providers/activity.ts's graph buckets by, so the two
    // surfaces place one completion on one day).
    const ageDays = (Date.now() - Date.parse(completion!.at)) / 86_400_000;
    expect(ageDays).toBeGreaterThan(13);
    expect(ageDays).toBeLessThan(15);
  });

  it('carries the seeded discussion, keyed to the right initiative', async () => {
    const auth = await getProjectActivity('p-auth-migration', { limit: 100 });
    const comment = auth.find((e) => e.id === 'wic-prog-4');
    expect(comment).toMatchObject({
      kind: 'comment', action: 'commented on', actorId: 'p-051',
      actorName: 'Nora Chang', workItemId: 'wi-auth-e1-b4',
      // A human comment renders under its item's TITLE; the body is the
      // subject only for a system row.
      subject: 'Refresh loop when a grant is revoked mid-session',
    });

    // wic-prog-1 belongs to wi-obs-e1-b5, which is p-observability's. The
    // inner join is what keeps it out of Auth Migration's feed.
    expect(auth.some((e) => e.id === 'wic-prog-1')).toBe(false);
    const obs = await getProjectActivity('p-observability', { limit: 100 });
    expect(obs.some((e) => e.id === 'wic-prog-1')).toBe(true);
  });

  it('is newest-first and honours the limit', async () => {
    const feed = await getProjectActivity('p-auth-migration', { limit: 4 });
    expect(feed).toHaveLength(4);
    const stamps = feed.map((e) => e.at);
    expect([...stamps].sort((a, b) => b.localeCompare(a))).toEqual(stamps);
  });

  it('is still empty when there is genuinely nothing behind the id', async () => {
    // The old branch returned this for EVERY id. It is now reached only when
    // the id really owns no work item and no comment — the route 404s an
    // unknown initiative before it gets here, so this is the provider's own
    // honest empty rather than a blanket one.
    expect(await getProjectActivity('p-not-an-initiative')).toEqual([]);
  });

  it('empties the feed under the `empty` scenario — the board as well as the discussion', async () => {
    // The control plane's own switch — an auditor asks for a world rather
    // than mutating one (docs/mock-floor.md).
    //
    // This used to assert the work events SURVIVED an `empty` switch, because
    // the board was a module-level array that no scenario could reach: only
    // the comments fixture emptied, so `empty` produced a half-empty world
    // that no real initiative can be in. Now that mock/work-items.ts declares
    // `empty: () => []` the auditor gets the whole state — an initiative with
    // nothing in it, which is what the Activity tab's empty copy is for.
    fixtureRegistry.resetAll('empty');
    expect(workItemComments.rows()).toEqual([]);
    expect(workItems.rows()).toEqual([]);
    expect(await getProjectActivity('p-auth-migration', { limit: 100 })).toEqual([]);
  });

  it('brings the whole board back on reset', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await getProjectActivity('p-auth-migration', { limit: 100 })).toEqual([]);
    fixtureRegistry.resetAll('default');
    const feed = await getProjectActivity('p-auth-migration', { limit: 100 });
    expect(feed.some((e) => e.workItemId === 'wi-auth-e1-s1')).toBe(true);
    expect(feed.some((e) => e.id === 'wic-prog-4')).toBe(true);
  });
});

describe('addWorkItemComment — mock mode', () => {
  it('survives into the item’s comments, as a system audit row', async () => {
    const body =
      'Marketplace run completed without a captured change — the run was simulated, ' +
      'because no devbox runtime is deployed.';
    await addWorkItemComment('wi-auth-e2-b3', body, { isSystem: true });

    const feed = await getProjectActivity('p-auth-migration', { limit: 100 });
    const settle = feed.find((e) => e.subject === body);
    expect(settle).toBeDefined();
    // is_system → rendered as a status event, and the BODY is the subject: the
    // sentence is the message, there is no title to show instead.
    expect(settle).toMatchObject({
      kind: 'status', action: 'updated', workItemId: 'wi-auth-e2-b3',
      ticketId: 'AUTH-E2-B3', actorId: null, actorName: null,
    });
    // Written now, so it sorts to the top of the feed.
    expect(feed[0]!.id).toBe(settle!.id);
    // `wic-` + a uuid — the column's own DEFAULT in
    // schema/orgiq_work_items_schema.sql.
    expect(settle!.id).toMatch(/^wic-[0-9a-f-]{36}$/);
  });

  it('records a human comment with its author', async () => {
    await addWorkItemComment('wi-auth-e2-b3', 'Picking this up.', { authorId: 'p-004' });
    const feed = await getProjectActivity('p-auth-migration', { limit: 100 });
    expect(feed.find((e) => e.subject === 'Logout leaves the legacy shim cookie alive'
      && e.kind === 'comment')).toMatchObject({
      action: 'commented on', actorId: 'p-004', actorName: 'Nora DaSilva',
    });
  });
});

describe('mockReprojectedIso', () => {
  it('replays a seeded offset from today', () => {
    const tenDaysBeforeEpoch = new Date(MOCK_EPOCH.getTime() - 10 * 86_400_000).toISOString();
    const ageDays = (Date.now() - Date.parse(mockReprojectedIso(tenDaysBeforeEpoch))) / 86_400_000;
    expect(ageDays).toBeCloseTo(10, 1);
  });

  it('leaves a stamp this process wrote alone — reprojecting it would land in the future', () => {
    const now = new Date().toISOString();
    expect(mockReprojectedIso(now)).toBe(now);
  });
});
