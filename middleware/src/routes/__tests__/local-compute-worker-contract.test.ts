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
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { allowedRepoHosts, normaliseRepo } from '../../lib/local-compute-repo.js';

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
    expect(source).toContain("'--allowedTools', tools.join(',')");
    expect(source).toContain("'--permission-mode', 'dontAsk'");
  });

  it('refuses a repo on a host it does not allow before it reaches git', () => {
    expect(source).toMatch(/function ensureRepo\(rawRepo\) \{[\s\S]*?normaliseRepoUrl\(rawRepo, REPO_HOSTS\.hosts\);\s*if \(!repoUrl\) \{\s*throw/);
  });
});

// Review follow-up: Write/Edit plus `Bash(git commit:*)` let a run write
// .git/hooks/pre-commit and then commit, which runs the hook: a shell by
// another name. Writes under .git/ are denied outright.
describe('local-compute-worker.mjs — nothing writes under .git/', () => {
  it('denies writes under .git/ and passes the deny list to claude', () => {
    // Edit(path) deny rules cover every file-editing tool (Write and
    // NotebookEdit too); Claude Code ignores Write(path) deny rules.
    expect(source).toContain("const DISALLOWED_TOOLS = ['Edit(./.git/**)', 'Edit(**/.git/**)'];");
    expect(source).toContain("'--disallowedTools', DISALLOWED_TOOLS.join(',')");
  });

  it('says in its header that the test commands run only inside the cloned repo', () => {
    const header = source.slice(0, source.indexOf('import '));
    expect(header).toMatch(/test commands are\s+\/\/\s+kept only for a run whose working directory is the repo this worker\s+\/\/\s+cloned/);
    expect(header).toContain('LOCAL_ALLOWED_TOOLS');
    expect(header).toContain('LOCAL_ALLOWED_REPO_HOSTS');
  });
});

// docs/next-steps.md section 9 item 3: the default allowlist runs the repo's
// tests, but only with the cloned repo as the working directory. The policy
// lives in tools/local-compute-policy.mjs, evaluated here in a fresh node
// (the CJS jest build cannot import an .mjs).
const POLICY = join(__dirname, '..', '..', '..', '..', 'tools', 'local-compute-policy.mjs');
function policy<T>(expr: string, env: Record<string, string> = {}): T {
  const driver = `const p = await import(${JSON.stringify(POLICY)}); process.stdout.write(JSON.stringify(${expr}));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', driver], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (out.status !== 0) throw new Error(out.stderr);
  return JSON.parse(out.stdout) as T;
}
const TESTS = ['Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npx jest:*)', 'Bash(npx vitest:*)', 'Bash(pytest:*)'];

describe('local-compute-worker.mjs — the repo\'s tests, inside the clone only', () => {
  it('the default allowlist carries the five test commands and still no general shell', () => {
    const defaults = policy<string[]>('p.allowedToolsFrom(undefined)');
    expect(defaults).toEqual(expect.arrayContaining(TESTS));
    expect(defaults.filter((t) => /^Bash\((?!git |ls:|npm test:|npm run test:|npx jest:|npx vitest:|pytest:)/.test(t))).toEqual([]);
    expect(defaults).not.toContain('Bash');
  });

  it('a run inside the clone keeps them; a run with no clone, or outside it, has them removed', () => {
    const inClone = policy<string[]>(`p.toolsForRun(p.allowedToolsFrom(), { cwd: '/w/repos/api/', clonePath: '/w/repos/api' })`);
    expect(inClone).toEqual(expect.arrayContaining(TESTS));
    const noClone = policy<string[]>(`p.toolsForRun(p.allowedToolsFrom(), { cwd: '/home/op', clonePath: null })`);
    for (const t of TESTS) expect(noClone).not.toContain(t);
    expect(noClone).toEqual(expect.arrayContaining(['Read', 'Edit', 'Bash(git commit:*)']));
    const elsewhere = policy<string[]>(`p.toolsForRun(p.allowedToolsFrom(), { cwd: '/w/repos', clonePath: '/w/repos/api' })`);
    for (const t of TESTS) expect(elsewhere).not.toContain(t);
    // An operator's own list loses them too when there is no clone.
    const operator = policy<string[]>(`p.toolsForRun(p.allowedToolsFrom('Read, Bash(npm test:*) ,Bash(make:*)'), { cwd: '/home/op', clonePath: null })`);
    expect(operator).toEqual(['Read', 'Bash(make:*)']);
  });

  it('runTask passes the per-run list, and a job with no repo has no clone', () => {
    expect(source).toContain('const tools = toolsForRun(ALLOWED_TOOLS, { cwd, clonePath });');
    expect(source).toContain("'--allowedTools', tools.join(',')");
    expect(source).not.toContain("'--allowedTools', ALLOWED_TOOLS.join(',')");
    expect(source).toContain('if (!rawRepo) return { cwd: process.cwd(), clonePath: null };');
    expect(source).toContain('return { cwd: repoPath, clonePath: repoPath };');
    expect(source).toContain('await runTask(config, job.id, cwd, prompt, note, clonePath)');
  });

  it('writes under .git/ stay denied whatever the allowlist', () => {
    expect(source).toContain("'--disallowedTools', DISALLOWED_TOOLS.join(',')");
  });
});

describe('LOCAL_ALLOWED_REPO_HOSTS — the worker and the middleware give one answer', () => {
  const INPUTS = [
    'acme/api', 'https://github.com/acme/api', 'git@github.com:acme/api.git',
    'https://gitlab.com/acme/api.git', 'git@gitlab.com:acme/api', 'https://github.example.com/acme/api',
    'https://evil.example/acme/api', 'https://gitlab.com.evil.example/acme/api', 'https://gitlab.com/acme/api/extra',
    'https://gitlab.com/../etc', 'https://gitlab.com/-x/api', 'http://gitlab.com/acme/api', 'https://bad.example/x/acme/api',
  ];
  it.each([
    ['unset', ''],
    ['GitLab and a GitHub Enterprise host, plus junk that is ignored', ' GitLab.com,github.example.com, https://bad.example/x ,a b,'],
  ])('%s', (_label, raw) => {
    const env = { LOCAL_ALLOWED_REPO_HOSTS: raw };
    const worker = policy<{ hosts: string[]; out: (string | null)[] }>(
      `(() => { const h = p.allowedRepoHosts(process.env.LOCAL_ALLOWED_REPO_HOSTS); return { hosts: h.hosts, out: ${JSON.stringify(INPUTS)}.map((r) => p.normaliseRepoUrl(r, h.hosts)) }; })()`, env);
    const hosts = allowedRepoHosts(raw);
    expect(worker.hosts).toEqual(hosts);
    expect(worker.out).toEqual(INPUTS.map((r) => normaliseRepo(r, hosts)));
    expect(hosts[0]).toBe('github.com');
    if (raw) {
      expect(hosts).toEqual(['github.com', 'gitlab.com', 'github.example.com']);
      expect(normaliseRepo('https://gitlab.com/acme/api.git', hosts)).toBe('https://gitlab.com/acme/api.git');
    } else {
      expect(normaliseRepo('https://gitlab.com/acme/api.git', hosts)).toBeNull();
    }
    expect(normaliseRepo('https://evil.example/acme/api', hosts)).toBeNull();
  });
});
