// The suggestion ranking — the policy that decides what the Work page offers
// instead of an empty prompt box. Pure, so this is the policy itself.

import { rankSuggestions, type SuggestibleItem } from '../work-suggestions.js';

function item(patch: Partial<SuggestibleItem> = {}): SuggestibleItem {
  return {
    id: 'wi-1',
    projectId: 'p-obs',
    projectName: 'Observability Platform',
    type: 'story',
    title: 'Roll out the collector fleet',
    description: null,
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    storyPoints: 5,
    estimatedCostUsd: 10,
    sprintId: 'spr-1',
    ...patch,
  };
}

describe('rankSuggestions', () => {
  it('offers nothing for work that is done or already running', () => {
    // A suggestion to start something that is finished is worse than no
    // suggestion: it makes the whole list untrustworthy.
    const out = rankSuggestions([
      item({ id: 'a', status: 'done' }),
      item({ id: 'b', status: 'in_progress' }),
    ]);
    expect(out).toEqual([]);
  });

  it('puts blocked work first, then review, then not-started', () => {
    const out = rankSuggestions([
      item({ id: 'todo', status: 'todo', projectId: 'p1', projectName: 'One' }),
      item({ id: 'review', status: 'in_review', projectId: 'p2', projectName: 'Two' }),
      item({ id: 'blocked', status: 'blocked', projectId: 'p3', projectName: 'Three' }),
    ]);
    // Stalled costs more than unstarted, and finished-but-undelivered costs
    // more than not-yet-begun.
    expect(out.map((s) => s.workItemId)).toEqual(['blocked', 'review', 'todo']);
  });

  it('puts work assigned to you above work merely on your initiatives', () => {
    const out = rankSuggestions([
      item({ id: 'theirs', status: 'blocked', assigneeId: 'p-other', projectId: 'p1', projectName: 'One' }),
      item({ id: 'mine', status: 'todo', assigneeId: 'p-me', projectId: 'p2', projectName: 'Two' }),
    ], { personId: 'p-me' });
    // Both are yours in the sense that matters; one is waiting on you
    // specifically, and that outranks the kind ordering.
    expect(out[0]!.workItemId).toBe('mine');
  });

  it('spreads across initiatives before taking a second from one', () => {
    const out = rankSuggestions([
      item({ id: 'a1', status: 'blocked', priority: 'critical', projectId: 'p1', projectName: 'One' }),
      item({ id: 'a2', status: 'blocked', priority: 'high', projectId: 'p1', projectName: 'One' }),
      item({ id: 'b1', status: 'todo', priority: 'low', projectId: 'p2', projectName: 'Two' }),
    ], { limit: 2 });
    // Two cards on one project is a worse answer than one card each on two.
    expect(out.map((s) => s.initiativeId)).toEqual(['p1', 'p2']);
  });

  it('stays short — it is a nudge, not a backlog', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      item({ id: `wi-${i}`, projectId: `p-${i}`, projectName: `P${i}`, status: 'todo' }));
    expect(rankSuggestions(many)).toHaveLength(4);
    expect(rankSuggestions(many, { limit: 2 })).toHaveLength(2);
  });

  it('writes a prompt an agent can act on, not a restated title', () => {
    const [s] = rankSuggestions([item({ status: 'blocked', description: 'Needs the gateway topology decided.' })]);
    // The point of the card: you can run it without rewriting it.
    expect(s!.prompt).toContain('Roll out the collector fleet');
    expect(s!.prompt).toContain('Observability Platform');
    expect(s!.prompt).toMatch(/what it is waiting on/i);
    // The description is usually where the actual requirement lives.
    expect(s!.prompt).toContain('Needs the gateway topology decided.');
  });

  it('tells a starting prompt to propose before implementing', () => {
    const [s] = rankSuggestions([item({ status: 'todo' })]);
    // An agent that starts writing code off a one-line story title produces a
    // diff nobody asked for.
    expect(s!.prompt).toMatch(/before writing anything|Wait for a reply/i);
  });

  it('carries both estimates, which is how the operating model plans', () => {
    const [s] = rankSuggestions([item({ storyPoints: 8, estimatedCostUsd: 12.5 })]);
    expect(s!.storyPoints).toBe(8);
    expect(s!.estimatedCostUsd).toBe(12.5);
  });
});
