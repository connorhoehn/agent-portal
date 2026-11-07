// Two things `tools/local-compute-worker.mjs` must keep doing, pinned against
// the source because no runner covers `tools/` and both were regressions that
// cost a user their whole first run.
//
// THE BUG. `/register` records capabilities; only `/announce` moves
// `lastSeenAt`, which is the single input to `statusOfNode`. The worker used
// to call `startPresenceLoop(config)` AFTER `waitForAcceptJobs(...)` — a loop
// that does not return until the owner flips "Accepting work" in the portal.
// So a paired-but-not-switched-on machine announced nothing at all and the
// portal read it as `offline`, because from the server's side nothing had
// ever arrived.
//
// That deadlocked the documented first run. PairMachineDialog waits for
// `presence.status === 'connected'` before closing, and it is a MODAL — so it
// covered the row holding the "Accepting work" switch while promising to
// close once the machine reported in, and the worker told the user it would
// pick that switch up on its own. Both sides waited for the other; the one
// control that broke the tie was underneath the dialog.
//
// Being present and accepting work are different facts. A paired, running,
// reachable machine IS connected — it just is not taking jobs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKER = join(__dirname, '..', '..', '..', '..', 'tools', 'local-compute-worker.mjs');
const source = readFileSync(WORKER, 'utf8');

describe('local-compute-worker.mjs — presence is independent of acceptJobs', () => {
  it('starts the presence loop BEFORE the startup wait-for-accept-jobs', () => {
    // Anchor on the STARTUP call by its message. There is a second
    // `waitForAcceptJobs` inside the claim loop (for the portal switching a
    // machine off mid-run) which sits earlier in the file, and a bare
    // indexOf finds that one — a test that passes while measuring the wrong
    // call is worse than no test.
    const start = source.indexOf('startPresenceLoop(config);');
    const wait = source.indexOf("waitForAcceptJobs(config, 'this machine is paired but not switched on')");
    expect(start).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(-1);
    expect(start).toBeLessThan(wait);
  });

  it('the mid-run pause is inside the loop, where presence is already running', () => {
    // The other `waitForAcceptJobs` call needs no ordering fix — by the time
    // the claim loop runs, the presence interval has been ticking since
    // startup — but if it ever moved above `startPresenceLoop` it would
    // reintroduce the same silence.
    const midRun = source.indexOf("waitForAcceptJobs(config, 'the portal switched this machine off')");
    const start = source.indexOf('startPresenceLoop(config);');
    expect(midRun).toBeGreaterThan(-1);
    // It is lexically earlier (it lives in a function defined above the
    // startup block) but only ever REACHED from `loop(config)`, which runs
    // after startPresenceLoop. Assert the call site it is reached from.
    expect(source.indexOf('await loop(config);')).toBeGreaterThan(start);
  });

  it('starts the presence loop exactly once — a second call would run two intervals', () => {
    const calls = source.match(/^\s*startPresenceLoop\(config\);\s*$/gm) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('waitForAcceptJobs still blocks until the switch flips, so the ordering is what does the work', () => {
    // If this loop ever became non-blocking the ordering above would stop
    // mattering and this file would be pinning nothing. `for (;;)` with an
    // `await` inside is the shape that makes the bug possible.
    const fn = source.slice(source.indexOf('async function waitForAcceptJobs('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/for \(;;\)/);
    expect(body).toMatch(/await new Promise/);
  });
});

// docs/next-steps.md section 8, package 6. The worker cloned with
// `execSync(\`git clone ${repoUrl} ${name}\`)`, so a job's `repo` was a shell
// command line, and ran `claude -p --dangerously-skip-permissions`, so a
// prompt could do anything the operator's account can. Neither may come back.
describe('local-compute-worker.mjs — no shell, no blanket permissions', () => {
  it('clones through execFileSync with an argument array and an option terminator', () => {
    expect(source).not.toMatch(/execSync\(\s*`git clone/);
    expect(source).toContain("execFileSync('git', ['clone', '--', repoUrl, name]");
  });

  it('runs no git command through a shell at all', () => {
    expect(source).not.toMatch(/\bexecSync\(/);
  });

  it('never passes --dangerously-skip-permissions; it passes an explicit allowlist and denies the rest', () => {
    expect(source).not.toContain("'--dangerously-skip-permissions'");
    expect(source).toContain("'--allowedTools', ALLOWED_TOOLS.join(',')");
    expect(source).toContain("'--permission-mode', 'dontAsk'");
  });

  it('refuses a repo that is not a GitHub URL before it reaches git', () => {
    expect(source).toMatch(/function ensureRepo\(repoUrl\) \{[\s\S]*?REPO_URL_RE\.test\(repoUrl\)/);
  });
});
