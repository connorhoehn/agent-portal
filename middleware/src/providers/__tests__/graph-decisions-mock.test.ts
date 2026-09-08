// providers/decisions.ts in dev:mock.
//
// `/api/graph/decisions` had no mock branch at all: `listDecisions` called the
// RDS Data API directly, so offline both routes answered 500 — which reads as
// "this feature is broken", a strictly worse message than "nothing is seeded".
//
// What is pinned here is the part a fixture gets wrong quietly:
// participantCount is COUNTED from the participant rows the detail route also
// serves, so the list's "11 participants" and the thread's eleven names cannot
// disagree. (Seed↔mock id and field parity is checked separately, by the four
// `decisions` / `decision_participants` rows in mock/core/parity/entities.ts,
// and the agreement between this list and an initiative's Decisions tab by
// "the two decision surfaces read one table" in mock/core/parity/invariants.ts.)

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true } },
}));

import { fixtureRegistry } from '../../mock/core/index.js';
import { getDecision, listDecisions } from '../decisions.js';

afterEach(() => fixtureRegistry.resetAll('default'));

describe('decision records in dev:mock', () => {
  it('answers instead of throwing, most recently active first', async () => {
    const decisions = await listDecisions({ limit: 50 });
    expect(decisions.length).toBeGreaterThan(0);
    // ORDER BY COALESCE(decided_at, created_at) DESC. Both seeds leave
    // created_at to its NOW() default, so a call that has not been decided yet
    // sorts as today — at the TOP. Sorting `decidedAt ?? ''` put those last,
    // the opposite of the query this mirrors.
    const activity = decisions.map((d) => d.decidedAt ?? '9999-12-31');
    expect([...activity].sort().reverse()).toEqual(activity);
  });

  it('serves the whole table, not just the settled half', async () => {
    // One concept, one list: the org-wide ADRs seed.sql writes and the calls
    // seed_program.sql's initiatives raised. These were two disjoint fixtures.
    const decisions = await listDecisions({ limit: 200 });
    expect(decisions.map((d) => d.id)).toEqual(
      expect.arrayContaining(['d-aurora', 'd-otel-vendor', 'd-cognito-cutover']),
    );
    expect(decisions.some((d) => d.projectId === null)).toBe(true);
    expect(decisions.some((d) => d.status === 'escalated')).toBe(true);
    // Every decision records who was in the room, program decisions included.
    for (const d of decisions) expect(d.participantCount).toBeGreaterThan(0);
  });

  it('counts participants from the rows the detail route hands back', async () => {
    for (const summary of await listDecisions({ limit: 50 })) {
      const detail = await getDecision(summary.id);
      expect(detail).not.toBeNull();
      expect(detail!.participants).toHaveLength(summary.participantCount);
      // Heaviest first, then by name — the ORDER BY the SQL path uses.
      const names = detail!.participants.map((p) => p.name);
      expect(names).toEqual([...names].sort((a, b) => {
        const wa = detail!.participants.find((p) => p.name === a)!.weight;
        const wb = detail!.participants.find((p) => p.name === b)!.weight;
        return wb - wa || a.localeCompare(b);
      }));
      // Every participant resolves to a person in the shared cast — the JOIN
      // the SQL does, rather than a bare id rendered as a name.
      for (const p of detail!.participants) expect(p.name).not.toBe('');
    }
  });

  it('honours the limit and the `since` filter', async () => {
    expect(await listDecisions({ limit: 3 })).toHaveLength(3);
    const recent = await listDecisions({ since: '2026-04-01' });
    expect(recent.length).toBeGreaterThan(0);
    // An undecided call filters on created_at, so it survives a past `since`.
    for (const d of recent) expect((d.decidedAt ?? '9999-12-31') >= '2026-04-01').toBe(true);
  });

  it('has an empty world an auditor can ask for', async () => {
    fixtureRegistry.resetAll('empty');
    expect(await listDecisions()).toEqual([]);
    expect(await getDecision('d-aurora')).toBeNull();
  });
});
