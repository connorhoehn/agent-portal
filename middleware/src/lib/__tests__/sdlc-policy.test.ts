// SDLC gate engine — the governance core, tested in isolation.
//
// This is what decides whether agent-written code can ship, so it is the one
// piece that most needs to behave identically in a test and in production.
// The engine is pure by design precisely so these cases pin it down.

import {
  evaluate,
  evaluatePolicy,
  globToRegExp,
  DEFAULT_POLICIES,
  type SdlcPolicy,
  type ChangeFacts,
} from '../sdlc-policy.js';

let _seq = 0;
function policy(p: Omit<SdlcPolicy, 'id'>): SdlcPolicy {
  return { id: `p${++_seq}`, ...p };
}
function facts(f: Partial<ChangeFacts>): ChangeFacts {
  return { files: [], model: null, reviewVerdict: null, costUsd: null, costBasis: 'unknown', ...f };
}

describe('globToRegExp', () => {
  it('matches * within a segment but not across slashes', () => {
    expect(globToRegExp('*.ts').test('main.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/main.ts')).toBe(false);
  });
  it('matches ** across segments', () => {
    expect(globToRegExp('infra/**').test('infra/lib/stack.ts')).toBe(true);
    expect(globToRegExp('**/auth/**').test('src/api/auth/login.ts')).toBe(true);
    expect(globToRegExp('**/*.tf').test('infra/aws/main.tf')).toBe(true);
  });
  it('does not match unrelated paths', () => {
    expect(globToRegExp('infra/**').test('portal/src/app.tsx')).toBe(false);
    expect(globToRegExp('**/auth/**').test('src/api/billing/charge.ts')).toBe(false);
  });
});

describe('require_review gate', () => {
  const p = policy({ name: 'review', enabled: true, kind: 'require_review', config: {}, action: 'require_approval' });

  it('is pending until a review exists — a change cannot outrun its review', () => {
    expect(evaluatePolicy(p, facts({ reviewVerdict: null }))!.outcome).toBe('requires_approval');
  });
  it('passes on approve', () => {
    expect(evaluatePolicy(p, facts({ reviewVerdict: 'approve' }))!.outcome).toBe('pass');
  });
  it('blocks on reject', () => {
    expect(evaluatePolicy(p, facts({ reviewVerdict: 'reject' }))!.outcome).toBe('block');
  });
});

describe('protected_paths gate', () => {
  const p = policy({
    name: 'sensitive', enabled: true, kind: 'protected_paths',
    config: { globs: ['infra/**', '**/auth/**'] }, action: 'require_approval',
  });

  it('does not fire when nothing sensitive is touched', () => {
    expect(evaluatePolicy(p, facts({ files: ['portal/src/app.tsx'] }))).toBeNull();
  });
  it('requires approval when a sensitive path is touched', () => {
    const g = evaluatePolicy(p, facts({ files: ['src/app.ts', 'infra/lib/stack.ts'] }))!;
    expect(g.outcome).toBe('requires_approval');
    expect(g.detail).toContain('infra/lib/stack.ts');
  });
  it('hard-blocks when the action is block', () => {
    const blocker = { ...p, action: 'block' as const };
    expect(evaluatePolicy(blocker, facts({ files: ['src/auth/login.ts'] }))!.outcome).toBe('block');
  });
});

describe('max_files gate', () => {
  const p = policy({ name: 'size', enabled: true, kind: 'max_files', config: { max: 3 }, action: 'require_approval' });
  it('ignores changes at or under the limit', () => {
    expect(evaluatePolicy(p, facts({ files: ['a', 'b', 'c'] }))).toBeNull();
  });
  it('fires over the limit', () => {
    expect(evaluatePolicy(p, facts({ files: ['a', 'b', 'c', 'd'] }))!.outcome).toBe('requires_approval');
  });
});

describe('model_allowlist gate', () => {
  const p = policy({
    name: 'models', enabled: true, kind: 'model_allowlist',
    config: { models: ['claude-sonnet-5'] }, action: 'block',
  });
  it('passes an allowed model', () => {
    expect(evaluatePolicy(p, facts({ model: 'claude-sonnet-5' }))).toBeNull();
  });
  it('gates a disallowed model', () => {
    expect(evaluatePolicy(p, facts({ model: 'claude-haiku-4-5' }))!.outcome).toBe('block');
  });
  it('routes an unknown author to a person even under action: block — never passes, never hard-blocks', () => {
    const g = evaluatePolicy(p, facts({ model: null }))!;
    expect(g).not.toBeNull();
    expect(g.outcome).toBe('requires_approval');
    expect(g.detail).toContain('(unknown)');
  });
});

describe('max_cost gate', () => {
  const p = policy({ name: 'spend', enabled: true, kind: 'max_cost', config: { maxUsd: 5 }, action: 'require_approval' });

  it('routes an unrecorded cost to a person — the fact is missing, and missing is not "under" (DE-33)', () => {
    // The old fail-open leaned on require_review, but that gate passes on a
    // Nova reviewer's approve, so an unrecorded cost was auto-approvable.
    const g = evaluatePolicy(p, facts({ costUsd: null }))!;
    expect(g.outcome).toBe('requires_approval');
    expect(g.detail).toBe("The run's cost was not recorded; a person must accept it.");
  });
  it('an unknown cost is requires_approval even under action: block — it is not evidence of overspend', () => {
    const blocker = { ...p, action: 'block' as const };
    expect(evaluatePolicy(blocker, facts({ costUsd: null }))!.outcome).toBe('requires_approval');
  });
  it('onUnknown: pass is the explicit operator opt-out', () => {
    const lenient = { ...p, config: { maxUsd: 5, onUnknown: 'pass' } };
    expect(evaluatePolicy(lenient, facts({ costUsd: null }))).toBeNull();
  });
  it('a local-compute $0 passes — a route-decided zero, not an absence', () => {
    expect(evaluatePolicy(p, facts({ costUsd: 0, costBasis: 'local' }))).toBeNull();
  });
  it('an estimate is judged like a reported figure, and the detail says so', () => {
    const g = evaluatePolicy(p, facts({ costUsd: 7.25, costBasis: 'estimated' }))!;
    expect(g.outcome).toBe('requires_approval');
    expect(g.detail).toContain('estimated');
    expect(g.detail).toContain('$7.25');
    expect(evaluatePolicy(p, facts({ costUsd: 4.5, costBasis: 'estimated' }))).toBeNull();
  });
  it('ignores runs at or under the limit', () => {
    expect(evaluatePolicy(p, facts({ costUsd: 4.99 }))).toBeNull();
    expect(evaluatePolicy(p, facts({ costUsd: 5 }))).toBeNull();
  });
  it('fires over the limit, naming both numbers', () => {
    const g = evaluatePolicy(p, facts({ costUsd: 7.25, costBasis: 'reported' }))!;
    expect(g.outcome).toBe('requires_approval');
    expect(g.detail).toContain('$7.25');
    expect(g.detail).toContain('$5.00');
  });
  it('hard-blocks when the action is block', () => {
    const blocker = { ...p, action: 'block' as const };
    expect(evaluatePolicy(blocker, facts({ costUsd: 100 }))!.outcome).toBe('block');
  });
  it('is a no-op with a non-positive or nonsense limit', () => {
    const zero = { ...p, config: { maxUsd: 0 } };
    const negative = { ...p, config: { maxUsd: -3 } };
    const junk = { ...p, config: { maxUsd: 'lots' } };
    expect(evaluatePolicy(zero, facts({ costUsd: 100 }))).toBeNull();
    expect(evaluatePolicy(negative, facts({ costUsd: 100 }))).toBeNull();
    expect(evaluatePolicy(junk, facts({ costUsd: 100 }))).toBeNull();
  });
});

describe('disabled policies never fire', () => {
  it('is skipped entirely', () => {
    const p = policy({ name: 'x', enabled: false, kind: 'max_files', config: { max: 1 }, action: 'block' });
    expect(evaluatePolicy(p, facts({ files: ['a', 'b'] }))).toBeNull();
  });
});

describe('aggregate decision', () => {
  const review = policy({ name: 'review', enabled: true, kind: 'require_review', config: {}, action: 'require_approval' });
  const paths = policy({
    name: 'paths', enabled: true, kind: 'protected_paths',
    config: { globs: ['infra/**'] }, action: 'require_approval',
  });

  it('auto-approves a clean, reviewed, non-sensitive change', () => {
    const e = evaluate([review, paths], facts({ files: ['README.md'], reviewVerdict: 'approve' }));
    expect(e.decision).toBe('approved');
    expect(e.autoApproved).toBe(true);
  });

  it('needs approval when a sensitive path is touched even after review passes', () => {
    const e = evaluate([review, paths], facts({ files: ['infra/lib/x.ts'], reviewVerdict: 'approve' }));
    expect(e.decision).toBe('needs_approval');
    expect(e.autoApproved).toBe(false);
  });

  it('surfaces changes_requested distinctly from a hard block', () => {
    const e = evaluate([review], facts({ files: ['a'], reviewVerdict: 'request_changes' }));
    expect(e.decision).toBe('changes_requested');
  });

  it('blocks when the reviewer rejects, regardless of other gates', () => {
    const e = evaluate([review, paths], facts({ files: ['README.md'], reviewVerdict: 'reject' }));
    expect(e.decision).toBe('blocked');
  });

  it('a hard block wins over a mere approval requirement', () => {
    const blocker = policy({
      name: 'blocker', enabled: true, kind: 'protected_paths',
      config: { globs: ['secrets/**'] }, action: 'block',
    });
    const e = evaluate([paths, blocker], facts({ files: ['infra/x.ts', 'secrets/key'], reviewVerdict: 'approve' }));
    expect(e.decision).toBe('blocked');
  });

  it('a policy block wins even when the reviewer only requested changes', () => {
    // The sharp edge: `changes_requested` is human-approvable, `blocked` is not.
    // If a policy hard-blocked the change AND the reviewer happened to request
    // changes, ordering the review case first would relabel it changes_requested
    // and let a human approve a change a policy forbade. The policy block must win.
    const blocker = policy({
      name: 'blocker', enabled: true, kind: 'protected_paths',
      config: { globs: ['**/*.secret'] }, action: 'block',
    });
    const e = evaluate([review, blocker], facts({ files: ['config/app.secret'], reviewVerdict: 'request_changes' }));
    expect(e.decision).toBe('blocked');
    expect(e.autoApproved).toBe(false);
  });

  it('still surfaces changes_requested when the only block is the review itself', () => {
    // No policy block here — the reviewer asking for changes is recoverable, and
    // a human may still address or override it. Guards against over-correcting
    // the fix above into blocking every requested-changes review.
    const e = evaluate([review, paths], facts({ files: ['README.md'], reviewVerdict: 'request_changes' }));
    expect(e.decision).toBe('changes_requested');
  });

  it('is never auto-approved before a review when review is required', () => {
    // The most important case: a change must not sail through just because it
    // was evaluated before the reviewer ran.
    const e = evaluate([review], facts({ files: ['README.md'], reviewVerdict: null }));
    expect(e.autoApproved).toBe(false);
    expect(e.decision).toBe('needs_approval');
  });

  it('an empty policy set auto-approves — the sharp edge the provider guards', () => {
    // The pure engine cannot tell "no policies configured" from "policies
    // configured, none fired", so zero gates reads as approved. This is why
    // evaluateChange() seeds defaults and, if the set is still empty, forces
    // needs_approval rather than trusting this result. Pinning the contract so
    // nobody "fixes" it here and quietly breaks that fail-closed reasoning.
    const e = evaluate([], facts({ files: ['infra/prod.tf'], reviewVerdict: null }));
    expect(e.decision).toBe('approved');
    expect(e.autoApproved).toBe(true);
  });
});

describe('default policies are safe out of the box', () => {
  const defaults = DEFAULT_POLICIES.map((p, i) => ({ id: `d${i}`, ...p }));

  it('never auto-approves an unreviewed change', () => {
    const e = evaluate(defaults, facts({ files: ['README.md'], reviewVerdict: null }));
    expect(e.autoApproved).toBe(false);
  });
  it('sends an infra change to a human', () => {
    const e = evaluate(defaults, facts({ files: ['infra/lib/aurora.ts'], reviewVerdict: 'approve' }));
    expect(e.decision).toBe('needs_approval');
  });
  it('auto-approves a small, reviewed docs change whose run cost is recorded', () => {
    const e = evaluate(defaults, facts({ files: ['docs/readme.md'], reviewVerdict: 'approve', costUsd: 0.1, costBasis: 'reported' }));
    expect(e.decision).toBe('approved');
  });
  it('sends an expensive run to a human even after review passes', () => {
    const e = evaluate(defaults, facts({ files: ['docs/readme.md'], reviewVerdict: 'approve', costUsd: 12 }));
    expect(e.decision).toBe('needs_approval');
  });
  it('routes a run whose cost was never recorded to a person (DE-33)', () => {
    const e = evaluate(defaults, facts({ files: ['docs/readme.md'], reviewVerdict: 'approve', costUsd: null }));
    expect(e.decision).toBe('needs_approval');
    expect(e.gates.map((g) => g.kind)).toContain('max_cost');
  });
  it('auto-approves a reviewed change whose run cost is recorded and under the limit', () => {
    const e = evaluate(defaults, facts({ files: ['docs/readme.md'], reviewVerdict: 'approve', costUsd: 0.42, costBasis: 'reported' }));
    expect(e.decision).toBe('approved');
  });
});

// ─── DE-43 / DE-46: loosening, set validation, governance paths ────────────
import {
  looseningChanges as loosening, policySetError, normalizePolicy, governancePathsTouched,
  DEFAULT_POLICIES as DEFAULTS, evaluate as evaluateSet, type SdlcPolicy as Policy,
} from '../sdlc-policy.js';

describe('looseningChanges', () => {
  const base: Policy[] = [
    { id: 'r', name: 'Review', enabled: true, kind: 'require_review', config: {}, action: 'require_approval' },
    { id: 'p', name: 'Paths', enabled: true, kind: 'protected_paths', config: { globs: ['infra/**', '**/*.tf'] }, action: 'block' },
    { id: 'f', name: 'Files', enabled: true, kind: 'max_files', config: { max: 40 }, action: 'require_approval' },
    { id: 'c', name: 'Cost', enabled: true, kind: 'max_cost', config: { maxUsd: 5 }, action: 'require_approval' },
    { id: 'm', name: 'Models', enabled: true, kind: 'model_allowlist', config: { models: ['a'] }, action: 'require_approval' },
  ];
  const edit = (id: string, patch: Partial<Policy>) => base.map((p) => (p.id === id ? { ...p, ...patch } : p));

  it('reads an unchanged set, an added policy and every tightening as not loosening', () => {
    expect(loosening(base, base)).toEqual([]);
    expect(loosening(base, [...base, { id: 'x', name: 'X', enabled: true, kind: 'max_files', config: { max: 1 }, action: 'block' }])).toEqual([]);
    expect(loosening(base, edit('f', { config: { max: 10 } }))).toEqual([]);
    expect(loosening(base, edit('p', { config: { globs: ['infra/**', '**/*.tf', '**/*.cedar'] } }))).toEqual([]);
    expect(loosening(base, edit('m', { config: { models: [] } }).filter((p) => p.id !== 'm').concat([{ ...base[4]!, config: { models: ['a'] } }]))).toEqual([]);
    expect(loosening(base, edit('f', { action: 'block' }))).toEqual([]);
  });

  it('names each loosening: disable, delete, downgrade, raise, remove a glob, allow a model, empty the allowlist', () => {
    expect(loosening(base, edit('f', { enabled: false }))).toEqual(['disables "Files"']);
    expect(loosening(base, base.filter((p) => p.id !== 'c'))).toEqual(['removes "Cost"']);
    expect(loosening(base, edit('p', { action: 'require_approval' }))[0]).toMatch(/downgrades "Paths"/);
    expect(loosening(base, edit('f', { config: { max: 41 } }))[0]).toMatch(/raises "Files" from 40 to 41/);
    expect(loosening(base, edit('c', { config: {} }))[0]).toMatch(/raises "Cost" from \$5 to no limit/);
    expect(loosening(base, edit('p', { config: { globs: ['infra/**'] } }))[0]).toMatch(/removes 1 protected path .*\*\*\/\*\.tf/);
    expect(loosening(base, edit('m', { config: { models: ['a', 'b'] } }))[0]).toMatch(/allows b/);
    expect(loosening(base, edit('m', { config: { models: [] } }))[0]).toMatch(/empties the allowlist/);
    expect(loosening(base, edit('f', { kind: 'max_cost' }))[0]).toMatch(/changes the kind/);
  });

  it('a policy already disabled can be removed without counting as loosening', () => {
    const off = edit('c', { enabled: false });
    expect(loosening(off, off.filter((p) => p.id !== 'c'))).toEqual([]);
  });
});

describe('policy set validation', () => {
  it('normalises a policy, defaulting action to require_approval and enabled to true', () => {
    expect(normalizePolicy({ id: ' k ', name: ' N ', kind: 'max_files', action: 'blocK' }))
      .toEqual({ id: 'k', name: 'N', enabled: true, kind: 'max_files', config: {}, action: 'require_approval' });
    expect(normalizePolicy({ name: 'N', kind: 'max_files' })).toMatch(/stable id/);
    expect(normalizePolicy({ id: 'k', name: 'N', kind: 'vibes' })).toMatch(/kind must be one of/);
  });

  it('refuses duplicate ids and a set without the independent-review policy', () => {
    const r: Policy = { id: 'r', name: 'R', enabled: false, kind: 'require_review', config: {}, action: 'require_approval' };
    expect(policySetError([r])).toBeNull();
    expect(policySetError([r, r])).toMatch(/duplicate/);
    expect(policySetError([])).toMatch(/independent-review policy cannot be removed/);
  });
});

describe('governance code (DE-43 §6, DE-46)', () => {
  it('names the files that are the governance', () => {
    expect(governancePathsTouched([
      'middleware/src/lib/sdlc-policy.ts', 'schema/agent_sdlc_schema.sql',
      'middleware/seeds/roles/orgiq/sme.cedar', 'middleware/src/lib/authz.ts', 'src/app.ts',
    ])).toEqual([
      'middleware/src/lib/sdlc-policy.ts', 'schema/agent_sdlc_schema.sql',
      'middleware/seeds/roles/orgiq/sme.cedar', 'middleware/src/lib/authz.ts',
    ]);
  });

  it('the default sensitive-paths policy now routes them to a human', () => {
    const policies = DEFAULTS.map((p, i) => ({ ...p, id: String(i) }));
    for (const f of ['middleware/src/lib/sdlc-policy.ts', 'middleware/seeds/roles/orgiq/sme.cedar', 'schema/sdlc_governance_schema.sql']) {
      const out = evaluateSet(policies, { files: [f], model: null, reviewVerdict: 'approve', costUsd: null, costBasis: 'unknown' });
      expect([f, out.decision]).toEqual([f, 'needs_approval']);
    }
  });
});
