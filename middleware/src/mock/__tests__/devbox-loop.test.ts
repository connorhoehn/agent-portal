// The three `src/lib` blockers that kept the governed-run and delivery loops
// off the table in `dev:mock`, and the one property each of them must hold.
//
// None of these is "the mock returns something". `resolveDevboxArn` returning
// null was the whole 503, so the test that matters is that it stops returning
// null offline *without* touching the env override or the live lookup;
// `reviewDiff` offline must produce a verdict that DIFFERS with the diff, or it
// is a rubber stamp and worse than the 503 it replaced; and `deliverChange`
// must still refuse a workspace that no longer holds the change, because that
// refusal is the only thing standing between a delivery and a branch built out
// of whatever happens to be on disk.
//
// The reviewer's failure path is tested here too, in real mode: the catch that
// degrades a thrown Bedrock call to `request_changes` is a governance
// guarantee, and a mock branch added above it must not have moved it.

jest.mock('../../config.js', () => ({
  config: { mock: { aurora: true, agentcore: true }, region: 'us-east-1', accountId: '' },
}));

import { fixtureRegistry } from '../core/index.js';
import { reviewDiff } from '../../lib/change-reviewer.js';
import { deliverChange } from '../../lib/change-delivery.js';
import { resolveDevboxArn, devboxDataClient, _arnInternal } from '../../lib/devbox-arn.js';
import { runMockShell, runMockTask, mockDevboxClient } from '../devbox-shell.js';
import { devboxDeliveries } from '../devbox-delivery.js';
import {
  commitPending, devboxWorkspaces, hasCommit, porcelain, selectWorkProduct,
  stageWork, workspaceFor,
} from '../devbox-workspace.js';
import { staticReview } from '../static-review.js';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';

const SESSION = 'orgiq-devbox-test-session-000000000000000';

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  _arnInternal.reset();
  delete process.env['DEVBOX_RUNTIME_ARN'];
});

// ─── devbox-arn ─────────────────────────────────────────────────────────────

describe('resolveDevboxArn offline', () => {
  it('answers with a runtime instead of null — the 503 every caller raised', async () => {
    const arn = await resolveDevboxArn();
    expect(arn).not.toBeNull();
    expect(arn).toMatch(/^arn:aws:bedrock-agentcore:us-east-1:0{12}:runtime\//);
  });

  it('says in the ARN itself that no runtime was deployed', async () => {
    expect(await resolveDevboxArn()).toMatch(/-MOCK$/);
  });

  it('still lets DEVBOX_RUNTIME_ARN win — an operator pointing at a real runtime is not overridden', async () => {
    process.env['DEVBOX_RUNTIME_ARN'] = 'arn:aws:bedrock-agentcore:us-east-1:647757222309:runtime/orgiq_devbox-abc';
    expect(await resolveDevboxArn()).toBe(process.env['DEVBOX_RUNTIME_ARN']);
  });

  it('hands out a client that never leaves the process', async () => {
    const out = await devboxDataClient().send({
      input: { runtimeSessionId: SESSION, body: { command: 'git status --porcelain -uall' } },
    } as never) as { stream: AsyncIterable<unknown> };
    expect(out.stream).toBeDefined();
  });
});

// ─── the fake microVM ───────────────────────────────────────────────────────

describe('the mock devbox shell', () => {
  it('reports a clean tree until a run stages work, then reports what it staged', () => {
    expect(porcelain(workspaceFor(SESSION))).toBe('');
    runMockTask(SESSION, 'Make trace sampling deterministic');
    const lines = porcelain(workspaceFor(SESSION)).split('\n');
    expect(lines).toContain(' M src/collector/sampler.ts');
    // `new file mode` in the diff is what makes a path untracked, not a guess.
    expect(lines).toContain('?? src/collector/sampler.test.ts');
  });

  it('commits the pending work and hands back a sha commitCapture will accept', () => {
    runMockTask(SESSION, 'Make trace sampling deterministic');
    const out = runMockShell(SESSION, 'git add -A && git commit -q -m "x" && git rev-parse HEAD');
    const sha = out.trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(hasCommit(SESSION, sha)).toBe(true);
    // The tree is clean afterwards — that is the point of commit-per-capture.
    expect(porcelain(workspaceFor(SESSION))).toBe('');
  });

  it('answers an unrecognised probe with fatal:, not with silence', () => {
    // Silence reads as "the tree is clean" to readWorkingTree, which is the
    // most misleading answer this module could give.
    expect(runMockShell(SESSION, 'git bisect start')).toMatch(/^fatal:/);
  });

  it('says a commit is missing once the branch has been rolled back', () => {
    stageWork(SESSION, 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n');
    const sha = commitPending(SESSION)!;
    expect(runMockShell(SESSION, `git cat-file -e ${sha}^{commit}`)).toMatch(/__OK__/);
    runMockShell(SESSION, `git reset -q --hard ${sha}~1`);
    expect(runMockShell(SESSION, `git cat-file -e ${sha}^{commit}`)).toMatch(/__MISSING__/);
  });

  it('unwraps the base64 probe runDevboxShell actually sends', () => {
    const b64 = Buffer.from('git status --porcelain -uall | head -400', 'utf8').toString('base64');
    const wrapped = `sh -c 'export HOME=/mnt/workspace; echo ${b64} | base64 -d > /tmp/.orgiq-probe; . /tmp/.orgiq-probe < /dev/null'`;
    stageWork(SESSION, 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n');
    expect(runMockShell(SESSION, wrapped)).toContain('a.ts');
  });

  it('a work product is chosen by a declared keyword, never at random', () => {
    expect(selectWorkProduct('Reduce alert noise please')?.id).toBe('throttle');
    expect(selectWorkProduct('Set Partitioned on the session cookie')?.id).toBe('auth-cookie');
    expect(selectWorkProduct('Something else entirely')?.id).toBe('sampler');
  });

  it('a workspace is a fixture, so the control plane can take it away', () => {
    runMockTask(SESSION, 'anything');
    expect(devboxWorkspaces.rows()).toHaveLength(1);
    fixtureRegistry.resetAll('default');
    expect(devboxWorkspaces.rows()).toHaveLength(0);
  });
});

// ─── the offline reviewer ───────────────────────────────────────────────────

describe('reviewDiff offline', () => {
  const review = (diff: string) => reviewDiff({ title: 't', diff, truncated: false });

  it('is not a rubber stamp — the verdict follows the diff', async () => {
    const clean = await review(selectWorkProduct('Make trace sampling deterministic')!.diff);
    const dirty = await review(selectWorkProduct('Reduce alert noise')!.diff);
    expect(clean.verdict).toBe('approve');
    expect(dirty.verdict).toBe('request_changes');
  });

  it('rejects a committed credential rather than asking for a revision', async () => {
    const diff = [
      'diff --git a/src/config.ts b/src/config.ts',
      '--- a/src/config.ts',
      '+++ b/src/config.ts',
      '@@ -1,1 +1,2 @@',
      ' export const region = "us-east-1";',
      '+export const apiKey = "sk-live-9f2c17a05b644de1";',
      '',
    ].join('\n');
    const out = await review(diff);
    expect(out.verdict).toBe('reject');
    expect(out.findings[0]?.severity).toBe('high');
  });

  it('points each finding at a line that exists on the new side of the diff', async () => {
    const product = selectWorkProduct('Reduce alert noise')!;
    const out = await review(product.diff);
    const debug = out.findings.find((f) => /Debug output/.test(f.note));
    expect(debug?.file).toBe('src/alerts/throttle.ts');
    // Hunk starts at new-side 22; the console.log is the third line of it.
    expect(debug?.line).toBe(24);
  });

  it('never claims to be a Bedrock model', async () => {
    const out = await review(selectWorkProduct('anything')!.diff);
    expect(out.model).toBe('offline/static-diff-review');
    expect(out.model).not.toMatch(/nova|anthropic|amazon\./);
  });

  it('still rejects an empty change before any branch runs', async () => {
    expect((await review('   ')).verdict).toBe('reject');
  });

  it('flags a truncated diff rather than judging what it could not read', async () => {
    const out = await reviewDiff({
      title: 't', truncated: true,
      diff: selectWorkProduct('Make trace sampling deterministic')!.diff,
    });
    expect(out.verdict).toBe('request_changes');
    expect(out.findings.some((f) => /truncated/i.test(f.note))).toBe(true);
  });

  it('reports a removed guard with no line number, because a removed line has none', () => {
    const out = staticReview({
      title: 't', truncated: false,
      diff: [
        'diff --git a/src/routes/x.ts b/src/routes/x.ts',
        '--- a/src/routes/x.ts',
        '+++ b/src/routes/x.ts',
        '@@ -10,3 +10,2 @@',
        '-router.post("/x", requireAction("ManageDevbox"), h);',
        '+router.post("/x", h);',
        ' export default router;',
        '',
      ].join('\n'),
    });
    const guard = out.findings.find((f) => /removes a check/.test(f.note));
    expect(guard).toBeDefined();
    expect(guard?.line).toBeUndefined();
    expect(out.verdict).toBe('request_changes');
  });
});

// ─── the reviewer's real-mode failure path, unchanged ───────────────────────

describe('reviewDiff in real mode', () => {
  it('still degrades a thrown Bedrock call to request_changes', async () => {
    // The mock branch was added ABOVE the try/catch, so with the flag off the
    // outage path is exactly what it was: ask a human, never approve.
    //
    // The outage is SIMULATED, and has to be. This test used to turn the mock
    // flag off and simply call the real reviewer, which meant it asserted the
    // failure path while depending on the ambient environment to produce the
    // failure — it passed only on a machine with no working AWS credentials.
    // Run it after `aws-azure-login` and the Converse call succeeds, returning
    // a real review, and the assertion on "could not be completed" fails. A
    // test for the outage path must create the outage.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { config } = require('../../config.js') as { config: { mock: { agentcore: boolean } } };
    const send = jest
      .spyOn(BedrockRuntimeClient.prototype, 'send')
      .mockRejectedValue(new Error('simulated Bedrock outage'));
    config.mock.agentcore = false;
    try {
      const out = await reviewDiff({
        title: 't', truncated: false,
        diff: selectWorkProduct('Make trace sampling deterministic')!.diff,
      });
      expect(send).toHaveBeenCalled();
      expect(out.verdict).toBe('request_changes');
      expect(out.summary).toMatch(/could not be completed/);
      expect(out.model).not.toBe('offline/static-diff-review');
    } finally {
      config.mock.agentcore = true;
      send.mockRestore();
    }
  }, 30_000);
});

// ─── delivery ───────────────────────────────────────────────────────────────

describe('deliverChange offline', () => {
  const base = {
    client: mockDevboxClient(),
    runtimeArn: 'arn:mock',
    sessionId: SESSION,
    checkout: '/mnt/workspace/repo',
    repoFullName: 'connorhoehnslalom/orgiq-observability',
    defaultBranch: 'main',
    connectionName: 'github-primary',
    changeId: 'b8c5d347-8ade-456f-adf1-604dfa4c3e60',
    title: 'A change',
    reviewSummary: null,
  };

  it('opens a PR for a change whose commit is still in the workspace', async () => {
    runMockTask(SESSION, 'Make trace sampling deterministic');
    const sha = runMockShell(SESSION, 'git add -A && git commit -q -m "x" && git rev-parse HEAD').trim();
    const out = await deliverChange({ ...base, commitSha: sha });
    expect(out.ok).toBe(true);
    expect(out.branch).toBe('orgiq/change-b8c5d347');
    // Never a number a seeded change could also be claiming.
    expect(out.prUrl).toBe('https://github.com/connorhoehnslalom/orgiq-observability/pull/101');
  });

  it('refuses a change whose commit the workspace no longer holds', async () => {
    workspaceFor(SESSION);
    const out = await deliverChange({ ...base, commitSha: 'f'.repeat(40) });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no longer in the workspace/);
  });

  it('refuses a working-tree delivery against a clean tree', async () => {
    workspaceFor(SESSION);
    const out = await deliverChange({ ...base, commitSha: null });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no longer holds these changes/);
  });

  it('still refuses to deliver without a credential to push with', async () => {
    const out = await deliverChange({ ...base, connectionName: null, commitSha: null });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no GitHub connection/);
  });

  it('is idempotent on the branch, as the real 422 path is', async () => {
    runMockTask(SESSION, 'Make trace sampling deterministic');
    const sha = runMockShell(SESSION, 'git add -A && git commit -q -m "x" && git rev-parse HEAD').trim();
    const first = await deliverChange({ ...base, commitSha: sha });
    const second = await deliverChange({ ...base, commitSha: sha });
    expect(second.prUrl).toBe(first.prUrl);
    expect(devboxDeliveries.rows()).toHaveLength(1);
  });

  it('a delivery is a fixture row, so reset undoes it', async () => {
    runMockTask(SESSION, 'Make trace sampling deterministic');
    const sha = runMockShell(SESSION, 'git add -A && git commit -q -m "x" && git rev-parse HEAD').trim();
    await deliverChange({ ...base, commitSha: sha });
    expect(devboxDeliveries.rows()).toHaveLength(1);
    fixtureRegistry.resetAll('default');
    expect(devboxDeliveries.rows()).toHaveLength(0);
  });
});
