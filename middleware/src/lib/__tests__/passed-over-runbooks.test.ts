// The in-scope runbooks a brief did not give, with a reason in words (session-brief-preview.ts).
import { passedOverRunbooks } from '../session-brief-preview.js';
import type { RunbookCandidate } from '../runbooks/index.js';

const cand = (id: string, title: string) => ({ runbook: { id }, version: { doc: { title } } }) as unknown as RunbookCandidate;

describe('passedOverRunbooks', () => {
  const candidates = [cand('rb-a', 'Alpha'), cand('rb-b', 'Bravo'), cand('rb-c', 'Charlie'), cand('rb-d', 'Delta'), cand('rb-out', 'Elsewhere')];

  it('lists matched-but-lost first, then in-scope no-match by name, and never out-of-scope ones', () => {
    const out = passedOverRunbooks(
      { excluded: [{ runbook_id: 'rb-d', reason: 'no_match' }, { runbook_id: 'rb-c', reason: 'no_match' }, { runbook_id: 'rb-out', reason: 'scope' }] },
      [{ runbook_id: 'rb-b', reason: 'limit' }, { runbook_id: 'rb-a', reason: 'budget' }],
      candidates,
    );
    expect(out.map((p) => [p.id, p.kind])).toEqual([['rb-b', 'limit'], ['rb-a', 'budget'], ['rb-c', 'no_match'], ['rb-d', 'no_match']]);
    expect(out[0]!.name).toBe('Bravo');
    expect(out[0]!.reason).toMatch(/at most two/);
    expect(out.map((p) => p.id)).not.toContain('rb-out');
  });

  it('names nothing twice and ignores a scope omission', () => {
    const out = passedOverRunbooks({ excluded: [{ runbook_id: 'rb-a', reason: 'no_match' }] }, [{ runbook_id: 'rb-a', reason: 'limit' }, { runbook_id: 'rb-b', reason: 'scope' }], candidates);
    expect(out.map((p) => p.id)).toEqual(['rb-a']);
  });
});
