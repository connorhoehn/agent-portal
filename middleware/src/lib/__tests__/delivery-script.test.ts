// Delivery script — the one place a GitHub token touches the workspace.
//
// buildDeliveryScript is pure precisely so this property can be pinned: the
// token lands in .git/config only for the push, and the strip-back-to-clean
// runs whether or not the push succeeds. A push fails routinely; gating the
// strip behind its success (a plain `&&` chain) would leave the token in the
// workspace's .git/config on every failed push. These tests exist so nobody
// re-chains it and quietly reintroduces that leak.

import { buildDeliveryScript } from '../delivery-script.js';

const script = (commitSha?: string | null) =>
  buildDeliveryScript({
    git: "git -C /mnt/workspace/repo",
    branch: 'orgiq/change-abcd1234',
    b64CommitMsg: 'dGl0bGU=',
    repoFullName: 'acme/widgets',
    commitSha,
  });

describe('buildDeliveryScript token hygiene', () => {
  it('strips the credential back to a clean remote after the push', () => {
    expect(script()).toContain('remote set-url origin https://github.com/acme/widgets.git');
  });

  it('runs the strip unconditionally — not gated behind the push succeeding', () => {
    const lines = script().split('\n');
    const pushIdx = lines.findIndex((l) => l.includes('push -u origin'));
    const cleanIdx = lines.findIndex(
      (l) => l.includes('set-url origin https://github.com/acme/widgets.git'),
    );
    // The clean-up is a later statement, reached regardless of the push result.
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(cleanIdx).toBeGreaterThan(pushIdx);
    // The push line must not `&&`-chain the clean-up onto its own success, which
    // is the exact shape that dropped the strip when a push failed.
    expect(lines[pushIdx]).not.toContain('set-url origin https://github.com/acme/widgets.git');
    expect(lines[pushIdx]).not.toMatch(/&&\s*$/);
  });

  it('never bakes an expanded token into the script — the caller supplies it as env', () => {
    // The authed remote references the variable, never a literal secret.
    expect(script()).toContain('x-access-token:$ORGIQ_GH_TOKEN@github.com/acme/widgets.git');
  });

  it('preserves the push exit code across the clean-up', () => {
    const lines = script().split('\n');
    expect(lines.some((l) => l.trim() === 'push_rc=$?')).toBe(true);
    expect(lines[lines.length - 1].trim()).toBe('exit $push_rc');
  });

  it('bails before touching the credential if the commit prep fails', () => {
    // The authed remote must be set only after a `|| exit 1` guard, so a failed
    // checkout/commit never writes the token into config.
    const s = script();
    const exitGuard = s.indexOf('|| exit 1');
    const authed = s.indexOf('set-url origin https://x-access-token');
    expect(exitGuard).toBeGreaterThanOrEqual(0);
    expect(authed).toBeGreaterThan(exitGuard);
  });
});

describe('buildDeliveryScript commit-per-capture vs legacy', () => {
  const SHA = 'a'.repeat(40);

  it('legacy (no commit) snapshots the working tree', () => {
    const s = script();
    expect(s).toContain('add -A');
    expect(s).toContain('commit -m');
    expect(s).toContain('checkout -B orgiq/change-abcd1234 &&'); // then add/commit
  });

  it('commit-per-capture branches from the captured commit and pushes it as-is', () => {
    const s = script(SHA);
    // Branch is created *at* the captured commit — no add, no commit.
    expect(s).toContain(`checkout -B orgiq/change-abcd1234 ${SHA}`);
    expect(s).not.toContain('add -A');
    expect(s).not.toContain('commit -m');
    // Still guarded, still strips the credential unconditionally.
    expect(s).toContain('|| exit 1');
    expect(s).toContain('remote set-url origin https://github.com/acme/widgets.git');
    expect(s.split('\n').at(-1)!.trim()).toBe('exit $push_rc');
  });
});
