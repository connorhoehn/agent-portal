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
  return { files: [], model: null, reviewVerdict: null, ...f };
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
  it('treats an unknown author as not-allowed', () => {
    expect(evaluatePolicy(p, facts({ model: null }))!.outcome).toBe('block');
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

  it('is never auto-approved before a review when review is required', () => {
    // The most important case: a change must not sail through just because it
    // was evaluated before the reviewer ran.
    const e = evaluate([review], facts({ files: ['README.md'], reviewVerdict: null }));
    expect(e.autoApproved).toBe(false);
    expect(e.decision).toBe('needs_approval');
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
  it('auto-approves a small, reviewed docs change', () => {
    const e = evaluate(defaults, facts({ files: ['docs/readme.md'], reviewVerdict: 'approve' }));
    expect(e.decision).toBe('approved');
  });
});
