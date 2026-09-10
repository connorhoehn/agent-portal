// Work-items provider tests — the Aurora path, with `exec` mocked.
//
// What is pinned here: the filters the Aurora path actually applies (`team`
// used to be read, documented and honoured by the mock path while the SQL
// never referenced it), the two program columns the SQL never selected
// (`sprint_id`, `estimated_cost_usd`), the fields PATCH can now write, the
// compare-and-swap guard on a status move, and the whole status-transition
// matrix — the board's counterpart to `bot-runner.decideDispatch`.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../aurora.js';
import {
  searchWorkItems,
  getWorkItem,
  createWorkItem,
  updateWorkItem,
  decideStatusTransition,
  countOpenChangeRequests,
  wouldCreateParentCycle,
  projectExists,
  personExists,
  type WorkItemStatus,
} from '../work-items.js';

const execMock = exec as unknown as jest.Mock;

/** One Aurora row shaped like the SELECT projection. */
const ROW = {
  id: 'wi-obs-e1-s1',
  project_id: 'p-observability',
  project_name: 'Observability Platform',
  parent_id: 'wi-obs-e1',
  type: 'story',
  title: 'Roll out collector fleet',
  description: null,
  status: 'in_progress',
  priority: 'high',
  labels: ['otel', 'infra'],
  story_points: 8,
  sprint_id: 'spr-obs-s3',
  // NUMERIC arrives from the Data API as a string.
  estimated_cost_usd: '10.47',
  pr_url: null,
  pr_status: null,
  created_at: '2026-06-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
  completed_at: null,
  assignee_id: 'p-008',
  assignee_name: 'Dana Okafor',
  assignee_dept: 'Platform Engineering',
  child_count: 0,
  child_done_count: 0,
};

/** Every exec call EXCEPT the app_users capability probe.
 *
 *  Reads may now be preceded by an information_schema probe that decides
 *  whether app_users can be joined (providers/work-items.ts::appUsersAvailable).
 *  It is infrastructure, not a query any test here is about, and a positional
 *  `calls[0]` silently started asserting against it. */
function realCalls() {
  return execMock.mock.calls.filter((c) => !/information_schema/.test(String(c[0])));
}

/** The SQL of the nth WORK-ITEM exec call, whitespace-collapsed for matching.
 *
 *  Filtered rather than positional: reads may now be preceded by the
 *  information_schema probe that decides whether app_users can be joined
 *  (providers/work-items.ts::appUsersAvailable), and a positional `calls[0]`
 *  silently started asserting against the probe instead. */
function sqlOf(call = 0): string {
  return String(realCalls()[call]![0]).replace(/\s+/g, ' ');
}
function paramsOf(call = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of (realCalls()[call]?.[1] ?? []) as { name: string; value: Record<string, unknown> }[]) {
    out[p.name] = p.value['stringValue'] ?? p.value['longValue'] ?? p.value['doubleValue'] ?? null;
  }
  return out;
}

beforeEach(() => execMock.mockReset());

// ── The columns the API used to hide ─────────────────────────────────────────

describe('sprint_id and estimated_cost_usd', () => {
  it('are selected and returned by every read', async () => {
    execMock.mockResolvedValue([ROW]);

    const [searched] = await searchWorkItems({});
    expect(sqlOf()).toContain('wi.sprint_id');
    expect(sqlOf()).toContain('wi.estimated_cost_usd');
    expect(searched).toMatchObject({ sprintId: 'spr-obs-s3', estimatedCostUsd: 10.47 });

    execMock.mockClear();
    const one = await getWorkItem('wi-obs-e1-s1');
    expect(sqlOf()).toContain('wi.estimated_cost_usd');
    expect(one).toMatchObject({ sprintId: 'spr-obs-s3', estimatedCostUsd: 10.47 });
  });

  it('come back null when the row holds no sprint or estimate', async () => {
    execMock.mockResolvedValue([{ ...ROW, sprint_id: null, estimated_cost_usd: null }]);
    const one = await getWorkItem('wi-obs-e1-s1');
    expect(one).toMatchObject({ sprintId: null, estimatedCostUsd: null });
  });

  it('are settable on create', async () => {
    execMock.mockResolvedValueOnce([{ id: 'wi-new' }]).mockResolvedValueOnce([ROW]);
    await createWorkItem({
      projectId: 'p-observability', type: 'story', title: 'New',
      sprintId: 'spr-obs-s3', estimatedCostUsd: 12.5,
    });
    expect(sqlOf()).toContain('sprint_id, estimated_cost_usd');
    expect(paramsOf()).toMatchObject({ sprint_id: 'spr-obs-s3', cost: 12.5 });
  });

  it('are settable on patch, and clearable with null', async () => {
    execMock.mockResolvedValueOnce([{ id: 'wi-1' }]).mockResolvedValueOnce([ROW]);
    await updateWorkItem('wi-1', { sprintId: 'spr-obs-s2', estimatedCostUsd: 3.25 });
    expect(sqlOf()).toContain('sprint_id = :sprint_id');
    expect(sqlOf()).toContain('estimated_cost_usd = :cost::numeric');
    expect(paramsOf()).toMatchObject({ sprint_id: 'spr-obs-s2', cost: 3.25 });

    execMock.mockReset();
    execMock.mockResolvedValueOnce([{ id: 'wi-1' }]).mockResolvedValueOnce([ROW]);
    await updateWorkItem('wi-1', { sprintId: null, estimatedCostUsd: null });
    expect(sqlOf()).toContain('sprint_id = NULL');
    expect(sqlOf()).toContain('estimated_cost_usd = NULL');
  });
});

// ── The filter that did nothing ──────────────────────────────────────────────

describe('searchWorkItems filters', () => {
  beforeEach(() => execMock.mockResolvedValue([ROW]));

  it('filters on team — the Aurora path used to ignore it entirely', async () => {
    await searchWorkItems({ team: 'Platform Engineering' });
    expect(sqlOf()).toContain("POSITION(LOWER(:team) IN LOWER(COALESCE(a.team, ''))) > 0");
    expect(paramsOf()).toMatchObject({ team: 'Platform Engineering' });
  });

  it('passes the team through as a bound parameter, not interpolated SQL', async () => {
    await searchWorkItems({ team: "Platform'; DROP TABLE work_items; --" });
    expect(sqlOf()).not.toContain('DROP TABLE');
    expect(paramsOf()['team']).toBe("Platform'; DROP TABLE work_items; --");
  });

  it('uses POSITION rather than LIKE so % in a team name is not a wildcard', async () => {
    await searchWorkItems({ team: '%' });
    expect(sqlOf()).not.toMatch(/a\.team.*LIKE/i);
  });

  it('filters on sprint', async () => {
    await searchWorkItems({ sprintId: 'spr-obs-s3' });
    expect(sqlOf()).toContain('wi.sprint_id = :sprint_id');
    expect(paramsOf()).toMatchObject({ sprint_id: 'spr-obs-s3' });
  });

  it('adds no top-level WHERE clause when nothing is filtered', async () => {
    await searchWorkItems({});
    // The child-count subqueries carry their own WHERE; only the outer query
    // between the last JOIN and ORDER BY is under test.
    const outer = sqlOf().split('LEFT JOIN people a ON a.id = wi.assignee_id')[1]!;
    expect(outer).not.toContain('WHERE');
  });

  it('combines every filter with AND', async () => {
    await searchWorkItems({ label: 'otel', team: 'Platform', status: 'open', period: 'week' });
    const sql = sqlOf();
    expect(sql).toContain(':label = ANY(wi.labels)');
    expect(sql).toContain('LOWER(:team)');
    expect(sql).toContain('wi.status = :status');
    expect(sql).toContain("INTERVAL '7 days'");
  });
});

// ── The fields PATCH used to drop ────────────────────────────────────────────

describe('updateWorkItem', () => {
  beforeEach(() => {
    execMock.mockReset();
    execMock.mockResolvedValueOnce([{ id: 'wi-1' }]).mockResolvedValueOnce([ROW]);
  });

  it('writes title, description, labels, parentId and storyPoints', async () => {
    await updateWorkItem('wi-1', {
      title: 'Retitled', description: 'why', labels: ['otel', 'infra'],
      parentId: 'wi-obs-e1', storyPoints: 13,
    });
    const sql = sqlOf();
    expect(sql).toContain('title = :title');
    expect(sql).toContain('description = :description');
    expect(sql).toContain("labels = ARRAY['otel','infra']");
    expect(sql).toContain('parent_id = :parent_id');
    expect(sql).toContain('story_points = :story_points');
  });

  it('escapes single quotes in labels rather than breaking the literal', async () => {
    await updateWorkItem('wi-1', { labels: ["o'brien"] });
    expect(sqlOf()).toContain("labels = ARRAY['o''brien']");
  });

  it('clears description and storyPoints with null', async () => {
    await updateWorkItem('wi-1', { description: null, storyPoints: null });
    expect(sqlOf()).toContain('description = NULL');
    expect(sqlOf()).toContain('story_points = NULL');
  });

  it('re-reads the row so the response carries projectName, labels and assignee', async () => {
    const updated = await updateWorkItem('wi-1', { title: 'Retitled' });
    // The old hand-built RETURNING mapper always returned '' / [] / null here.
    expect(updated).toMatchObject({
      projectName: 'Observability Platform',
      labels: ['otel', 'infra'],
      assigneeName: 'Dana Okafor',
    });
  });

  it('guards the write with the expected status when one is given', async () => {
    await updateWorkItem('wi-1', { status: 'done', expectStatus: 'in_review' });
    expect(sqlOf()).toContain('AND status = :expect_status');
    expect(paramsOf()).toMatchObject({ expect_status: 'in_review' });
  });

  it('omits the guard when no expected status is given', async () => {
    await updateWorkItem('wi-1', { title: 'Retitled' });
    expect(sqlOf()).not.toContain('expect_status');
  });

  it('returns null when the guarded update matches no row', async () => {
    execMock.mockReset();
    execMock.mockResolvedValue([]);
    await expect(updateWorkItem('wi-1', { status: 'done', expectStatus: 'in_review' })).resolves.toBeNull();
  });
});

// ── Preconditions the routes lean on ─────────────────────────────────────────

describe('preconditions', () => {
  it('counts only change requests still in flight', async () => {
    execMock.mockResolvedValue([{ n: 2 }]);
    await expect(countOpenChangeRequests('wi-1')).resolves.toBe(2);
    expect(sqlOf()).toContain("'captured','needs_approval','changes_requested','in_review'");
  });

  it('reports zero open change requests when the row set is empty', async () => {
    execMock.mockResolvedValue([]);
    await expect(countOpenChangeRequests('wi-1')).resolves.toBe(0);
  });

  it('treats self-parenting as a cycle without querying', async () => {
    await expect(wouldCreateParentCycle('wi-1', 'wi-1')).resolves.toBe(true);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('walks ancestry to detect a reparent into its own subtree', async () => {
    execMock.mockResolvedValue([{ '?column?': 1 }]);
    await expect(wouldCreateParentCycle('wi-1', 'wi-child')).resolves.toBe(true);
    expect(sqlOf()).toContain('WITH RECURSIVE ancestry');
  });

  it('allows a reparent that closes no loop', async () => {
    execMock.mockResolvedValue([]);
    await expect(wouldCreateParentCycle('wi-1', 'wi-elsewhere')).resolves.toBe(false);
  });

  it('answers project/person existence from a cheap probe', async () => {
    execMock.mockResolvedValue([{ '?column?': 1 }]);
    await expect(projectExists('p-observability')).resolves.toBe(true);
    expect(sqlOf()).toContain('FROM projects WHERE id = :pid');

    execMock.mockReset();
    execMock.mockResolvedValue([]);
    await expect(personExists('p-nope')).resolves.toBe(false);
    expect(sqlOf()).toContain('FROM people WHERE id = :pid');
  });
});

// ── The transition matrix ────────────────────────────────────────────────────

const ALL: WorkItemStatus[] = ['open', 'in_progress', 'in_review', 'done', 'cancelled'];

// Every legal move, spelled out. Anything not listed must be refused.
const ALLOWED: [WorkItemStatus, WorkItemStatus][] = [
  ['open', 'in_progress'], ['open', 'cancelled'],
  ['in_progress', 'in_review'], ['in_progress', 'done'],
  ['in_progress', 'open'], ['in_progress', 'cancelled'],
  ['in_review', 'in_progress'], ['in_review', 'done'], ['in_review', 'cancelled'],
  ['done', 'in_progress'],
  ['cancelled', 'open'],
];

describe('decideStatusTransition', () => {
  it.each(ALLOWED)('allows %s -> %s', (from, to) => {
    expect(decideStatusTransition({ status: from }, to)).toEqual({ kind: 'allow' });
  });

  const REFUSED = ALL.flatMap((from) =>
    ALL.filter((to) => from !== to && !ALLOWED.some(([f, t]) => f === from && t === to))
      .map((to) => [from, to] as [WorkItemStatus, WorkItemStatus]));

  it.each(REFUSED)('refuses %s -> %s with 400 and a reason', (from, to) => {
    const decision = decideStatusTransition({ status: from }, to);
    expect(decision).toMatchObject({ kind: 'refuse', status: 400 });
    expect((decision as { error: string }).error).toEqual(expect.any(String));
  });

  it('covers all 25 ordered pairs between the two tables', () => {
    const sameStatus = ALL.length;
    expect(ALLOWED.length + REFUSED.length + sameStatus).toBe(ALL.length * ALL.length);
  });

  it.each(ALL)('treats %s -> itself as a no-op, not a transition', (status) => {
    expect(decideStatusTransition({ status }, status)).toEqual({ kind: 'allow' });
  });

  it('agrees with decideDispatch: nothing reaches review or done unstarted', () => {
    expect(decideStatusTransition({ status: 'open' }, 'in_review').kind).toBe('refuse');
    expect(decideStatusTransition({ status: 'open' }, 'done').kind).toBe('refuse');
  });

  it('reopens a completed item to in_progress, never back to the backlog', () => {
    expect(decideStatusTransition({ status: 'done' }, 'in_progress')).toEqual({ kind: 'allow' });
    const back = decideStatusTransition({ status: 'done' }, 'open');
    expect(back).toMatchObject({ kind: 'refuse', status: 400 });
    expect((back as { error: string }).error).toMatch(/in_progress/);
    // …and in_progress -> open is the legal second hop, so a mistakenly-done
    // item can still reach the backlog (where dispatch claims it) in two moves.
    expect(decideStatusTransition({ status: 'in_progress' }, 'open')).toEqual({ kind: 'allow' });
  });

  it('refuses done with 409 while a change request is still open', () => {
    const decision = decideStatusTransition({ status: 'in_review' }, 'done', { openChangeRequests: 1 });
    expect(decision).toMatchObject({ kind: 'refuse', status: 409 });
    expect((decision as { error: string }).error).toMatch(/1 change request .* is still open/);
  });

  it('pluralises the refusal for several open change requests', () => {
    const decision = decideStatusTransition({ status: 'in_progress' }, 'done', { openChangeRequests: 3 });
    expect((decision as { error: string }).error).toMatch(/3 change requests .* are still open/);
  });

  it('lets an item with no open change request finish', () => {
    expect(decideStatusTransition({ status: 'in_review' }, 'done', { openChangeRequests: 0 }))
      .toEqual({ kind: 'allow' });
  });

  it('does not let an open change request rescue an otherwise illegal move', () => {
    // open -> done is refused on shape; the governance check never runs.
    expect(decideStatusTransition({ status: 'open' }, 'done', { openChangeRequests: 0 }))
      .toMatchObject({ kind: 'refuse', status: 400 });
  });

  it('applies the change-request check only to done, not to cancelled', () => {
    expect(decideStatusTransition({ status: 'in_review' }, 'cancelled', { openChangeRequests: 2 }))
      .toEqual({ kind: 'allow' });
  });
});
